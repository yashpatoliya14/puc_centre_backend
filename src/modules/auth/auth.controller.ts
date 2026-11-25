import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import crypto from 'crypto';
import { z } from 'zod';
import { DatabaseService } from '../../db/database.service';
import {
  generateToken,
  hashPassword,
  sha256Hex,
  signSessionToken,
  validateStrongEmailId,
  validateStrongPassword,
  verifyPassword,
} from '../../common/crypto.util';
import { normalizeIndianPhone, toBool, type TenantRow, type UserRow } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { SeedService, DEMO_EMAIL, DEMO_PASSWORD } from './seed.service';
import { TenantAuthGuard, type AuthenticatedRequest } from './auth.guard';
import { ReminderEngineService } from '../reminders/reminder-engine.service';
import { EmailService } from '../email/email.service';

const registerSchema = z.object({
  businessName: z.string().min(2, 'Business name is required').max(120),
  ownerName: z.string().min(2, 'Owner name is required').max(100),
  mobileNumber: z.string().min(10, 'Valid 10-digit mobile number required').max(16),
  email: z.string().email('Valid email required'),
  password: z.string().min(10, 'Password must be at least 10 characters').max(100),
  address: z.string().max(300).optional(),
  preloadSampleData: z.boolean().optional().default(true),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const resetPasswordSchema = z.object({
  email: z.string().email().optional(),
  token: z.string().min(6, 'Reset code must be at least 6 characters').max(128),
  newPassword: z.string().min(10, 'Password must be at least 10 characters').max(100),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'New password must be at least 10 characters').max(100),
});

@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(SeedService) private readonly seedService: SeedService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(ReminderEngineService) private readonly reminderEngine: ReminderEngineService,
    @Inject(EmailService) private readonly emailService: EmailService,
  ) {}

  private generateSixDigitCode(): string {
    return crypto.randomInt(100000, 999999).toString();
  }

  private async createSession(user: UserRow, req: AuthenticatedRequest): Promise<string> {
    const sessionId = crypto.randomUUID();
    // 30 days (1 month) session token validity
    const ttlDays = Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30);
    const SESSION_EXPIRATION_MS = ttlDays * 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + SESSION_EXPIRATION_MS;
    const token = signSessionToken({
      sid: sessionId,
      uid: user.id,
      tid: user.tenant_id,
      exp: expiresAt,
    });

    await this.db.execute(
      `INSERT INTO user_sessions (id, tenant_id, user_id, token_hash, user_agent, ip_address, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        user.tenant_id,
        user.id,
        sha256Hex(token),
        String(req.headers['user-agent'] || 'Web Browser').slice(0, 200),
        req.ip || '127.0.0.1',
        new Date(expiresAt).toISOString(),
        new Date().toISOString(),
      ],
    );

    await this.db.execute(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      new Date().toISOString(),
      user.id,
    ]);

    return token;
  }

  private async buildAuthPayload(userId: string, tenantId: string) {
    const user = await this.db.queryOne<UserRow>(`SELECT * FROM users WHERE id = ? AND tenant_id = ?`, [
      userId,
      tenantId,
    ]);
    const tenant = await this.db.queryOne<TenantRow>(`SELECT * FROM tenants WHERE id = ?`, [tenantId]);
    const tel = await this.db.queryOne<{ mode: string; provider: string }>(
      `SELECT mode, provider FROM telephony_configurations WHERE tenant_id = ?`,
      [tenantId],
    );

    if (!user || !tenant) throw new UnauthorizedException('Account not found');

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        mobileNumber: user.mobile_number,
        role: user.role,
        emailVerified: toBool(user.email_verified),
        themePreference: user.theme_preference || 'dark',
        lastLoginAt: user.last_login_at,
      },
      tenant: {
        id: tenant.id,
        businessName: tenant.business_name,
        ownerName: tenant.owner_name,
        mobileNumber: tenant.mobile_number,
        email: tenant.email,
        address: tenant.address,
        logoUrl: tenant.logo_url,
        timezone: tenant.timezone,
        automationEnabled: toBool(tenant.automation_enabled),
        defaultLanguage: tenant.default_language,
        defaultCallTime: tenant.default_call_time,
        callingWindowStart: tenant.calling_window_start,
        callingWindowEnd: tenant.calling_window_end,
      },
      runtime: {
        telephonyMode: tel?.mode || 'mock',
        telephonyProvider: tel?.provider || 'exotel',
        databaseEngine: this.db.getEngine(),
        queueMode: this.reminderEngine.getQueueMode(),
      },
    };
  }

  @Post('register')
  async register(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid registration data');
    }
    const data = parsed.data;
    const email = data.email.trim().toLowerCase();

    const idError = validateStrongEmailId(email);
    if (idError) throw new BadRequestException(idError);
    const pwdError = validateStrongPassword(data.password);
    if (pwdError) throw new BadRequestException(pwdError);

    const existing = await this.db.queryOne<{ id: string }>(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existing) {
      throw new BadRequestException('An account with this email already exists');
    }

    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const verificationCode = this.emailService.isConfigured()
      ? this.generateSixDigitCode()
      : generateToken(32);
    const normalizedPhone = normalizeIndianPhone(data.mobileNumber);

    await this.db.execute(
      `INSERT INTO tenants (id, business_name, owner_name, mobile_number, email, address, timezone, automation_enabled, auto_schedule_on_import, default_language, default_call_time, calling_window_start, calling_window_end, calling_days_json, max_attempts, retry_interval_minutes, max_calls_per_customer, expiry_warning_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Asia/Kolkata', ?, ?, 'gu', '10:00', '09:30', '19:30', '[1,2,3,4,5,6]', 3, 60, 6, 7, ?, ?)`,
      [tenantId, data.businessName.trim(), data.ownerName.trim(), normalizedPhone, email, data.address?.trim() || null, true, true, nowIso, nowIso],
    );

    await this.db.execute(
      `INSERT INTO users (id, tenant_id, email, full_name, mobile_number, password_hash, role, email_verified, verification_token, theme_preference, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?, 'dark', ?, ?)`,
      [userId, tenantId, email, data.ownerName.trim(), normalizedPhone, hashPassword(data.password), false, verificationCode, nowIso, nowIso],
    );

    const resources = await this.seedService.createDefaultTenantResources(tenantId, data.businessName.trim());
    if (data.preloadSampleData) {
      await this.seedService.seedSampleCentreData(tenantId, userId, resources);
    }

    await this.auditService.log({
      tenantId,
      userId,
      action: 'auth.registered',
      entityType: 'tenant',
      entityId: tenantId,
      ipAddress: req.ip,
    });

    if (this.emailService.isConfigured()) {
      try {
        await this.emailService.sendVerificationEmail({
          to: email,
          ownerName: data.ownerName.trim(),
          businessName: data.businessName.trim(),
          code: verificationCode,
        });
      } catch (err) {
        // Clean up freshly created unverified account if SMTP email delivery fails
        await this.db.execute(`DELETE FROM tenants WHERE id = ?`, [tenantId]).catch(() => {});
        throw err;
      }

      return {
        requiresVerification: true,
        email,
        businessName: data.businessName.trim(),
        message: 'Account created! Enter the 6-digit verification code sent to your email.',
      };
    }

    const user = (await this.db.queryOne<UserRow>(`SELECT * FROM users WHERE id = ?`, [userId]))!;
    const token = await this.createSession(user, req);
    const profile = await this.buildAuthPayload(userId, tenantId);
    return {
      requiresVerification: false,
      token,
      verificationToken: verificationCode,
      ...profile,
    };
  }

  @Post('login')
  async login(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Please enter a valid email and password');
    }
    const email = parsed.data.email.trim().toLowerCase();
    const user = await this.db.queryOne<UserRow>(
      `SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`,
      [email],
    );
    if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tenant = await this.db.queryOne<{ is_blocked?: number | boolean; deleted_at: string | null }>(
      `SELECT is_blocked, deleted_at FROM tenants WHERE id = ?`,
      [user.tenant_id],
    );
    if (!tenant || tenant.deleted_at) {
      throw new UnauthorizedException('Account is inactive');
    }
    if (toBool(tenant.is_blocked) && user.role !== 'admin') {
      throw new ForbiddenException('Your PUC centre account has been blocked by the administrator.');
    }
    if (
      user.role === 'owner' &&
      !toBool(user.email_verified) &&
      !user.last_login_at &&
      this.emailService.isConfigured()
    ) {
      const code = this.generateSixDigitCode();
      await this.db.execute(
        `UPDATE users SET verification_token = ?, updated_at = ? WHERE id = ?`,
        [code, new Date().toISOString(), user.id],
      );
      const tRow = await this.db.queryOne<{ business_name: string }>(
        `SELECT business_name FROM tenants WHERE id = ?`,
        [user.tenant_id],
      );
      await this.emailService.sendVerificationEmail({
        to: user.email,
        ownerName: user.full_name,
        businessName: tRow?.business_name || 'PUC Centre',
        code,
      });
      throw new ForbiddenException({
        message: 'Please verify your email address first. A 6-digit verification code has been sent to your email.',
        code: 'EMAIL_NOT_VERIFIED',
        requiresVerification: true,
        email: user.email,
      });
    }

    const token = await this.createSession(user, req);
    await this.auditService.log({
      tenantId: user.tenant_id,
      userId: user.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ipAddress: req.ip,
    });

    const profile = await this.buildAuthPayload(user.id, user.tenant_id);
    return { token, ...profile };
  }

  @Post('demo-login')
  async demoLogin(@Req() req: AuthenticatedRequest) {
    await this.seedService.ensureDemoTenantExists();
    const user = await this.db.queryOne<UserRow>(
      `SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`,
      [DEMO_EMAIL],
    );
    if (!user || !verifyPassword(DEMO_PASSWORD, user.password_hash)) {
      throw new UnauthorizedException('Demo workspace unavailable');
    }
    const token = await this.createSession(user, req);
    const profile = await this.buildAuthPayload(user.id, user.tenant_id);
    return { token, ...profile };
  }

  @Get('me')
  @UseGuards(TenantAuthGuard)
  async me(@Req() req: AuthenticatedRequest) {
    return this.buildAuthPayload(req.auth!.userId, req.auth!.tenantId);
  }

  @Post('logout')
  @UseGuards(TenantAuthGuard)
  async logout(@Req() req: AuthenticatedRequest) {
    await this.db.execute(`UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND tenant_id = ?`, [
      new Date().toISOString(),
      req.auth!.sessionId,
      req.auth!.tenantId,
    ]);
    return { ok: true };
  }

  @Post('verify-email')
  async verifyEmail(
    @Body() body: { email?: string; token?: string; code?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const verificationCode = String(body?.code || body?.token || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    if (!verificationCode) throw new BadRequestException('Verification code is required');

    const user = email
      ? await this.db.queryOne<UserRow>(
          `SELECT * FROM users WHERE LOWER(email) = ? AND verification_token = ? AND deleted_at IS NULL`,
          [email, verificationCode],
        )
      : await this.db.queryOne<UserRow>(
          `SELECT * FROM users WHERE verification_token = ? AND deleted_at IS NULL`,
          [verificationCode],
        );

    if (!user) throw new BadRequestException('Invalid or expired verification code');

    await this.db.execute(
      `UPDATE users SET email_verified = ?, verification_token = NULL, updated_at = ? WHERE id = ?`,
      [true, new Date().toISOString(), user.id],
    );

    const token = await this.createSession(user, req);
    await this.auditService.log({
      tenantId: user.tenant_id,
      userId: user.id,
      action: 'auth.email_verified',
      entityType: 'user',
      entityId: user.id,
      ipAddress: req.ip,
    });
    const profile = await this.buildAuthPayload(user.id, user.tenant_id);
    return { ok: true, message: 'Email verified successfully.', token, ...profile };
  }

  @Post('resend-verification')
  async resendVerification(@Body() body: { email?: string }) {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) throw new BadRequestException('Email is required');
    const user = await this.db.queryOne<UserRow>(
      `SELECT * FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL`,
      [email],
    );
    if (!user) {
      return { ok: true, message: 'If an unverified account matches that email, a verification code has been sent.' };
    }
    if (toBool(user.email_verified)) {
      return { ok: true, alreadyVerified: true, message: 'Email is already verified. Please sign in.' };
    }
    const tenant = await this.db.queryOne<{ business_name: string }>(
      `SELECT business_name FROM tenants WHERE id = ?`,
      [user.tenant_id],
    );
    const code = this.generateSixDigitCode();
    await this.db.execute(
      `UPDATE users SET verification_token = ?, updated_at = ? WHERE id = ?`,
      [code, new Date().toISOString(), user.id],
    );
    if (this.emailService.isConfigured()) {
      await this.emailService.sendVerificationEmail({
        to: user.email,
        ownerName: user.full_name,
        businessName: tenant?.business_name || 'PUC Centre',
        code,
      });
      return { ok: true, message: 'A new 6-digit verification code has been sent to your email.' };
    }
    return {
      ok: true,
      message: 'Verification code regenerated (configure BREVO_SMTP_USER to send via Brevo email).',
      previewVerificationCode: process.env.NODE_ENV === 'production' ? undefined : code,
    };
  }

  @Post('forgot-password')
  async forgotPassword(@Body() body: { email?: string }) {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) throw new BadRequestException('Email is required');
    const user = await this.db.queryOne<UserRow>(
      `SELECT * FROM users WHERE LOWER(email) = ? AND deleted_at IS NULL`,
      [email],
    );
    if (!user) {
      return {
        ok: true,
        emailSent: this.emailService.isConfigured(),
        message: 'If an account matches that email, a password reset code has been sent.',
      };
    }
    const resetCode = this.emailService.isConfigured() ? this.generateSixDigitCode() : generateToken(32);
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await this.db.execute(
      `UPDATE users SET reset_token = ?, reset_token_expires_at = ?, updated_at = ? WHERE id = ?`,
      [resetCode, expiresAt, new Date().toISOString(), user.id],
    );

    if (this.emailService.isConfigured()) {
      await this.emailService.sendPasswordResetEmail({
        to: user.email,
        ownerName: user.full_name,
        code: resetCode,
      });
      return {
        ok: true,
        emailSent: true,
        message: 'A 6-digit password reset code has been sent to your email (valid for 30 minutes).',
      };
    }

    return {
      ok: true,
      emailSent: false,
      message: 'Password reset code generated (configure BREVO_SMTP_USER to send via Brevo email).',
      previewResetToken: process.env.NODE_ENV === 'production' ? undefined : resetCode,
    };
  }

  @Post('reset-password')
  async resetPassword(@Body() body: unknown) {
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid reset request');
    }
    const pwdError = validateStrongPassword(parsed.data.newPassword);
    if (pwdError) throw new BadRequestException(pwdError);
    const email = parsed.data.email?.trim().toLowerCase();
    const user = email
      ? await this.db.queryOne<UserRow>(
          `SELECT * FROM users WHERE LOWER(email) = ? AND reset_token = ? AND deleted_at IS NULL`,
          [email, parsed.data.token.trim()],
        )
      : await this.db.queryOne<UserRow>(
          `SELECT * FROM users WHERE reset_token = ? AND deleted_at IS NULL`,
          [parsed.data.token.trim()],
        );
    if (!user || !user.reset_token_expires_at || new Date(user.reset_token_expires_at).getTime() < Date.now()) {
      throw new BadRequestException('Reset code is invalid or expired');
    }
    const nowIso = new Date().toISOString();
    await this.db.execute(
      `UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires_at = NULL, updated_at = ? WHERE id = ?`,
      [hashPassword(parsed.data.newPassword), nowIso, user.id],
    );
    // Revoke all existing sessions on password reset
    await this.db.execute(`UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [
      nowIso,
      user.id,
    ]);
    return { ok: true, message: 'Password updated successfully. Please sign in.' };
  }

  @Post('change-password')
  @UseGuards(TenantAuthGuard)
  async changePassword(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid password payload');
    }
    const pwdError = validateStrongPassword(parsed.data.newPassword);
    if (pwdError) throw new BadRequestException(pwdError);
    const user = await this.db.queryOne<UserRow>(`SELECT * FROM users WHERE id = ? AND tenant_id = ?`, [
      req.auth!.userId,
      req.auth!.tenantId,
    ]);
    if (!user || !verifyPassword(parsed.data.currentPassword, user.password_hash)) {
      throw new BadRequestException('Current password is incorrect');
    }
    await this.db.execute(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [
      hashPassword(parsed.data.newPassword),
      new Date().toISOString(),
      user.id,
    ]);
    await this.auditService.log({
      tenantId: req.auth!.tenantId,
      userId: req.auth!.userId,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id,
    });
    return { ok: true };
  }

  @Get('sessions')
  @UseGuards(TenantAuthGuard)
  async listSessions(@Req() req: AuthenticatedRequest) {
    const rows = await this.db.query<{
      id: string;
      user_agent: string | null;
      ip_address: string | null;
      expires_at: string;
      created_at: string;
    }>(
      `SELECT id, user_agent, ip_address, expires_at, created_at
       FROM user_sessions
       WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
      [req.auth!.tenantId, req.auth!.userId, new Date().toISOString()],
    );
    return rows.map((r) => ({
      ...r,
      isCurrent: r.id === req.auth!.sessionId,
    }));
  }

  @Delete('sessions/:id')
  @UseGuards(TenantAuthGuard)
  async revokeSession(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.db.execute(
      `UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?`,
      [new Date().toISOString(), id, req.auth!.tenantId, req.auth!.userId],
    );
    return { ok: true };
  }

  @Delete('account')
  @UseGuards(TenantAuthGuard)
  async deleteAccount(@Body() body: { password?: string }, @Req() req: AuthenticatedRequest) {
    const user = await this.db.queryOne<UserRow>(`SELECT * FROM users WHERE id = ? AND tenant_id = ?`, [
      req.auth!.userId,
      req.auth!.tenantId,
    ]);
    if (!user || !body?.password || !verifyPassword(body.password, user.password_hash)) {
      throw new BadRequestException('Please confirm your password to delete the account');
    }
    if (user.email === DEMO_EMAIL) {
      throw new BadRequestException('The shared demo workspace cannot be deleted. Register your own PUC centre account to test account deletion.');
    }
    const nowIso = new Date().toISOString();
    await this.db.execute(`UPDATE user_sessions SET revoked_at = ? WHERE tenant_id = ?`, [nowIso, req.auth!.tenantId]);
    await this.db.execute(`UPDATE users SET deleted_at = ? WHERE tenant_id = ?`, [nowIso, req.auth!.tenantId]);
    await this.db.execute(`UPDATE tenants SET deleted_at = ? WHERE id = ?`, [nowIso, req.auth!.tenantId]);
    return { ok: true };
  }
}
