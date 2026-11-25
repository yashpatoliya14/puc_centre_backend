import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import crypto from 'crypto';
import { z } from 'zod';
import { DatabaseService } from '../../db/database.service';
import { deriveCertificateStatus, getIstDateString } from '../../common/ist-date.util';
import {
  hashPassword,
  validateStrongEmailId,
  validateStrongPassword,
} from '../../common/crypto.util';
import { normalizeIndianPhone, toBool } from '../../common/types';
import { AdminRoleGuard, TenantAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuditService } from '../audit/audit.service';

const createAdminSchema = z.object({
  fullName: z.string().min(2, 'Admin full name is required').max(100),
  email: z.string().email('Valid Admin ID (email) is required'),
  mobileNumber: z.string().min(10, 'Valid 10-digit mobile number is required').max(18),
  password: z.string().min(10, 'Password must be at least 10 characters').max(100),
});

interface OwnerSummaryRow {
  id: string;
  business_name: string;
  owner_name: string;
  email: string;
  mobile_number: string;
  address: string | null;
  is_blocked: number | boolean | null;
  blocked_at: string | null;
  created_at: string;
  last_login_at: string | null;
  customer_count: number | string;
  vehicle_count: number | string;
  active_cert_count: number | string;
}

interface OwnerCustomerRow {
  id: string;
  tenant_id: string;
  full_name: string;
  mobile_number: string;
  language: string;
  status: string;
  created_at: string;
  registration_number: string | null;
  vehicle_type: string | null;
  fuel_type: string | null;
  certificate_number: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  cycle_status: string | null;
  policy_number: string | null;
  insurance_company: string | null;
  insurance_expiry_date: string | null;
}

@Controller('api/admin')
@UseGuards(TenantAuthGuard, AdminRoleGuard)
export class AdminController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  @Get('owners')
  async listOwners(@Query('search') search?: string, @Query('status') status?: string) {
    const conditions: string[] = [
      't.deleted_at IS NULL',
      `EXISTS (SELECT 1 FROM users u2 WHERE u2.tenant_id = t.id AND u2.deleted_at IS NULL AND u2.role != 'admin')`,
    ];
    const params: unknown[] = [];

    if (search && search.trim()) {
      const pattern = `%${search.trim().toLowerCase()}%`;
      conditions.push(
        `(LOWER(t.business_name) LIKE ? OR LOWER(t.owner_name) LIKE ? OR LOWER(t.email) LIKE ? OR LOWER(t.mobile_number) LIKE ?)`,
      );
      params.push(pattern, pattern, pattern, pattern);
    }

    if (status === 'blocked') {
      conditions.push(`t.is_blocked = ?`);
      params.push(true);
    } else if (status === 'active') {
      conditions.push(`(t.is_blocked IS NULL OR t.is_blocked = ?)`);
      params.push(false);
    }

    const rows = await this.db.query<OwnerSummaryRow>(
      `SELECT t.id, t.business_name, t.owner_name, t.email, t.mobile_number, t.address,
              t.is_blocked, t.blocked_at, t.created_at,
              (SELECT MAX(u.last_login_at) FROM users u WHERE u.tenant_id = t.id AND u.deleted_at IS NULL) as last_login_at,
              (SELECT COUNT(*) FROM customers c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL) as customer_count,
              (SELECT COUNT(*) FROM vehicles v WHERE v.tenant_id = t.id AND v.deleted_at IS NULL) as vehicle_count,
              (SELECT COUNT(*) FROM puc_certificates pc WHERE pc.tenant_id = t.id AND pc.is_current = ? AND pc.deleted_at IS NULL) as active_cert_count
       FROM tenants t
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.created_at DESC`,
      [true, ...params],
    );

    const items = rows.map((r) => ({
      id: r.id,
      businessName: r.business_name,
      ownerName: r.owner_name,
      email: r.email,
      mobileNumber: r.mobile_number,
      address: r.address || '',
      isBlocked: toBool(r.is_blocked),
      blockedAt: r.blocked_at,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      customerCount: Number(r.customer_count || 0),
      vehicleCount: Number(r.vehicle_count || 0),
      activeCertCount: Number(r.active_cert_count || 0),
    }));

    return {
      items,
      summary: {
        totalOwners: items.length,
        activeOwners: items.filter((i) => !i.isBlocked).length,
        blockedOwners: items.filter((i) => i.isBlocked).length,
        totalCustomers: items.reduce((sum, i) => sum + i.customerCount, 0),
      },
    };
  }

  @Post('owners/:tenantId/block')
  async blockOwner(@Param('tenantId') tenantId: string, @Req() req: AuthenticatedRequest) {
    if (tenantId === req.auth!.tenantId) {
      throw new BadRequestException('Cannot block your own administrator account');
    }

    const tenant = await this.db.queryOne<{ id: string; business_name: string }>(
      `SELECT id, business_name FROM tenants WHERE id = ? AND deleted_at IS NULL`,
      [tenantId],
    );
    if (!tenant) {
      throw new NotFoundException('PUC centre owner not found');
    }

    const nowIso = new Date().toISOString();
    await this.db.execute(
      `UPDATE tenants SET is_blocked = ?, blocked_at = ?, updated_at = ? WHERE id = ?`,
      [true, nowIso, nowIso, tenantId],
    );
    await this.db.execute(
      `UPDATE user_sessions SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL`,
      [nowIso, tenantId],
    );

    await this.auditService.log({
      tenantId: req.auth!.tenantId,
      userId: req.auth!.userId,
      action: 'admin.owner_blocked',
      entityType: 'tenant',
      entityId: tenantId,
      metadata: { businessName: tenant.business_name },
    });

    return { ok: true, id: tenantId, isBlocked: true, blockedAt: nowIso };
  }

  @Post('owners/:tenantId/unblock')
  async unblockOwner(@Param('tenantId') tenantId: string, @Req() req: AuthenticatedRequest) {
    const tenant = await this.db.queryOne<{ id: string; business_name: string }>(
      `SELECT id, business_name FROM tenants WHERE id = ? AND deleted_at IS NULL`,
      [tenantId],
    );
    if (!tenant) {
      throw new NotFoundException('PUC centre owner not found');
    }

    const nowIso = new Date().toISOString();
    await this.db.execute(
      `UPDATE tenants SET is_blocked = ?, blocked_at = NULL, updated_at = ? WHERE id = ?`,
      [false, nowIso, tenantId],
    );

    await this.auditService.log({
      tenantId: req.auth!.tenantId,
      userId: req.auth!.userId,
      action: 'admin.owner_unblocked',
      entityType: 'tenant',
      entityId: tenantId,
      metadata: { businessName: tenant.business_name },
    });

    return { ok: true, id: tenantId, isBlocked: false };
  }

  @Get('owners/:tenantId/customers')
  async listOwnerCustomers(
    @Param('tenantId') tenantId: string,
    @Query('search') search?: string,
  ) {
    const tenant = await this.db.queryOne<{
      id: string;
      business_name: string;
      owner_name: string;
      email: string;
      mobile_number: string;
      is_blocked: number | boolean | null;
    }>(
      `SELECT id, business_name, owner_name, email, mobile_number, is_blocked
       FROM tenants WHERE id = ? AND deleted_at IS NULL`,
      [tenantId],
    );
    if (!tenant) {
      throw new NotFoundException('PUC centre owner not found');
    }

    const conditions = ['c.tenant_id = ?', 'c.deleted_at IS NULL'];
    const params: unknown[] = [true, tenantId];

    if (search && search.trim()) {
      const pattern = `%${search.trim().toLowerCase()}%`;
      conditions.push(
        `(LOWER(c.full_name) LIKE ? OR LOWER(c.mobile_number) LIKE ? OR LOWER(COALESCE(v.registration_number, '')) LIKE ? OR LOWER(COALESCE(pc.certificate_number, '')) LIKE ?)`,
      );
      params.push(pattern, pattern, pattern, pattern);
    }

    const rows = await this.db.query<OwnerCustomerRow>(
      `SELECT c.id, c.tenant_id, c.full_name, c.mobile_number, c.language, c.status, c.created_at,
              v.registration_number, v.vehicle_type, v.fuel_type,
              pc.certificate_number, pc.issue_date, pc.expiry_date, pc.cycle_status,
              vi.policy_number, vi.insurance_company, vi.expiry_date as insurance_expiry_date
       FROM customers c
       LEFT JOIN vehicles v ON v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
       LEFT JOIN puc_certificates pc ON pc.vehicle_id = v.id AND pc.tenant_id = c.tenant_id AND pc.is_current = ? AND pc.deleted_at IS NULL
       LEFT JOIN vehicle_insurances vi ON vi.customer_id = c.id AND vi.vehicle_id = v.id AND vi.deleted_at IS NULL
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(pc.expiry_date, '9999-12-31') ASC, c.created_at DESC`,
      params,
    );

    const todayIst = getIstDateString();
    const items = rows.map((r) => {
      const derived = r.expiry_date
        ? deriveCertificateStatus(r.expiry_date, r.cycle_status || 'active', 7, todayIst)
        : { status: 'active' as const, daysUntilExpiry: 0 };

      return {
        id: r.id,
        fullName: r.full_name,
        mobileNumber: r.mobile_number,
        language: r.language,
        status: r.status,
        vehicleRegistrationNumber: r.registration_number || '',
        vehicleType: r.vehicle_type || '4W',
        fuelType: r.fuel_type || 'Petrol',
        certificateNumber: r.certificate_number || '',
        issueDate: r.issue_date || '',
        expiryDate: r.expiry_date || '',
        certificateStatus: derived.status,
        daysUntilExpiry: derived.daysUntilExpiry,
        insurance: r.policy_number
          ? {
              policyNumber: r.policy_number,
              insuranceCompany: r.insurance_company || '',
              expiryDate: r.insurance_expiry_date || '',
            }
          : null,
        createdAt: r.created_at,
      };
    });

    return {
      owner: {
        id: tenant.id,
        businessName: tenant.business_name,
        ownerName: tenant.owner_name,
        email: tenant.email,
        mobileNumber: tenant.mobile_number,
        isBlocked: toBool(tenant.is_blocked),
      },
      items,
    };
  }

  @Get('admins')
  async listAdmins() {
    const rows = await this.db.query<{
      id: string;
      email: string;
      full_name: string;
      mobile_number: string | null;
      last_login_at: string | null;
      created_at: string;
    }>(
      `SELECT id, email, full_name, mobile_number, last_login_at, created_at
       FROM users
       WHERE role = 'admin' AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    );

    return {
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        fullName: r.full_name,
        mobileNumber: r.mobile_number || '',
        lastLoginAt: r.last_login_at,
        createdAt: r.created_at,
      })),
    };
  }

  @Post('admins')
  async createAdmin(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = createAdminSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid admin details');
    }
    const d = parsed.data;
    const email = d.email.trim().toLowerCase();

    const idError = validateStrongEmailId(email);
    if (idError) throw new BadRequestException(idError);
    const pwdError = validateStrongPassword(d.password);
    if (pwdError) throw new BadRequestException(pwdError);

    const existing = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM users WHERE email = ?`,
      [email],
    );
    if (existing) {
      throw new BadRequestException('An account with this ID (email) already exists');
    }

    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const normalizedPhone = normalizeIndianPhone(d.mobileNumber);

    await this.db.execute(
      `INSERT INTO users (id, tenant_id, email, full_name, mobile_number, password_hash, role, email_verified, theme_preference, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, 'dark', ?, ?)`,
      [
        userId,
        req.auth!.tenantId,
        email,
        d.fullName.trim(),
        normalizedPhone,
        hashPassword(d.password),
        true,
        nowIso,
        nowIso,
      ],
    );

    await this.auditService.log({
      tenantId: req.auth!.tenantId,
      userId: req.auth!.userId,
      action: 'admin.created',
      entityType: 'user',
      entityId: userId,
      metadata: { email, fullName: d.fullName.trim() },
    });

    return {
      ok: true,
      admin: {
        id: userId,
        email,
        fullName: d.fullName.trim(),
        mobileNumber: normalizedPhone,
        createdAt: nowIso,
      },
    };
  }
}
