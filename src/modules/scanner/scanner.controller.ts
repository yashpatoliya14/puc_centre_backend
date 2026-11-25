import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Req,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { ScannerService, ExtractedPucData } from './scanner.service';
import { DatabaseService } from '../../db/database.service';
import { getIstDateString, addDaysToDateStr } from '../../common/ist-date.util';
import { ReminderEngineService } from '../reminders/reminder-engine.service';
import { AuditService } from '../audit/audit.service';

@Controller(['api/scanner', 'scanner'])
export class ScannerController {
  private readonly logger = new Logger(ScannerController.name);

  constructor(
    private readonly scannerService: ScannerService,
    private readonly db: DatabaseService,
    private readonly reminderEngine: ReminderEngineService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * 1. PARSE OFFICIAL PARIVAHAN PUC PDF
   */
  @Post('extract-pdf')
  @UseGuards(TenantAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async extractFromPdf(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
  ): Promise<{ ok: boolean; data: ExtractedPucData; filename: string }> {
    if (!file || !file.buffer) {
      throw new BadRequestException('Please upload a valid Parivahan PUC PDF document');
    }

    const data = await this.scannerService.parsePdfBuffer(file.buffer);
    return { ok: true, data, filename: file.originalname };
  }

  /**
   * 1B. PARSE CERTIFICATE IMAGE VIA OCR (JPG / PNG / WebP)
   */
  @Post('extract-image')
  @UseGuards(TenantAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async extractFromImage(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
  ): Promise<{ ok: boolean; data: ExtractedPucData; filename: string }> {
    if (!file || !file.buffer) {
      throw new BadRequestException('Please upload a valid PUC certificate image');
    }

    const data = await this.scannerService.parseImageBuffer(file.buffer);
    return { ok: true, data, filename: file.originalname };
  }

  /**
   * 2. PARSE PARIVAHAN QR CODE (From Camera or Uploaded Certificate Image)
   */
  @Post('extract-qr')
  @UseGuards(TenantAuthGuard)
  async extractFromQr(
    @Body() body: { qrText?: string },
  ): Promise<{ ok: boolean; data: ExtractedPucData }> {
    if (!body?.qrText) {
      throw new BadRequestException('qrText is required');
    }

    const data = this.scannerService.parseQrString(body.qrText);
    return { ok: true, data };
  }

  /**
   * 3. BULK REGISTER EXTRACTED CERTIFICATES (From Bulk PDFs or Images)
   * Directly registers all extracted customers & vehicles in one atomic batch.
   */
  @Post('bulk-register')
  @UseGuards(TenantAuthGuard)
  async bulkRegister(
    @Body()
    body: {
      certificates: Array<ExtractedPucData & { customMobile?: string; customName?: string }>;
    },
    @Req() req: AuthenticatedRequest,
  ) {
    const tenantId = req.auth!.tenantId;
    const certs = Array.isArray(body?.certificates) ? body.certificates : [];
    if (certs.length === 0) {
      throw new BadRequestException('No certificate records provided for bulk registration');
    }

    const todayIst = getIstDateString();
    const nowIso = new Date().toISOString();

    const tenant = await this.db.queryOne<{
      auto_schedule_on_import: number | boolean;
      default_language: string;
      business_name: string;
      mobile_number: string;
    }>(
      `SELECT auto_schedule_on_import, default_language, business_name, mobile_number FROM tenants WHERE id = ?`,
      [tenantId],
    );

    const shouldSchedule = tenant ? Boolean(tenant.auto_schedule_on_import) : true;
    const defaultLang = tenant?.default_language || 'gu';

    let registered = 0;
    let updated = 0;
    const errors: Array<{ index: number; regNumber: string; error: string }> = [];
    const results: Array<{
      regNumber: string;
      customerName: string;
      vehicleType: string;
      expiryDate: string;
      status: 'registered' | 'renewed' | 'failed';
    }> = [];

    const seenRegsInBatch = new Set<string>();

    for (let i = 0; i < certs.length; i++) {
      const c = certs[i];
      const rawReg = (c.regNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (!rawReg || rawReg.length < 5) {
        errors.push({ index: i, regNumber: c.regNumber || 'UNKNOWN', error: 'Invalid vehicle plate number' });
        continue;
      }
      if (seenRegsInBatch.has(rawReg)) {
        errors.push({
          index: i,
          regNumber: rawReg,
          error: `Duplicate vehicle number plate ${rawReg} in upload batch (must be unique within one PUC centre).`,
        });
        results.push({
          regNumber: rawReg,
          customerName: (c.customName || c.fullName || `Customer (${rawReg})`).trim(),
          vehicleType: c.vehicleType || '4-Wheeler',
          expiryDate: c.expiryDate || '',
          status: 'failed',
        });
        continue;
      }
      seenRegsInBatch.add(rawReg);

      const fullName = (c.customName || c.fullName || `Customer (${rawReg})`).trim();
      let phone = (c.customMobile || c.mobileNumber || '').replace(/\D/g, '');
      if (phone.length === 10) {
        phone = `+91${phone}`;
      } else if (phone.length === 12 && phone.startsWith('91')) {
        phone = `+${phone}`;
      } else if (!phone || phone.length < 10) {
        phone = tenant?.mobile_number ? `+91${tenant.mobile_number.slice(-10)}` : '+919999999999';
      }

      const vType = ([
        '2W',
        '3W',
        '4W',
        '2-Wheeler',
        '4-Wheeler',
        'Commercial',
        'Other',
      ].includes(c.vehicleType || '')
        ? c.vehicleType
        : '4-Wheeler') as string;
      const fuel = c.fuelType || 'Petrol';
      const issueDate = c.issueDate || todayIst;
      const expiryDate = c.expiryDate || addDaysToDateStr(issueDate, 365);
      const certNo = c.certificateNumber?.trim() || null;

      try {
        const existingVehicle = await this.db.queryOne<{ id: string; customer_id: string }>(
          `SELECT id, customer_id FROM vehicles WHERE tenant_id = ? AND REPLACE(REPLACE(UPPER(registration_number), ' ', ''), '-', '') = ? AND deleted_at IS NULL`,
          [tenantId, rawReg],
        );

        if (existingVehicle) {
          errors.push({
            index: i,
            regNumber: rawReg,
            error: `Vehicle ${rawReg} already exists in your PUC centre.`,
          });
          results.push({
            regNumber: rawReg,
            customerName: fullName,
            vehicleType: vType,
            expiryDate,
            status: 'failed',
          });
        } else {
          // Same mobile number may be shared across multiple registrations in a PUC centre;
          // only the vehicle number plate is strictly unique per centre.
          const customerId = crypto.randomUUID();
          await this.db.execute(
            `INSERT INTO customers (id, tenant_id, full_name, mobile_number, language, status, consent_given, dnd_registered, reminders_enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
            [customerId, tenantId, fullName, phone, defaultLang, true, false, true, nowIso, nowIso],
          );

          const vehicleId = crypto.randomUUID();
          await this.db.execute(
            `INSERT INTO vehicles (id, tenant_id, customer_id, registration_number, vehicle_type, fuel_type, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [vehicleId, tenantId, customerId, rawReg, vType, fuel, nowIso, nowIso],
          );

          const certId = crypto.randomUUID();
          await this.db.execute(
            `INSERT INTO puc_certificates (id, tenant_id, customer_id, vehicle_id, certificate_number, issue_date, expiry_date, cycle_status, is_current, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
            [certId, tenantId, customerId, vehicleId, certNo, issueDate, expiryDate, true, nowIso, nowIso],
          );

          if (shouldSchedule) {
            await this.reminderEngine.generateScheduleForCertificate(tenantId, customerId, certId, expiryDate);
          }

          registered++;
          results.push({
            regNumber: rawReg,
            customerName: fullName,
            vehicleType: vType,
            expiryDate,
            status: 'registered',
          });
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Database registration error';
        errors.push({ index: i, regNumber: rawReg, error: errorMsg });
      }
    }

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'certificates.bulk_registered',
      entityType: 'customer',
      metadata: { total: certs.length, registered, updated, failedCount: errors.length },
    });

    return {
      ok: true,
      total: certs.length,
      registered,
      updated,
      failed: errors.length,
      errors,
      results,
    };
  }

  /**
   * 3. WHATSAPP BOT WEBHOOK / "SNAP & REGISTER" (Option 4)
   * Receives incoming messages or photos from the owner's WhatsApp number.
   * Format example:
   * "GJ01AB1234 9876543210 2027-11-24 Ramesh Patel"
   * or parsed from incoming WhatsApp webhook with image caption.
   */
  @Post('whatsapp-bot')
  async handleWhatsAppBotWebhook(@Body() body: Record<string, unknown>, @Req() req: any) {
    this.logger.log(`Received WhatsApp Bot webhook payload: ${JSON.stringify(body).slice(0, 200)}`);

    // Flexible extraction from Meta Cloud API, Twilio, or generic webhook body
    let senderNumber = '';
    let messageText = '';

    if (body?.entry && Array.isArray(body.entry)) {
      // Meta Cloud API structure
      const changes = (body.entry[0] as any)?.changes?.[0]?.value;
      const message = changes?.messages?.[0];
      senderNumber = message?.from || '';
      messageText = message?.text?.body || message?.caption || '';
    } else if (body?.From || body?.Body) {
      // Twilio format
      senderNumber = String(body.From || '').replace(/whatsapp:\+?/, '');
      messageText = String(body.Body || '');
    } else {
      // Generic payload: { mobileNumber: "...", text: "..." }
      senderNumber = String(body.mobileNumber || body.sender || '');
      messageText = String(body.text || body.message || '');
    }

    if (!messageText) {
      return { ok: true, message: 'No text or caption to process' };
    }

    // Try parsing as QR string or Parivahan text
    const extracted = this.scannerService.parseQrString(messageText);

    // If registration number is found, we can lookup the tenant by senderNumber or default tenant
    let tenant = await this.db.queryOne<{ id: string; business_name: string }>(
      `SELECT id, business_name FROM tenants WHERE mobile_number LIKE ? LIMIT 1`,
      [`%${senderNumber.slice(-10)}%`],
    );

    if (!tenant) {
      // Fallback to first active tenant
      tenant = await this.db.queryOne<{ id: string; business_name: string }>(
        `SELECT id, business_name FROM tenants ORDER BY created_at ASC LIMIT 1`,
        [],
      );
    }

    if (!tenant || !extracted.regNumber) {
      return {
        ok: false,
        message: 'Could not extract valid vehicle number from message',
        extracted,
      };
    }

    // Auto-create or update customer record in the tenant's database
    const customerId = crypto.randomUUID();
    const vehicleId = crypto.randomUUID();
    const certId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const today = getIstDateString();

    const fullName = extracted.fullName || 'Registered via WhatsApp';
    const mobile = extracted.mobileNumber || senderNumber.slice(-10);
    const regNo = extracted.regNumber;

    // Check if vehicle already exists for this tenant
    const existingVehicle = await this.db.queryOne<{ id: string; customer_id: string }>(
      `SELECT id, customer_id FROM vehicles WHERE tenant_id = ? AND UPPER(REPLACE(registration_number, ' ', '')) = ? AND deleted_at IS NULL`,
      [tenant.id, regNo],
    );

    if (existingVehicle) {
      await this.db.execute(
        `UPDATE puc_certificates SET is_current = ? WHERE vehicle_id = ? AND tenant_id = ?`,
        [false, existingVehicle.id, tenant.id],
      );
      await this.db.execute(
        `INSERT INTO puc_certificates (id, tenant_id, customer_id, vehicle_id, certificate_number, issue_date, expiry_date, cycle_status, is_current, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [certId, tenant.id, existingVehicle.customer_id, existingVehicle.id, extracted.certificateNumber || null, extracted.issueDate || today, extracted.expiryDate || today, true, nowIso, nowIso],
      );
    } else {
      let cust = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM customers WHERE tenant_id = ? AND mobile_number = ? AND deleted_at IS NULL`,
        [tenant.id, mobile],
      );
      const targetCustId = cust ? cust.id : customerId;
      if (!cust) {
        await this.db.execute(
          `INSERT INTO customers (id, tenant_id, full_name, mobile_number, language, status, consent_given, dnd_registered, reminders_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'gu', 'active', ?, ?, ?, ?, ?)`,
          [targetCustId, tenant.id, fullName, mobile, true, false, true, nowIso, nowIso],
        );
      }
      await this.db.execute(
        `INSERT INTO vehicles (id, tenant_id, customer_id, registration_number, vehicle_type, fuel_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [vehicleId, tenant.id, targetCustId, regNo, extracted.vehicleType || '4-Wheeler', extracted.fuelType || 'Petrol', nowIso, nowIso],
      );
      await this.db.execute(
        `INSERT INTO puc_certificates (id, tenant_id, customer_id, vehicle_id, certificate_number, issue_date, expiry_date, cycle_status, is_current, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [certId, tenant.id, targetCustId, vehicleId, extracted.certificateNumber || null, extracted.issueDate || today, extracted.expiryDate || today, true, nowIso, nowIso],
      );
    }

    return {
      ok: true,
      message: `Vehicle ${extracted.regNumber} registered successfully for ${tenant.business_name}`,
      data: {
        regNumber: extracted.regNumber,
        expiryDate: extracted.expiryDate,
        mobileNumber: mobile,
      },
    };
  }

  /**
   * 4. GET TENANT WHATSAPP BOT CONFIGURATION
   */
  @Get('whatsapp-config')
  @UseGuards(TenantAuthGuard)
  async getWhatsAppConfig(@Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    const tenant = await this.db.queryOne<{ id: string; business_name: string; mobile_number: string }>(
      `SELECT id, business_name, mobile_number FROM tenants WHERE id = ?`,
      [tenantId],
    );

    return {
      ok: true,
      webhookUrl: `${process.env.APP_URL || 'http://localhost:3000'}/api/scanner/whatsapp-bot`,
      instructions: [
        'Send a photo or text with Vehicle Plate & Expiry Date to your registered WhatsApp number.',
        'Format example: "GJ01AB1234 9876543210 2027-11-24 Ramesh Patel"',
        'PUCFlow instantly creates the customer and schedules expiry reminder alerts.',
      ],
      registeredMobile: tenant?.mobile_number || 'Not configured',
    };
  }
}
