import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import crypto from 'crypto';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import { DatabaseService } from '../../db/database.service';
import {
  DEFAULT_WHATSAPP_INSURANCE_TEMPLATE,
  DEFAULT_WHATSAPP_PUC_TEMPLATE,
  normalizeIndianPhone,
  normalizeVehicleReg,
  toBool,
  type TenantRow,
} from '../../common/types';
import { addDaysToDateStr, deriveCertificateStatus, getIstDateString } from '../../common/ist-date.util';
import { TenantAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { ReminderEngineService } from '../reminders/reminder-engine.service';
import { AuditService } from '../audit/audit.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

const insuranceInputSchema = z.object({
  hasInsurance: z.boolean().default(false),
  policyNumber: z.string().optional().nullable(),
  insuranceCompany: z.string().optional().nullable(),
  policyType: z.string().optional().default('Comprehensive'),
  startDate: z.string().optional().nullable(),
  expiryDate: z.string().optional().nullable(),
  premiumAmount: z.number().optional().nullable(),
});

const customerPayloadSchema = z.object({
  fullName: z.string().min(2, 'Customer name is required').max(120),
  mobileNumber: z.string().min(10, 'Valid mobile number required').max(18),
  alternateMobile: z.string().max(18).optional().nullable(),
  vehicleRegistrationNumber: z.string().max(25).optional(),
  registrationNumber: z.string().max(25).optional(),
  vehicleType: z.string().default('4W'),
  fuelType: z.string().default('Petrol'),
  makeModel: z.string().max(100).optional().nullable(),
  certificateNumber: z.string().max(60).optional().nullable(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Issue date must be YYYY-MM-DD'),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD'),
  address: z.string().max(300).optional().nullable(),
  notes: z.string().max(600).optional().nullable(),
  language: z.enum(['gu', 'hi', 'en']).default('gu'),
  status: z.enum(['active', 'inactive', 'opted_out']).default('active'),
  consentGiven: z.boolean().optional().default(true),
  dndRegistered: z.boolean().optional().default(false),
  remindersEnabled: z.boolean().optional().default(true),
  insurance: insuranceInputSchema.optional().nullable(),
});

const renewSchema = z.object({
  certificateNumber: z.string().max(60).optional().nullable(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(500).optional(),
});

interface CustomerListRow {
  id: string;
  full_name: string;
  mobile_number: string;
  alternate_mobile: string | null;
  address: string | null;
  notes: string | null;
  language: string;
  status: string;
  consent_given: number | boolean;
  dnd_registered: number | boolean;
  reminders_enabled: number | boolean;
  created_at: string;
  vehicle_id: string | null;
  registration_number: string | null;
  vehicle_type: string | null;
  fuel_type: string | null;
  certificate_id: string | null;
  certificate_number: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  cycle_status: string | null;
  insurance_id?: string | null;
  policy_number?: string | null;
  insurance_company?: string | null;
  insurance_policy_type?: string | null;
  insurance_start_date?: string | null;
  insurance_expiry_date?: string | null;
  insurance_premium?: number | null;
}

@Controller('api/customers')
@UseGuards(TenantAuthGuard)
export class CustomersController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ReminderEngineService) private readonly reminderEngine: ReminderEngineService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(WhatsAppService) private readonly whatsappService: WhatsAppService,
  ) {}

  private formatCustomerRow(r: CustomerListRow, todayIst: string) {
    const derived = r.expiry_date
      ? deriveCertificateStatus(r.expiry_date, r.cycle_status || 'active', 7, todayIst)
      : { status: 'active' as const, daysUntilExpiry: 0 };

    let insuranceObj = null;
    if (r.insurance_id || r.policy_number) {
      let insStatus: 'active' | 'expiring_soon' | 'expired' = 'active';
      let insDaysLeft: number | null = null;
      if (r.insurance_expiry_date) {
        const msPerDay = 86400000;
        const diffMs = new Date(r.insurance_expiry_date).getTime() - new Date(todayIst).getTime();
        insDaysLeft = Math.round(diffMs / msPerDay);
        if (insDaysLeft < 0) insStatus = 'expired';
        else if (insDaysLeft <= 15) insStatus = 'expiring_soon';
      }
      insuranceObj = {
        id: r.insurance_id,
        policyNumber: r.policy_number,
        insuranceCompany: r.insurance_company,
        policyType: r.insurance_policy_type || 'Comprehensive',
        startDate: r.insurance_start_date,
        expiryDate: r.insurance_expiry_date,
        premiumAmount: r.insurance_premium,
        daysUntilExpiry: insDaysLeft,
        status: insStatus,
      };
    }

    return {
      id: r.id,
      fullName: r.full_name,
      mobileNumber: r.mobile_number,
      alternateMobile: r.alternate_mobile,
      address: r.address,
      notes: r.notes,
      language: r.language,
      status: r.status,
      consentGiven: toBool(r.consent_given),
      dndRegistered: toBool(r.dnd_registered),
      remindersEnabled: toBool(r.reminders_enabled),
      createdAt: r.created_at,
      vehicleId: r.vehicle_id,
      vehicleRegistrationNumber: r.registration_number || '',
      vehicleType: r.vehicle_type || '4W',
      fuelType: r.fuel_type || 'Petrol',
      certificateId: r.certificate_id,
      certificateNumber: r.certificate_number,
      issueDate: r.issue_date || '',
      expiryDate: r.expiry_date || '',
      certificateStatus: derived.status,
      daysUntilExpiry: derived.daysUntilExpiry,
      vehicle: r.vehicle_id
        ? {
            id: r.vehicle_id,
            registrationNumber: r.registration_number || '',
            vehicleType: r.vehicle_type || '4-Wheeler',
            fuelType: r.fuel_type || 'Petrol',
          }
        : null,
      certificate: r.certificate_id
        ? {
            id: r.certificate_id,
            certificateNumber: r.certificate_number || null,
            issueDate: r.issue_date || '',
            expiryDate: r.expiry_date || '',
            status: derived.status,
            daysUntilExpiry: derived.daysUntilExpiry,
          }
        : null,
      insurance: insuranceObj,
    };
  }

  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('search') search?: string,
    @Query('expiryFilter') expiryFilter?: string,
    @Query('vehicleType') vehicleType?: string,
    @Query('status') status?: string,
    @Query('page') pageStr?: string,
    @Query('pageSize') pageSizeStr?: string,
    @Query('limit') limitStr?: string,
  ) {
    const tenantId = req.auth!.tenantId;
    const todayIst = getIstDateString();
    const in7Days = addDaysToDateStr(todayIst, 7);
    const page = Math.max(1, Number(pageStr) || 1);
    const pageSize = Math.min(500, Math.max(5, Number(pageSizeStr || limitStr) || 15));

    const conditions: string[] = ['c.tenant_id = ?', 'c.deleted_at IS NULL'];
    const params: unknown[] = [tenantId];

    if (search && search.trim()) {
      const pattern = `%${search.trim().toLowerCase()}%`;
      conditions.push(`(LOWER(c.full_name) LIKE ? OR LOWER(c.mobile_number) LIKE ? OR LOWER(COALESCE(v.registration_number, '')) LIKE ? OR LOWER(COALESCE(pc.certificate_number, '')) LIKE ? OR LOWER(COALESCE(vi.policy_number, '')) LIKE ? OR LOWER(COALESCE(vi.insurance_company, '')) LIKE ?)`);
      params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }

    if (vehicleType && vehicleType !== 'all') {
      conditions.push(`v.vehicle_type = ?`);
      params.push(vehicleType);
    }

    if (status && status !== 'all') {
      conditions.push(`c.status = ?`);
      params.push(status);
    }

    if (expiryFilter === 'today') {
      conditions.push(`pc.expiry_date = ?`);
      params.push(todayIst);
    } else if (expiryFilter === 'expiring_7d') {
      conditions.push(`pc.expiry_date >= ? AND pc.expiry_date <= ?`);
      params.push(todayIst, in7Days);
    } else if (expiryFilter === 'expired') {
      conditions.push(`pc.expiry_date < ?`);
      params.push(todayIst);
    } else if (expiryFilter === 'active') {
      conditions.push(`pc.expiry_date >= ?`);
      params.push(todayIst);
    } else if (expiryFilter === 'insurance_expiring') {
      const in15d = addDaysToDateStr(todayIst, 15);
      conditions.push(`vi.expiry_date >= ? AND vi.expiry_date <= ?`);
      params.push(todayIst, in15d);
    } else if (expiryFilter === 'insurance_expired') {
      conditions.push(`vi.expiry_date < ?`);
      params.push(todayIst);
    }

    const whereClause = conditions.join(' AND ');
    const baseFrom = `
      FROM customers c
      LEFT JOIN vehicles v ON v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
      LEFT JOIN puc_certificates pc ON pc.vehicle_id = v.id AND pc.tenant_id = c.tenant_id AND pc.is_current = ? AND pc.deleted_at IS NULL
      LEFT JOIN vehicle_insurances vi ON vi.customer_id = c.id AND vi.vehicle_id = v.id AND vi.deleted_at IS NULL
    `;

    const countRow = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(DISTINCT c.id) as total ${baseFrom} WHERE ${whereClause}`,
      [true, ...params],
    );
    const total = Number(countRow?.total || 0);

    const rows = await this.db.query<CustomerListRow>(
      `SELECT c.id, c.full_name, c.mobile_number, c.alternate_mobile, c.address, c.notes,
              c.language, c.status, c.consent_given, c.dnd_registered, c.reminders_enabled, c.created_at,
              v.id as vehicle_id, v.registration_number, v.vehicle_type, v.fuel_type,
              pc.id as certificate_id, pc.certificate_number, pc.issue_date, pc.expiry_date, pc.cycle_status,
              vi.id as insurance_id, vi.policy_number, vi.insurance_company, vi.policy_type as insurance_policy_type,
              vi.start_date as insurance_start_date, vi.expiry_date as insurance_expiry_date, vi.premium_amount as insurance_premium
       ${baseFrom}
       WHERE ${whereClause}
       ORDER BY COALESCE(pc.expiry_date, '9999-12-31') ASC, c.created_at DESC
       LIMIT ? OFFSET ?`,
      [true, ...params, pageSize, (page - 1) * pageSize],
    );

    return {
      items: rows.map((r) => this.formatCustomerRow(r, todayIst)),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  @Get('export/csv')
  async exportCsv(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const tenantId = req.auth!.tenantId;
    const rows = await this.db.query<CustomerListRow>(
      `SELECT c.id, c.full_name, c.mobile_number, c.alternate_mobile, c.address, c.notes,
              c.language, c.status, c.consent_given, c.dnd_registered, c.reminders_enabled, c.created_at,
              v.id as vehicle_id, v.registration_number, v.vehicle_type, v.fuel_type,
              pc.id as certificate_id, pc.certificate_number, pc.issue_date, pc.expiry_date, pc.cycle_status
       FROM customers c
       LEFT JOIN vehicles v ON v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
       LEFT JOIN puc_certificates pc ON pc.vehicle_id = v.id AND pc.tenant_id = c.tenant_id AND pc.is_current = ? AND pc.deleted_at IS NULL
       WHERE c.tenant_id = ? AND c.deleted_at IS NULL
       ORDER BY pc.expiry_date ASC`,
      [true, tenantId],
    );

    const escapeCsv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = [
      'Customer Name', 'Mobile Number', 'Alternate Mobile', 'Vehicle Number', 'Vehicle Type',
      'Fuel Type', 'Certificate Number', 'Issue Date', 'Expiry Date', 'Language', 'Status', 'Address', 'Notes',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.full_name, r.mobile_number, r.alternate_mobile, r.registration_number, r.vehicle_type,
          r.fuel_type, r.certificate_number, r.issue_date, r.expiry_date, r.language, r.status, r.address, r.notes,
        ].map(escapeCsv).join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pucflow-customers-${getIstDateString()}.csv"`);
    res.send(lines.join('\n'));
  }

  @Get(':id')
  async getDetail(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    const todayIst = getIstDateString();
    const row = await this.db.queryOne<CustomerListRow>(
      `SELECT c.id, c.full_name, c.mobile_number, c.alternate_mobile, c.address, c.notes,
              c.language, c.status, c.consent_given, c.dnd_registered, c.reminders_enabled, c.created_at,
              v.id as vehicle_id, v.registration_number, v.vehicle_type, v.fuel_type,
              pc.id as certificate_id, pc.certificate_number, pc.issue_date, pc.expiry_date, pc.cycle_status,
              vi.id as insurance_id, vi.policy_number, vi.insurance_company, vi.policy_type as insurance_policy_type,
              vi.start_date as insurance_start_date, vi.expiry_date as insurance_expiry_date, vi.premium_amount as insurance_premium
       FROM customers c
       LEFT JOIN vehicles v ON v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
       LEFT JOIN puc_certificates pc ON pc.vehicle_id = v.id AND pc.tenant_id = c.tenant_id AND pc.is_current = ? AND pc.deleted_at IS NULL
       LEFT JOIN vehicle_insurances vi ON vi.customer_id = c.id AND vi.vehicle_id = v.id AND vi.deleted_at IS NULL
       WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL`,
      [true, id, tenantId],
    );

    if (!row) throw new NotFoundException('Customer not found');

    const certificates = await this.db.query(
      `SELECT pc.*, v.registration_number
       FROM puc_certificates pc
       INNER JOIN vehicles v ON v.id = pc.vehicle_id
       WHERE pc.customer_id = ? AND pc.tenant_id = ? AND pc.deleted_at IS NULL
       ORDER BY pc.created_at DESC`,
      [id, tenantId],
    );

    const callLogs = await this.db.query(
      `SELECT cl.*, cc.name as campaign_name
       FROM call_logs cl
       LEFT JOIN calling_campaigns cc ON cc.id = cl.campaign_id
       WHERE cl.customer_id = ? AND cl.tenant_id = ?
       ORDER BY cl.created_at DESC
       LIMIT 30`,
      [id, tenantId],
    );

    const scheduledReminders = await this.db.query(
      `SELECT re.*, rr.label as rule_label, cj.status as job_status, cj.attempt_number, cj.max_attempts
       FROM reminder_events re
       INNER JOIN reminder_rules rr ON rr.id = re.reminder_rule_id
       LEFT JOIN call_jobs cj ON cj.reminder_event_id = re.id
       WHERE re.customer_id = ? AND re.tenant_id = ?
       ORDER BY re.scheduled_for ASC`,
      [id, tenantId],
    );

    const activities = await this.db.query(
      `SELECT * FROM audit_logs
       WHERE tenant_id = ? AND entity_id = ?
       ORDER BY created_at DESC LIMIT 20`,
      [tenantId, id],
    );

    return {
      customer: this.formatCustomerRow(row, todayIst),
      certificates,
      callLogs,
      scheduledReminders,
      activities,
    };
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = customerPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid customer data');
    }
    const data = parsed.data;
    if (data.expiryDate < data.issueDate) {
      throw new BadRequestException('PUC expiry date cannot be earlier than issue date');
    }

    const tenantId = req.auth!.tenantId;
    const phone = normalizeIndianPhone(data.mobileNumber);
    const altPhone = data.alternateMobile ? normalizeIndianPhone(data.alternateMobile) : null;
    const regRaw = (data.registrationNumber || data.vehicleRegistrationNumber || '').trim();
    if (!regRaw || regRaw.length < 3) {
      throw new BadRequestException('Vehicle registration number is required');
    }
    const regNo = normalizeVehicleReg(regRaw);

    // Tenant-scoped duplicate prevention: number plate must be unique within one PUC centre; mobile numbers may be shared
    const compactReg = regNo.replace(/[^A-Z0-9]/g, '');
    const dupVehicle = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM vehicles
       WHERE tenant_id = ?
         AND REPLACE(REPLACE(UPPER(registration_number), ' ', ''), '-', '') = ?
         AND deleted_at IS NULL`,
      [tenantId, compactReg],
    );
    if (dupVehicle) {
      throw new BadRequestException(`Vehicle ${regNo} already exists in your PUC centre.`);
    }

    const nowIso = new Date().toISOString();
    const customerId = crypto.randomUUID();
    const vehicleId = crypto.randomUUID();
    const certId = crypto.randomUUID();

    await this.db.execute(
      `INSERT INTO customers (id, tenant_id, full_name, mobile_number, alternate_mobile, address, notes, language, status, consent_given, dnd_registered, reminders_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId, tenantId, data.fullName.trim(), phone, altPhone,
        data.address?.trim() || null, data.notes?.trim() || null,
        data.language, data.status, data.consentGiven, data.dndRegistered, data.remindersEnabled,
        nowIso, nowIso,
      ],
    );

    await this.db.execute(
      `INSERT INTO vehicles (id, tenant_id, customer_id, registration_number, vehicle_type, fuel_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [vehicleId, tenantId, customerId, regNo, data.vehicleType, data.fuelType, nowIso, nowIso],
    );

    await this.db.execute(
      `INSERT INTO puc_certificates (id, tenant_id, customer_id, vehicle_id, certificate_number, issue_date, expiry_date, cycle_status, is_current, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [certId, tenantId, customerId, vehicleId, data.certificateNumber?.trim() || null, data.issueDate, data.expiryDate, true, nowIso, nowIso],
    );

    let insuranceId: string | null = null;
    if (data.insurance?.hasInsurance) {
      if (!data.insurance.policyNumber?.trim()) {
        throw new BadRequestException('Insurance policy number is compulsory when insurance is added');
      }
      if (!data.insurance.insuranceCompany?.trim()) {
        throw new BadRequestException('Insurance company name is compulsory when insurance is added');
      }
      if (!data.insurance.startDate?.trim()) {
        throw new BadRequestException('Insurance policy start date is compulsory when insurance is added');
      }
      if (!data.insurance.expiryDate?.trim()) {
        throw new BadRequestException('Insurance policy expiry date is compulsory when insurance is added');
      }

      insuranceId = crypto.randomUUID();
      await this.db.execute(
        `INSERT INTO vehicle_insurances (id, tenant_id, customer_id, vehicle_id, policy_number, insurance_company, policy_type, start_date, expiry_date, premium_amount, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          insuranceId,
          tenantId,
          customerId,
          vehicleId,
          data.insurance.policyNumber.trim(),
          data.insurance.insuranceCompany.trim(),
          data.insurance.policyType || 'Comprehensive',
          data.insurance.startDate.trim(),
          data.insurance.expiryDate.trim(),
          data.insurance.premiumAmount || null,
          nowIso,
          nowIso,
        ],
      );
    }

    const schedule = await this.reminderEngine.generateScheduleForCertificate(tenantId, customerId, certId, data.expiryDate);

    // Check owner communication settings for automatic call placement upon registration
    const tenant = await this.db.queryOne<TenantRow>(
      `SELECT * FROM tenants WHERE id = ?`,
      [tenantId],
    );

    const callsEnabled = toBool(tenant?.calls_enabled ?? false);
    const autoCallOnReg = toBool(tenant?.auto_call_on_registration ?? false);

    let autoCallPlaced = false;
    let autoCallStatus: string | null = null;
    let autoCallProvider: string | null = null;
    let autoCallError: string | null = null;

    if (callsEnabled && autoCallOnReg) {
      try {
        const callRes = await this.reminderEngine.triggerManualCall(
          tenantId,
          req.auth!.userId,
          customerId,
          certId,
        );
        autoCallPlaced = true;
        autoCallStatus = callRes.status;
        autoCallProvider = callRes.providerName;
        console.log(`[AutoCall] Automatic call placed to registered customer ${data.fullName} (+91 ${phone}): ${callRes.status} via ${callRes.providerName}`);
      } catch (callErr) {
        autoCallError = callErr instanceof Error ? callErr.message : String(callErr);
        console.warn(`[AutoCall] Automatic call on registration could not be dispatched:`, autoCallError);
      }
    }

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'customer.created',
      entityType: 'customer',
      entityId: customerId,
      metadata: {
        fullName: data.fullName,
        vehicle: regNo,
        expiryDate: data.expiryDate,
        scheduledJobs: schedule.createdJobs,
        autoCallPlaced,
        autoCallStatus,
      },
    });

    return {
      id: customerId,
      vehicleId,
      certificateId: certId,
      insuranceId,
      scheduledJobs: schedule.createdJobs,
      autoCallPlaced,
      autoCallStatus,
      autoCallProvider,
      autoCallError,
    };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = customerPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid customer data');
    }
    const data = parsed.data;
    if (data.expiryDate < data.issueDate) {
      throw new BadRequestException('PUC expiry date cannot be earlier than issue date');
    }

    const tenantId = req.auth!.tenantId;
    const existing = await this.db.queryOne<{
      id: string;
      vehicle_id: string | null;
      certificate_id: string | null;
      expiry_date: string | null;
    }>(
      `SELECT c.id, v.id as vehicle_id, pc.id as certificate_id, pc.expiry_date
       FROM customers c
       LEFT JOIN vehicles v ON v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
       LEFT JOIN puc_certificates pc ON pc.vehicle_id = v.id AND pc.tenant_id = c.tenant_id AND pc.is_current = ? AND pc.deleted_at IS NULL
       WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL`,
      [true, id, tenantId],
    );
    if (!existing) throw new NotFoundException('Customer not found');

    const phone = normalizeIndianPhone(data.mobileNumber);
    const altPhone = data.alternateMobile ? normalizeIndianPhone(data.alternateMobile) : null;
    const regRaw = (data.registrationNumber || data.vehicleRegistrationNumber || '').trim();
    if (!regRaw || regRaw.length < 3) {
      throw new BadRequestException('Vehicle registration number is required');
    }
    const regNo = normalizeVehicleReg(regRaw);

    const compactReg = regNo.replace(/[^A-Z0-9]/g, '');
    const dupVehicle = existing.vehicle_id
      ? await this.db.queryOne<{ id: string }>(
          `SELECT id FROM vehicles
           WHERE tenant_id = ?
             AND REPLACE(REPLACE(UPPER(registration_number), ' ', ''), '-', '') = ?
             AND id != ?
             AND deleted_at IS NULL`,
          [tenantId, compactReg, existing.vehicle_id],
        )
      : await this.db.queryOne<{ id: string }>(
          `SELECT id FROM vehicles
           WHERE tenant_id = ?
             AND REPLACE(REPLACE(UPPER(registration_number), ' ', ''), '-', '') = ?
             AND deleted_at IS NULL`,
          [tenantId, compactReg],
        );
    if (dupVehicle) {
      throw new BadRequestException(`Vehicle ${regNo} already exists in your PUC centre.`);
    }

    const nowIso = new Date().toISOString();
    await this.db.execute(
      `UPDATE customers
       SET full_name = ?, mobile_number = ?, alternate_mobile = ?, address = ?, notes = ?,
           language = ?, status = ?, consent_given = ?, dnd_registered = ?, reminders_enabled = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        data.fullName.trim(), phone, altPhone, data.address?.trim() || null, data.notes?.trim() || null,
        data.language, data.status, data.consentGiven, data.dndRegistered, data.remindersEnabled, nowIso,
        id, tenantId,
      ],
    );

    let vehicleId = existing.vehicle_id;
    if (vehicleId) {
      await this.db.execute(
        `UPDATE vehicles SET registration_number = ?, vehicle_type = ?, fuel_type = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [regNo, data.vehicleType, data.fuelType, nowIso, vehicleId, tenantId],
      );
    } else {
      vehicleId = crypto.randomUUID();
      await this.db.execute(
        `INSERT INTO vehicles (id, tenant_id, customer_id, registration_number, vehicle_type, fuel_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [vehicleId, tenantId, id, regNo, data.vehicleType, data.fuelType, nowIso, nowIso],
      );
    }

    let rescheduled = false;
    if (existing.certificate_id) {
      await this.db.execute(
        `UPDATE puc_certificates SET certificate_number = ?, issue_date = ?, expiry_date = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [data.certificateNumber?.trim() || null, data.issueDate, data.expiryDate, nowIso, existing.certificate_id, tenantId],
      );
      // Business rule #13: Cancel stale scheduled jobs when certificate expiry dates change!
      if (existing.expiry_date && existing.expiry_date !== data.expiryDate) {
        await this.reminderEngine.rescheduleOnExpiryChange(tenantId, id, existing.certificate_id, data.expiryDate);
        rescheduled = true;
      }
    } else {
      const certId = crypto.randomUUID();
      await this.db.execute(
        `INSERT INTO puc_certificates (id, tenant_id, customer_id, vehicle_id, certificate_number, issue_date, expiry_date, cycle_status, is_current, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [certId, tenantId, id, vehicleId, data.certificateNumber?.trim() || null, data.issueDate, data.expiryDate, true, nowIso, nowIso],
      );
      await this.reminderEngine.generateScheduleForCertificate(tenantId, id, certId, data.expiryDate);
      rescheduled = true;
    }

    if (data.insurance !== undefined) {
      const existingIns = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM vehicle_insurances WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL`,
        [id, tenantId],
      );
      if (data.insurance?.hasInsurance) {
        if (!data.insurance.policyNumber?.trim()) throw new BadRequestException('Insurance policy number is compulsory');
        if (!data.insurance.insuranceCompany?.trim()) throw new BadRequestException('Insurance company is compulsory');
        if (!data.insurance.startDate?.trim()) throw new BadRequestException('Insurance start date is compulsory');
        if (!data.insurance.expiryDate?.trim()) throw new BadRequestException('Insurance expiry date is compulsory');

        if (existingIns) {
          await this.db.execute(
            `UPDATE vehicle_insurances
             SET policy_number = ?, insurance_company = ?, policy_type = ?, start_date = ?, expiry_date = ?, premium_amount = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`,
            [
              data.insurance.policyNumber.trim(),
              data.insurance.insuranceCompany.trim(),
              data.insurance.policyType || 'Comprehensive',
              data.insurance.startDate.trim(),
              data.insurance.expiryDate.trim(),
              data.insurance.premiumAmount || null,
              nowIso,
              existingIns.id,
              tenantId,
            ],
          );
        } else if (vehicleId) {
          await this.db.execute(
            `INSERT INTO vehicle_insurances (id, tenant_id, customer_id, vehicle_id, policy_number, insurance_company, policy_type, start_date, expiry_date, premium_amount, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            [
              crypto.randomUUID(),
              tenantId,
              id,
              vehicleId,
              data.insurance.policyNumber.trim(),
              data.insurance.insuranceCompany.trim(),
              data.insurance.policyType || 'Comprehensive',
              data.insurance.startDate.trim(),
              data.insurance.expiryDate.trim(),
              data.insurance.premiumAmount || null,
              nowIso,
              nowIso,
            ],
          );
        }
      } else if (existingIns && data.insurance && !data.insurance.hasInsurance) {
        await this.db.execute(
          `UPDATE vehicle_insurances SET deleted_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
          [nowIso, nowIso, existingIns.id, tenantId],
        );
      }
    }

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'customer.updated',
      entityType: 'customer',
      entityId: id,
      metadata: { vehicle: regNo, expiryDate: data.expiryDate, rescheduled },
    });

    return { ok: true, rescheduled };
  }

  @Post(':id/whatsapp')
  async generateWhatsAppMessage(
    @Param('id') id: string,
    @Body() body: { reminderType?: 'puc' | 'insurance'; type?: 'puc' | 'insurance' },
    @Req() req: AuthenticatedRequest,
  ) {
    const tenantId = req.auth!.tenantId;
    const type = body?.type || body?.reminderType || 'puc';
    const tenant = await this.db.queryOne<TenantRow>(`SELECT * FROM tenants WHERE id = ?`, [tenantId]);
    const customer = await this.db.queryOne<{ id: string; full_name: string; mobile_number: string }>(
      `SELECT id, full_name, mobile_number FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [id, tenantId],
    );
    if (!customer) throw new NotFoundException('Customer not found');

    const vehicle = await this.db.queryOne<{ id: string; registration_number: string }>(
      `SELECT id, registration_number FROM vehicles WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, tenantId],
    );
    const cert = await this.db.queryOne<{ expiry_date: string }>(
      `SELECT expiry_date FROM puc_certificates WHERE customer_id = ? AND tenant_id = ? AND is_current = ? AND deleted_at IS NULL LIMIT 1`,
      [id, tenantId, true],
    );
    const insurance = await this.db.queryOne<{ policy_number: string; insurance_company: string; expiry_date: string }>(
      `SELECT policy_number, insurance_company, expiry_date FROM vehicle_insurances WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, tenantId],
    );

    const formatTemplateDate = (dateStr?: string | null) => {
      if (!dateStr) return 'Soon';
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
      return match ? `${match[3]}/${match[2]}/${match[1]}` : dateStr;
    };

    const template = type === 'insurance' ? DEFAULT_WHATSAPP_INSURANCE_TEMPLATE : DEFAULT_WHATSAPP_PUC_TEMPLATE;
    const regNo = vehicle?.registration_number || 'Vehicle';
    const rawExpiry = type === 'insurance' ? insurance?.expiry_date : cert?.expiry_date;
    const expiry = formatTemplateDate(rawExpiry);

    const rendered = template
      .replace(/\{customer_name\}/g, customer.full_name)
      .replace(/\{vehicle_number\}/g, regNo)
      .replace(/\{expiry_date\}/g, expiry)
      .replace(/\{puc_expiry_date\}/g, formatTemplateDate(cert?.expiry_date || rawExpiry))
      .replace(/\{insurance_expiry_date\}/g, formatTemplateDate(insurance?.expiry_date || rawExpiry))
      .replace(/\{policy_number\}/g, insurance?.policy_number || 'N/A')
      .replace(/\{insurance_company\}/g, insurance?.insurance_company || 'Insurance Company')
      .replace(/\{centre_name\}/g, tenant?.business_name || 'PUC Testing Centre')
      .replace(/\{owner_name\}/g, tenant?.owner_name || 'Centre Owner')
      .replace(/\{centre_address\}/g, tenant?.address || 'Station Road')
      .replace(/\{contact_number\}/g, tenant?.mobile_number || '');

    const digits = customer.mobile_number.replace(/\D/g, '');
    const cleanPhone = digits.length === 10 ? `91${digits}` : digits;
    const whatsappUrl = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(rendered)}`;

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: `whatsapp_reminder.${type}`,
      entityType: 'customer',
      entityId: id,
      metadata: { type, phone: cleanPhone, vehicle: regNo },
    });

    return {
      customerName: customer.full_name,
      phoneNumber: customer.mobile_number,
      messageText: rendered,
      whatsappUrl,
      reminderType: type,
      templateName:
        type === 'puc'
          ? process.env.WHATSAPP_TEMPLATE_NAME?.trim() || 'puc_certificate_utility'
          : process.env.WHATSAPP_INSURANCE_TEMPLATE_NAME?.trim() || 'vehicle_insurance',
    };
  }

  /**
   * Direct 1-Click Send via Meta WhatsApp Cloud API using "puc_certificate_utility" or "vehicle_insurance"
   */
  @Post(':id/send-whatsapp')
  async sendDirectWhatsApp(
    @Param('id') id: string,
    @Body() body: { reminderType?: 'puc' | 'insurance' },
    @Req() req: AuthenticatedRequest,
  ) {
    const tenantId = req.auth!.tenantId;
    const type = body?.reminderType || 'puc';
    const tenant = await this.db.queryOne<TenantRow>(`SELECT * FROM tenants WHERE id = ?`, [tenantId]);
    const customer = await this.db.queryOne<{ id: string; full_name: string; mobile_number: string }>(
      `SELECT id, full_name, mobile_number FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [id, tenantId],
    );
    if (!customer) throw new NotFoundException('Customer not found');

    const vehicle = await this.db.queryOne<{ id: string; registration_number: string }>(
      `SELECT id, registration_number FROM vehicles WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, tenantId],
    );
    const cert = await this.db.queryOne<{ expiry_date: string }>(
      `SELECT expiry_date FROM puc_certificates WHERE customer_id = ? AND tenant_id = ? AND is_current = ? AND deleted_at IS NULL LIMIT 1`,
      [id, tenantId, true],
    );
    const insurance = await this.db.queryOne<{
      policy_number: string;
      insurance_company: string;
      expiry_date: string;
    }>(
      `SELECT policy_number, insurance_company, expiry_date FROM vehicle_insurances WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, tenantId],
    );

    const formatDdMmYyyy = (dateStr?: string | null) => {
      if (!dateStr) return 'Soon';
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
      return match ? `${match[3]}/${match[2]}/${match[1]}` : dateStr;
    };

    const regNo = vehicle?.registration_number || 'Vehicle';

    const nowIso = new Date().toISOString();
    const todayIst = getIstDateString();
    let sendRes: { messageId: string; template: string };
    try {
      if (type === 'insurance') {
        if (!insurance) {
          throw new BadRequestException('No vehicle insurance policy found for this customer');
        }
        sendRes = await this.whatsappService.sendInsuranceReminder({
          to: customer.mobile_number,
          customerName: customer.full_name,
          vehiclePlate: regNo,
          expiryDate: formatDdMmYyyy(insurance.expiry_date),
          policyNumber: insurance.policy_number || 'N/A',
          insurerName: insurance.insurance_company || 'Insurance Company',
          centreName: tenant?.business_name || 'PUC Testing Centre',
          ownerName: tenant?.owner_name || 'Centre Owner',
          contactNumber: tenant?.mobile_number || 'Helpline',
        });
      } else {
        sendRes = await this.whatsappService.sendPucCertificateReminder({
          to: customer.mobile_number,
          customerName: customer.full_name,
          vehiclePlate: regNo,
          expiryDate: formatDdMmYyyy(cert?.expiry_date),
          centreName: tenant?.business_name || 'PUC Testing Centre',
          ownerName: tenant?.owner_name || 'Centre Owner',
          centreAddress: tenant?.address || 'Station Road',
          contactNumber: tenant?.mobile_number || 'Helpline',
        });
      }

      await this.db.execute(
        `INSERT INTO whatsapp_logs (id, tenant_id, customer_id, vehicle_id, entity_type, entity_id, reminder_offset_days, dispatch_date_ist, slot_time, template_name, phone_number, provider_message_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'manual', ?, ?, ?, 'sent', ?)`,
        [
          crypto.randomUUID(),
          tenantId,
          customer.id,
          vehicle?.id || null,
          type,
          cert?.expiry_date || customer.id,
          todayIst,
          sendRes.template,
          customer.mobile_number,
          sendRes.messageId,
          nowIso,
        ],
      );
    } catch (err) {
      if (!(err instanceof BadRequestException)) {
        const errMsg = err instanceof Error ? err.message : 'Failed to send';
        const tplName =
          type === 'insurance'
            ? process.env.WHATSAPP_INSURANCE_TEMPLATE_NAME?.trim() || 'vehicle_insurance'
            : process.env.WHATSAPP_TEMPLATE_NAME?.trim() || 'puc_certificate_utility';
        await this.db.execute(
          `INSERT INTO whatsapp_logs (id, tenant_id, customer_id, vehicle_id, entity_type, entity_id, reminder_offset_days, dispatch_date_ist, slot_time, template_name, phone_number, status, error_message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'manual', ?, ?, 'failed', ?, ?)`,
          [
            crypto.randomUUID(),
            tenantId,
            customer.id,
            vehicle?.id || null,
            type,
            customer.id,
            todayIst,
            tplName,
            customer.mobile_number,
            errMsg.slice(0, 500),
            nowIso,
          ],
        ).catch(() => {});
      }
      throw err;
    }

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'whatsapp_reminder.delivered',
      entityType: 'customer',
      entityId: id,
      metadata: {
        messageId: sendRes.messageId,
        template: sendRes.template,
        reminderType: type,
        phone: customer.mobile_number,
        vehicle: regNo,
      },
    });

    return {
      ok: true,
      messageId: sendRes.messageId,
      template: sendRes.template,
      recipient: customer.mobile_number,
      customerName: customer.full_name,
    };
  }

  @Patch(':id/reminders')
  async toggleReminders(
    @Param('id') id: string,
    @Body() body: { remindersEnabled?: boolean; consentGiven?: boolean; dndRegistered?: boolean; status?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const tenantId = req.auth!.tenantId;
    const customer = await this.db.queryOne<{
      id: string;
      reminders_enabled: number | boolean;
      consent_given: number | boolean;
      dnd_registered: number | boolean;
      status: string;
    }>(`SELECT * FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`, [id, tenantId]);
    if (!customer) throw new NotFoundException('Customer not found');

    const remindersEnabled = body.remindersEnabled ?? toBool(customer.reminders_enabled);
    const consentGiven = body.consentGiven ?? toBool(customer.consent_given);
    const dndRegistered = body.dndRegistered ?? toBool(customer.dnd_registered);
    const status = body.status ?? customer.status;

    await this.db.execute(
      `UPDATE customers SET reminders_enabled = ?, consent_given = ?, dnd_registered = ?, status = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [remindersEnabled, consentGiven, dndRegistered, status, new Date().toISOString(), id, tenantId],
    );

    if (status === 'opted_out' || !consentGiven || dndRegistered) {
      const certs = await this.db.query<{ id: string }>(
        `SELECT id FROM puc_certificates WHERE customer_id = ? AND tenant_id = ? AND is_current = ?`,
        [id, tenantId, true],
      );
      for (const c of certs) {
        await this.reminderEngine.cancelPendingForCertificate(tenantId, c.id, 'Customer opted out / DND enabled');
      }
    }

    return { ok: true };
  }

  /**
   * Renew PUC Certificate:
   * 1. Marks old active cycle as 'renewed' (preserving historical call logs).
   * 2. Cancels ALL pending reminders & scheduled jobs for the old cycle.
   * 3. Creates a new current certificate cycle.
   * 4. Generates a fresh reminder schedule for the new expiry cycle.
   */
  @Post(':id/renew')
  async renewCertificate(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = renewSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid renewal dates');
    }
    const data = parsed.data;
    if (data.expiryDate <= data.issueDate) {
      throw new BadRequestException('New expiry date must be after issue date');
    }

    const tenantId = req.auth!.tenantId;
    const vehicle = await this.db.queryOne<{ id: string; registration_number: string }>(
      `SELECT id, registration_number FROM vehicles WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, tenantId],
    );
    if (!vehicle) throw new NotFoundException('Customer vehicle not found');

    const oldCerts = await this.db.query<{ id: string }>(
      `SELECT id FROM puc_certificates WHERE customer_id = ? AND tenant_id = ? AND is_current = ? AND deleted_at IS NULL`,
      [id, tenantId, true],
    );

    const nowIso = new Date().toISOString();
    let totalCancelledJobs = 0;

    for (const old of oldCerts) {
      await this.db.execute(
        `UPDATE puc_certificates SET cycle_status = 'renewed', is_current = ?, renewed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [false, nowIso, nowIso, old.id, tenantId],
      );
      const cancelled = await this.reminderEngine.cancelPendingForCertificate(
        tenantId,
        old.id,
        'PUC certificate renewed early',
      );
      totalCancelledJobs += cancelled.cancelledJobs;
    }

    const newCertId = crypto.randomUUID();
    await this.db.execute(
      `INSERT INTO puc_certificates (id, tenant_id, customer_id, vehicle_id, certificate_number, issue_date, expiry_date, cycle_status, is_current, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [newCertId, tenantId, id, vehicle.id, data.certificateNumber?.trim() || null, data.issueDate, data.expiryDate, true, nowIso, nowIso],
    );

    const generated = await this.reminderEngine.generateScheduleForCertificate(tenantId, id, newCertId, data.expiryDate);

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'certificate.renewed',
      entityType: 'customer',
      entityId: id,
      metadata: {
        vehicle: vehicle.registration_number,
        newExpiryDate: data.expiryDate,
        cancelledOldJobs: totalCancelledJobs,
        scheduledNewJobs: generated.createdJobs,
      },
    });

    return {
      ok: true,
      newCertificateId: newCertId,
      cancelledOldJobs: totalCancelledJobs,
      scheduledNewJobs: generated.createdJobs,
    };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    const nowIso = new Date().toISOString();

    const certs = await this.db.query<{ id: string }>(
      `SELECT id FROM puc_certificates WHERE customer_id = ? AND tenant_id = ?`,
      [id, tenantId],
    );
    for (const c of certs) {
      await this.reminderEngine.cancelPendingForCertificate(tenantId, c.id, 'Customer deleted');
    }

    await this.db.execute(`UPDATE customers SET deleted_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`, [
      nowIso, nowIso, id, tenantId,
    ]);
    await this.db.execute(`UPDATE vehicles SET deleted_at = ?, updated_at = ? WHERE customer_id = ? AND tenant_id = ?`, [
      nowIso, nowIso, id, tenantId,
    ]);
    await this.db.execute(`UPDATE puc_certificates SET deleted_at = ?, updated_at = ? WHERE customer_id = ? AND tenant_id = ?`, [
      nowIso, nowIso, id, tenantId,
    ]);

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'customer.deleted',
      entityType: 'customer',
      entityId: id,
    });
    return { ok: true };
  }

  @Post('bulk-action')
  async bulkAction(
    @Body() body: { ids?: string[]; action?: 'enable_reminders' | 'disable_reminders' | 'delete' },
    @Req() req: AuthenticatedRequest,
  ) {
    const tenantId = req.auth!.tenantId;
    const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 200) : [];
    if (ids.length === 0) throw new BadRequestException('Select at least one customer');

    const nowIso = new Date().toISOString();
    let affected = 0;

    for (const id of ids) {
      if (body.action === 'enable_reminders' || body.action === 'disable_reminders') {
        const res = await this.db.execute(
          `UPDATE customers SET reminders_enabled = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
          [body.action === 'enable_reminders', nowIso, id, tenantId],
        );
        affected += res.rowCount;
      } else if (body.action === 'delete') {
        const res = await this.db.execute(
          `UPDATE customers SET deleted_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
          [nowIso, nowIso, id, tenantId],
        );
        if (res.rowCount > 0) {
          await this.db.execute(`UPDATE vehicles SET deleted_at = ? WHERE customer_id = ? AND tenant_id = ?`, [nowIso, id, tenantId]);
          await this.db.execute(`UPDATE puc_certificates SET deleted_at = ? WHERE customer_id = ? AND tenant_id = ?`, [nowIso, id, tenantId]);
          affected++;
        }
      }
    }

    return { ok: true, affected };
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async importCustomers(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Body() body: { rows?: unknown },
    @Req() req: AuthenticatedRequest,
  ) {
    const tenantId = req.auth!.tenantId;
    let rawRows: Record<string, unknown>[] = [];

    if (file && file.buffer) {
      const workbook = XLSX.read(file.buffer, { type: 'buffer' });
      const firstSheet = workbook.SheetNames[0];
      if (!firstSheet) throw new BadRequestException('Uploaded file has no worksheets');
      rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheet], { defval: '' });
    } else if (body?.rows) {
      rawRows = typeof body.rows === 'string' ? JSON.parse(body.rows) : (body.rows as Record<string, unknown>[]);
    }

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw new BadRequestException('No customer rows found in uploaded file');
    }

    const tenant = await this.db.queryOne<{ auto_schedule_on_import: number | boolean; default_language: string }>(
      `SELECT auto_schedule_on_import, default_language FROM tenants WHERE id = ?`,
      [tenantId],
    );
    const shouldSchedule = tenant ? toBool(tenant.auto_schedule_on_import) : true;
    const defaultLang = tenant?.default_language || 'gu';
    const todayIst = getIstDateString();

    let imported = 0;
    let skipped = 0;
    const errors: { row: number; reason: string }[] = [];

    const pick = (row: Record<string, unknown>, keys: string[]): string => {
      const lowerMap = new Map<string, unknown>();
      for (const [k, v] of Object.entries(row)) {
        lowerMap.set(k.toLowerCase().replace(/[^a-z0-9]/g, ''), v);
      }
      for (const k of keys) {
        const val = lowerMap.get(k);
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          return String(val).trim();
        }
      }
      return '';
    };

    const normalizeDate = (raw: string, fallback: string): string => {
      if (!raw) return fallback;
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      // Handle DD/MM/YYYY or DD-MM-YYYY
      const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
      if (dmy) {
        return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
      }
      // Handle Excel serial dates
      if (/^\d{5}$/.test(raw)) {
        const excelDate = new Date((Number(raw) - 25569) * 86400_000);
        if (!Number.isNaN(excelDate.getTime())) return excelDate.toISOString().slice(0, 10);
      }
      return fallback;
    };

    for (let i = 0; i < Math.min(rawRows.length, 500); i++) {
      const r = rawRows[i];
      const fullName = pick(r, ['customername', 'fullname', 'name']);
      const rawPhone = pick(r, ['mobilenumber', 'mobile', 'phone', 'phonenumber']);
      const rawReg = pick(r, ['vehicleregistrationnumber', 'vehiclenumber', 'vehiclereg', 'registrationnumber', 'regno']);
      const rawVType = pick(r, ['vehicletype', 'type']).toUpperCase();
      const rawFuel = pick(r, ['fueltype', 'fuel']);
      const certNo = pick(r, ['puccertificatenumber', 'certificatenumber', 'pucnumber', 'certno']);
      const rawIssue = pick(r, ['pucissuedate', 'issuedate']);
      const rawExpiry = pick(r, ['pucexpirydate', 'expirydate', 'validtill']);
      const rawLang = pick(r, ['customerlanguage', 'language', 'lang']).toLowerCase();
      const address = pick(r, ['address', 'city']);
      const notes = pick(r, ['notes', 'remarks']);

      if (!fullName || !rawPhone || !rawReg) {
        skipped++;
        errors.push({ row: i + 2, reason: 'Missing required name, mobile number, or vehicle number' });
        continue;
      }

      const phone = normalizeIndianPhone(rawPhone);
      const regNo = normalizeVehicleReg(rawReg);
      const expiryDate = normalizeDate(rawExpiry, addDaysToDateStr(todayIst, 180));
      const issueDate = normalizeDate(rawIssue, addDaysToDateStr(expiryDate, -180));

      const vehicleType = (['2W', '3W', '4W', 'LCV', 'HCV'].includes(rawVType) ? rawVType : '4W') as '2W' | '3W' | '4W' | 'LCV' | 'HCV';
      const fuelType = ['Petrol', 'Diesel', 'CNG', 'LPG', 'Hybrid'].find(
        (f) => f.toLowerCase() === rawFuel.toLowerCase(),
      ) || 'Petrol';
      const language = rawLang.startsWith('hi') ? 'hi' : rawLang.startsWith('en') ? 'en' : rawLang.startsWith('gu') ? 'gu' : defaultLang;

      const dup = await this.db.queryOne<{ id: string }>(
        `SELECT v.id FROM vehicles v WHERE v.tenant_id = ? AND v.registration_number = ? AND v.deleted_at IS NULL
         UNION ALL
         SELECT c.id FROM customers c WHERE c.tenant_id = ? AND c.mobile_number = ? AND c.deleted_at IS NULL
         LIMIT 1`,
        [tenantId, regNo, tenantId, phone],
      );
      if (dup) {
        skipped++;
        errors.push({ row: i + 2, reason: `Duplicate mobile (${phone}) or vehicle (${regNo})` });
        continue;
      }

      const nowIso = new Date().toISOString();
      const customerId = crypto.randomUUID();
      const vehicleId = crypto.randomUUID();
      const certId = crypto.randomUUID();

      await this.db.execute(
        `INSERT INTO customers (id, tenant_id, full_name, mobile_number, address, notes, language, status, consent_given, dnd_registered, reminders_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        [customerId, tenantId, fullName, phone, address || null, notes || null, language, true, false, true, nowIso, nowIso],
      );
      await this.db.execute(
        `INSERT INTO vehicles (id, tenant_id, customer_id, registration_number, vehicle_type, fuel_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [vehicleId, tenantId, customerId, regNo, vehicleType, fuelType, nowIso, nowIso],
      );
      await this.db.execute(
        `INSERT INTO puc_certificates (id, tenant_id, customer_id, vehicle_id, certificate_number, issue_date, expiry_date, cycle_status, is_current, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [certId, tenantId, customerId, vehicleId, certNo || null, issueDate, expiryDate, true, nowIso, nowIso],
      );

      if (shouldSchedule) {
        await this.reminderEngine.generateScheduleForCertificate(tenantId, customerId, certId, expiryDate);
      }
      imported++;
    }

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'customer.imported',
      entityType: 'customer',
      metadata: { imported, skipped, totalRows: rawRows.length },
    });

    return { ok: true, imported, skipped, errors: errors.slice(0, 50) };
  }
}
