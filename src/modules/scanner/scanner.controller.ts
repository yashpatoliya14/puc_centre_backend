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
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { ScannerService, ExtractedPucData } from './scanner.service';
import { DatabaseService } from '../../db/database.service';
import { getIstDateString } from '../../common/ist-date.util';

@Controller(['api/scanner', 'scanner'])
export class ScannerController {
  private readonly logger = new Logger(ScannerController.name);

  constructor(
    private readonly scannerService: ScannerService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * 0. VAHAN / RTO VEHICLE LOOKUP (Single-Field Plate Fetch)
   */
  @Get('lookup-vehicle')
  @UseGuards(TenantAuthGuard)
  async lookupVehicle(
    @Query('regNumber') regNumber: string,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!regNumber || !regNumber.trim()) {
      throw new BadRequestException('regNumber query parameter is required');
    }
    const data = await this.scannerService.lookupVehicle(regNumber.trim(), req.auth?.tenantId);
    return { ok: true, data };
  }

  @Post('lookup-vehicle')
  @UseGuards(TenantAuthGuard)
  async lookupVehiclePost(
    @Body() body: { regNumber?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body?.regNumber || !body.regNumber.trim()) {
      throw new BadRequestException('regNumber is required');
    }
    const data = await this.scannerService.lookupVehicle(body.regNumber.trim(), req.auth?.tenantId);
    return { ok: true, data };
  }

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
   * 2. PARSE PARIVAHAN QR CODE (From Camera or USB Barcode Gun)
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
    const customerId = `cust_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const today = getIstDateString();

    const fullName = extracted.fullName || 'Registered via WhatsApp';
    const mobile = extracted.mobileNumber || senderNumber.slice(-10);

    await this.db.execute(
      `INSERT INTO customers (
        id, tenant_id, full_name, mobile_number, reg_number,
        vehicle_type, fuel_type, make_model, issue_date,
        expiry_date, calls_enabled, auto_call_on_reg, preferred_language, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'gu', ?, ?)
      ON CONFLICT(tenant_id, reg_number) DO UPDATE SET
        expiry_date = excluded.expiry_date,
        issue_date = excluded.issue_date,
        updated_at = excluded.updated_at`,
      [
        customerId,
        tenant.id,
        fullName,
        mobile,
        extracted.regNumber,
        extracted.vehicleType || '4-Wheeler',
        extracted.fuelType || 'Petrol',
        extracted.makeModel || null,
        extracted.issueDate || today,
        extracted.expiryDate || today,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );

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
