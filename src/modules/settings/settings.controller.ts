import { BadRequestException, Body, Controller, Get, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import crypto from 'crypto';
import { z } from 'zod';
import { DatabaseService } from '../../db/database.service';
import { encryptSecret } from '../../common/crypto.util';
import {
  DEFAULT_GUJARATI_TEMPLATE,
  DEFAULT_WHATSAPP_INSURANCE_TEMPLATE,
  DEFAULT_WHATSAPP_PUC_TEMPLATE,
  normalizeIndianPhone,
  toBool,
  type TenantRow,
  type UserRow,
} from '../../common/types';
import { TenantAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { CallingService } from '../telephony/calling.service';
import { AuditService } from '../audit/audit.service';
import { ReminderEngineService } from '../reminders/reminder-engine.service';

const simplifiedSettingsSchema = z.object({
  callsEnabled: z.boolean(),
  autoCallOnRegistration: z.boolean().default(true).optional(),
  messagesEnabled: z.boolean(),
  maxCallsPerCustomer: z.number().int().min(1).max(20).default(3),
  retryIntervalMinutes: z.number().int().min(5).max(1440).default(60),
  maxMessagesPerCustomer: z.number().int().min(1).max(20).default(3),
  dailyMessageLimit: z.number().int().min(1).max(10000).default(100),
  deliveryFrequency: z.string().min(2).max(40).default('1x_daily'),
  deliveryFrequencyCount: z.number().int().min(1).max(24).default(1),
  deliveryTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/)).max(24).default(['10:00']),
  callingWindowStart: z.string().regex(/^\d{2}:\d{2}$/).default('09:30'),
  callingWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).default('19:30'),
  remindDaysBefore: z.array(z.number().int().min(0).max(365)).default([7, 3, 0]),
  remindDaysAfter: z.array(z.number().int().min(1).max(365)).default([1, 3]),
  pucMessageTemplate: z.string().min(5).max(2000).optional(),
  insuranceMessageTemplate: z.string().min(5).max(2000).optional(),
  voiceScriptTemplate: z.string().min(5).max(2000).optional(),
  businessName: z.string().min(2).max(120).optional(),
  ownerName: z.string().min(2).max(100).optional(),
  mobileNumber: z.string().min(10).max(18).optional(),
  provider: z.enum(['exotel', 'mock']).optional().default('exotel'),
  mode: z.enum(['mock', 'live']).optional().default('live'),
  accountSid: z.string().max(100).optional().nullable(),
  subdomain: z.string().max(120).optional().nullable(),
  apiKey: z.string().max(200).optional().nullable(),
  apiToken: z.string().max(200).optional().nullable(),
  callerId: z.string().max(40).optional().nullable(),
  appUrl: z.string().max(300).optional().nullable(),
});

const generalSchema = z.object({
  businessName: z.string().min(2).max(120),
  ownerName: z.string().min(2).max(100),
  mobileNumber: z.string().min(10).max(18),
  email: z.string().email(),
  address: z.string().max(300).optional().nullable(),
  logoUrl: z.string().max(500).optional().nullable(),
});

const callingSettingsSchema = z.object({
  automationEnabled: z.boolean(),
  defaultLanguage: z.enum(['gu', 'hi', 'en']),
  defaultCallTime: z.string().regex(/^\d{2}:\d{2}$/),
  callingWindowStart: z.string().regex(/^\d{2}:\d{2}$/),
  callingWindowEnd: z.string().regex(/^\d{2}:\d{2}$/),
  callingDays: z.array(z.number().int().min(0).max(6)).min(1),
  maxAttempts: z.number().int().min(1).max(10),
  retryIntervalMinutes: z.number().int().min(5).max(1440),
  maxCallsPerCustomer: z.number().int().min(1).max(30),
  provider: z.enum(['exotel', 'mock']).optional(),
  mode: z.enum(['mock', 'live']).optional(),
  accountSid: z.string().max(100).optional().nullable(),
  subdomain: z.string().max(120).optional().nullable(),
  apiKey: z.string().max(200).optional(),
  apiToken: z.string().max(200).optional(),
  callerId: z.string().max(40).optional().nullable(),
  appUrl: z.string().max(300).optional().nullable(),
  webhookSecret: z.string().max(200).optional(),
  traiEntityId: z.string().max(80).optional().nullable(),
});

const renewalSettingsSchema = z.object({
  defaultLanguage: z.enum(['gu', 'hi', 'en']),
  autoScheduleOnImport: z.boolean(),
  expiryWarningDays: z.number().int().min(1).max(60),
});

const notificationSchema = z.object({
  callSuccessAlert: z.boolean(),
  callFailedAlert: z.boolean(),
  dailySummary: z.boolean(),
  renewalAlerts: z.boolean(),
});

const appearanceSchema = z.object({
  themePreference: z.enum(['light', 'dark', 'system']),
});

const profileSchema = z.object({
  fullName: z.string().min(2).max(100).optional(),
  businessName: z.string().min(2).max(120).optional(),
  ownerName: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
  mobileNumber: z.string().max(18).optional().nullable(),
  address: z.string().max(300).optional().nullable(),
});

@Controller('api/settings')
@UseGuards(TenantAuthGuard)
export class SettingsController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CallingService) private readonly callingService: CallingService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(ReminderEngineService) private readonly reminderEngine: ReminderEngineService,
  ) {}

  @Get()
  async getAll(@Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    const tenant = await this.db.queryOne<TenantRow>(`SELECT * FROM tenants WHERE id = ?`, [tenantId]);
    const user = await this.db.queryOne<UserRow>(`SELECT * FROM users WHERE id = ? AND tenant_id = ?`, [
      req.auth!.userId,
      tenantId,
    ]);
    const tel = await this.db.queryOne<Record<string, unknown>>(
      `SELECT * FROM telephony_configurations WHERE tenant_id = ?`,
      [tenantId],
    );
    const notif = await this.db.queryOne<Record<string, unknown>>(
      `SELECT * FROM notification_preferences WHERE tenant_id = ?`,
      [tenantId],
    );

    if (!tenant || !user) throw new BadRequestException('Tenant settings not found');

    const callsEnabled = toBool(tenant.calls_enabled ?? tenant.automation_enabled ?? true);
    const autoCallOnRegistration = toBool(tenant.auto_call_on_registration ?? true);
    const messagesEnabled = toBool(tenant.messages_enabled ?? true);

    return {
      simplified: {
        callsEnabled,
        autoCallOnRegistration,
        messagesEnabled,
        maxCallsPerCustomer: tenant.max_calls_per_customer || 3,
        retryIntervalMinutes: tenant.retry_interval_minutes || 60,
        maxMessagesPerCustomer: tenant.max_messages_per_customer || 3,
        dailyMessageLimit: tenant.daily_message_limit || 100,
        deliveryFrequency: tenant.delivery_frequency || '1x_daily',
        deliveryFrequencyCount: tenant.delivery_frequency_count || 1,
        deliveryTimes: (() => {
          try {
            const parsed = JSON.parse(tenant.delivery_times || '["10:00"]');
            return Array.isArray(parsed) && parsed.length > 0 ? parsed : ['10:00'];
          } catch {
            return ['10:00'];
          }
        })(),
        callingWindowStart: tenant.calling_window_start || '09:30',
        callingWindowEnd: tenant.calling_window_end || '19:30',
        remindDaysBefore: JSON.parse(tenant.remind_days_before || '[7,3,0]') as number[],
        remindDaysAfter: JSON.parse(tenant.remind_days_after || '[1,3]') as number[],
        pucMessageTemplate: DEFAULT_WHATSAPP_PUC_TEMPLATE,
        insuranceMessageTemplate: DEFAULT_WHATSAPP_INSURANCE_TEMPLATE,
        voiceScriptTemplate: tenant.voice_script_template || DEFAULT_GUJARATI_TEMPLATE,
        businessName: tenant.business_name,
        ownerName: tenant.owner_name,
        mobileNumber: tenant.mobile_number,
        telephony: {
          provider: (tel?.provider as string) || 'exotel',
          mode: (tel?.mode as string) || 'live',
          accountSid: (tel?.account_sid as string) || process.env.EXOTEL_ACCOUNT_SID || '',
          subdomain: (tel?.subdomain as string) || process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
          callerId: (tel?.caller_id as string) || process.env.EXOTEL_CALLER_ID || '',
          appUrl: (tel?.app_url as string) || process.env.EXOTEL_APP_URL || '',
          hasApiKey: Boolean(tel?.api_key_encrypted || process.env.EXOTEL_API_KEY),
          hasApiToken: Boolean(tel?.api_token_encrypted || process.env.EXOTEL_API_TOKEN),
          lastTestedAt: (tel?.last_tested_at as string) || null,
          lastTestStatus: (tel?.last_test_status as string) || null,
        },
      },
      general: {
        businessName: tenant.business_name,
        ownerName: tenant.owner_name,
        mobileNumber: tenant.mobile_number,
        email: tenant.email,
        address: tenant.address || '',
        logoUrl: tenant.logo_url || '',
        timezone: tenant.timezone,
      },
      calling: {
        automationEnabled: toBool(tenant.automation_enabled),
        defaultLanguage: tenant.default_language,
        defaultCallTime: tenant.default_call_time,
        callingWindowStart: tenant.calling_window_start,
        callingWindowEnd: tenant.calling_window_end,
        callingDays: JSON.parse(tenant.calling_days_json || '[1,2,3,4,5,6]') as number[],
        maxAttempts: tenant.max_attempts,
        retryIntervalMinutes: tenant.retry_interval_minutes,
        maxCallsPerCustomer: tenant.max_calls_per_customer,
        provider: (tel?.provider as string) || 'exotel',
        mode: (tel?.mode as string) || 'mock',
        accountSid: (tel?.account_sid as string) || '',
        subdomain: (tel?.subdomain as string) || 'api.in.exotel.com',
        callerId: (tel?.caller_id as string) || '',
        appUrl: (tel?.app_url as string) || '',
        traiEntityId: (tel?.trai_entity_id as string) || '',
        // Never expose encrypted/raw secrets to the browser!
        hasApiKey: Boolean(tel?.api_key_encrypted),
        hasApiToken: Boolean(tel?.api_token_encrypted),
        hasWebhookSecret: Boolean(tel?.webhook_secret_encrypted),
        lastTestedAt: (tel?.last_tested_at as string) || null,
        lastTestStatus: (tel?.last_test_status as string) || null,
      },
      renewal: {
        defaultLanguage: tenant.default_language,
        autoScheduleOnImport: toBool(tenant.auto_schedule_on_import),
        expiryWarningDays: tenant.expiry_warning_days,
      },
      notifications: {
        callSuccessAlert: toBool(notif?.call_success_alert),
        callFailedAlert: toBool(notif?.call_failed_alert ?? true),
        dailySummary: toBool(notif?.daily_summary ?? true),
        renewalAlerts: toBool(notif?.renewal_alerts ?? true),
      },
      appearance: {
        themePreference: user.theme_preference || 'dark',
      },
      profile: {
        fullName: user.full_name,
        email: user.email,
        mobileNumber: user.mobile_number || '',
        emailVerified: toBool(user.email_verified),
      },
      databaseEngine: this.db.getEngine(),
    };
  }

  @Put()
  async updateSimplifiedSettings(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = simplifiedSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid settings payload');
    }
    const d = parsed.data;
    const tenantId = req.auth!.tenantId;
    const nowIso = new Date().toISOString();

    const daysBefore = Array.from(new Set(d.remindDaysBefore)).sort((a, b) => b - a);
    const daysAfter = Array.from(new Set(d.remindDaysAfter)).sort((a, b) => a - b);
    const freqCount = Math.min(24, Math.max(1, d.deliveryFrequencyCount || 1));
    const normalizedTimes = Array.from({ length: freqCount }, (_, idx) => d.deliveryTimes[idx] || '10:00');

    await this.db.execute(
      `UPDATE tenants
       SET calls_enabled = ?, auto_call_on_registration = ?, messages_enabled = ?, automation_enabled = ?,
           max_calls_per_customer = ?, retry_interval_minutes = ?, max_messages_per_customer = ?,
           daily_message_limit = ?, delivery_frequency = ?,
           delivery_frequency_count = ?, delivery_times = ?,
           calling_window_start = ?, calling_window_end = ?,
           remind_days_before = ?, remind_days_after = ?,
           puc_message_template = COALESCE(?, puc_message_template),
           insurance_message_template = COALESCE(?, insurance_message_template),
           voice_script_template = COALESCE(?, voice_script_template),
           business_name = COALESCE(?, business_name),
           owner_name = COALESCE(?, owner_name),
           mobile_number = COALESCE(?, mobile_number),
           updated_at = ?
       WHERE id = ?`,
      [
        d.callsEnabled,
        d.autoCallOnRegistration ?? true,
        d.messagesEnabled,
        d.callsEnabled,
        d.maxCallsPerCustomer,
        d.retryIntervalMinutes,
        d.maxMessagesPerCustomer,
        d.dailyMessageLimit,
        `${freqCount}x_daily`,
        freqCount,
        JSON.stringify(normalizedTimes),
        d.callingWindowStart,
        d.callingWindowEnd,
        JSON.stringify(daysBefore),
        JSON.stringify(daysAfter),
        d.pucMessageTemplate ?? null,
        d.insuranceMessageTemplate ?? null,
        d.voiceScriptTemplate ?? null,
        d.businessName?.trim() || null,
        d.ownerName?.trim() || null,
        d.mobileNumber ? normalizeIndianPhone(d.mobileNumber) : null,
        nowIso,
        tenantId,
      ],
    );

    // Sync reminder_rules with configured days before / on expiry / after expiry
    const desiredOffsets = [
      ...daysBefore.map((day) => ({
        offset: -day,
        label: day === 0 ? 'On expiry date' : `${day} ${day === 1 ? 'day' : 'days'} before expiry`,
      })),
      ...daysAfter.map((day) => ({
        offset: day,
        label: `${day} ${day === 1 ? 'day' : 'days'} after expiry`,
      })),
    ];

    await this.db.execute(
      `UPDATE reminder_rules SET is_active = ?, updated_at = ? WHERE tenant_id = ?`,
      [false, nowIso, tenantId],
    );

    for (let i = 0; i < desiredOffsets.length; i++) {
      const rule = desiredOffsets[i];
      const existingRule = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM reminder_rules WHERE tenant_id = ? AND offset_days = ?`,
        [tenantId, rule.offset],
      );
      if (existingRule) {
        await this.db.execute(
          `UPDATE reminder_rules SET label = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
          [rule.label, true, i + 1, nowIso, existingRule.id],
        );
      } else {
        await this.db.execute(
          `INSERT INTO reminder_rules (id, tenant_id, label, offset_days, is_active, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), tenantId, rule.label, rule.offset, true, i + 1, nowIso, nowIso],
        );
      }
    }

    const existingTel = await this.db.queryOne<{
      id: string;
      api_key_encrypted: string | null;
      api_token_encrypted: string | null;
      webhook_secret_encrypted: string | null;
    }>(`SELECT * FROM telephony_configurations WHERE tenant_id = ?`, [tenantId]);

    const encKey = d.apiKey && d.apiKey.trim() ? encryptSecret(d.apiKey.trim()) : existingTel?.api_key_encrypted || null;
    const encToken = d.apiToken && d.apiToken.trim() ? encryptSecret(d.apiToken.trim()) : existingTel?.api_token_encrypted || null;

    if (existingTel) {
      await this.db.execute(
        `UPDATE telephony_configurations
         SET provider = ?, mode = ?, account_sid = ?, subdomain = ?,
             api_key_encrypted = ?, api_token_encrypted = ?, caller_id = ?, app_url = ?, updated_at = ?
         WHERE tenant_id = ?`,
        [
          d.provider || 'exotel',
          d.mode || 'live',
          d.accountSid?.trim() || null,
          d.subdomain?.trim() || 'api.exotel.com',
          encKey,
          encToken,
          d.callerId?.trim() || null,
          d.appUrl?.trim() || null,
          nowIso,
          tenantId,
        ],
      );
    } else {
      await this.db.execute(
        `INSERT INTO telephony_configurations (id, tenant_id, provider, mode, account_sid, subdomain, api_key_encrypted, api_token_encrypted, caller_id, app_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          tenantId,
          d.provider || 'exotel',
          d.mode || 'live',
          d.accountSid?.trim() || null,
          d.subdomain?.trim() || 'api.exotel.com',
          encKey,
          encToken,
          d.callerId?.trim() || null,
          d.appUrl?.trim() || null,
          nowIso,
          nowIso,
        ],
      );
    }

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'settings.updated',
      entityType: 'tenant',
      metadata: {
        callsEnabled: d.callsEnabled,
        messagesEnabled: d.messagesEnabled,
        dailyMessageLimit: d.dailyMessageLimit,
        deliveryTimes: normalizedTimes,
      },
    });

    if (d.messagesEnabled) {
      setImmediate(() => {
        this.reminderEngine.runWhatsAppSchedulerCycle(tenantId, { ignoreWindow: false }).catch((err) => {
          console.error('[Settings] Immediate WhatsApp scheduler trigger failed:', err);
        });
      });
    }

    return { ok: true };
  }

  @Put('general')
  async updateGeneral(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = generalSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid general settings');
    const d = parsed.data;
    if (d.logoUrl && !/^https?:\/\/|^\/api\//.test(d.logoUrl.trim())) {
      throw new BadRequestException('Business logo URL must start with https:// or http://');
    }

    await this.db.execute(
      `UPDATE tenants SET business_name = ?, owner_name = ?, mobile_number = ?, email = ?, address = ?, logo_url = ?, updated_at = ?
       WHERE id = ?`,
      [d.businessName.trim(), d.ownerName.trim(), normalizeIndianPhone(d.mobileNumber), d.email.trim().toLowerCase(), d.address?.trim() || null, d.logoUrl?.trim() || null, new Date().toISOString(), req.auth!.tenantId],
    );
    await this.auditService.log({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, action: 'settings.general_updated', entityType: 'tenant', entityId: req.auth!.tenantId });
    return { ok: true };
  }

  @Put('calling')
  async updateCalling(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = callingSettingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid calling settings');
    const d = parsed.data;
    const tenantId = req.auth!.tenantId;
    const nowIso = new Date().toISOString();

    await this.db.execute(
      `UPDATE tenants
       SET automation_enabled = ?, default_language = ?, default_call_time = ?,
           calling_window_start = ?, calling_window_end = ?, calling_days_json = ?,
           max_attempts = ?, retry_interval_minutes = ?, max_calls_per_customer = ?, updated_at = ?
       WHERE id = ?`,
      [
        d.automationEnabled, d.defaultLanguage, d.defaultCallTime,
        d.callingWindowStart, d.callingWindowEnd, JSON.stringify(d.callingDays),
        d.maxAttempts, d.retryIntervalMinutes, d.maxCallsPerCustomer, nowIso, tenantId,
      ],
    );

    const existingTel = await this.db.queryOne<{
      id: string;
      api_key_encrypted: string | null;
      api_token_encrypted: string | null;
      webhook_secret_encrypted: string | null;
    }>(`SELECT * FROM telephony_configurations WHERE tenant_id = ?`, [tenantId]);

    const encKey = d.apiKey && d.apiKey.trim() ? encryptSecret(d.apiKey.trim()) : existingTel?.api_key_encrypted || null;
    const encToken = d.apiToken && d.apiToken.trim() ? encryptSecret(d.apiToken.trim()) : existingTel?.api_token_encrypted || null;
    const encWebhook = d.webhookSecret && d.webhookSecret.trim() ? encryptSecret(d.webhookSecret.trim()) : existingTel?.webhook_secret_encrypted || null;

    if (existingTel) {
      await this.db.execute(
        `UPDATE telephony_configurations
         SET provider = ?, mode = ?, account_sid = ?, subdomain = ?,
             api_key_encrypted = ?, api_token_encrypted = ?, caller_id = ?, app_url = ?,
             webhook_secret_encrypted = ?, trai_entity_id = ?, updated_at = ?
         WHERE tenant_id = ?`,
        [
          d.provider || 'exotel', d.mode || 'mock', d.accountSid?.trim() || null, d.subdomain?.trim() || 'api.in.exotel.com',
          encKey, encToken, d.callerId?.trim() || null, d.appUrl?.trim() || null, encWebhook, d.traiEntityId?.trim() || null,
          nowIso, tenantId,
        ],
      );
    }

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'settings.calling_updated',
      entityType: 'telephony_configuration',
      metadata: { mode: d.mode, automationEnabled: d.automationEnabled },
    });
    return { ok: true };
  }

  @Post('calling/test')
  async testCallingConnection(@Req() req: AuthenticatedRequest) {
    return this.callingService.validateProviderConfiguration(req.auth!.tenantId);
  }

  @Put('renewal')
  async updateRenewal(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = renewalSettingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid renewal settings');
    await this.db.execute(
      `UPDATE tenants SET default_language = ?, auto_schedule_on_import = ?, expiry_warning_days = ?, updated_at = ? WHERE id = ?`,
      [parsed.data.defaultLanguage, parsed.data.autoScheduleOnImport, parsed.data.expiryWarningDays, new Date().toISOString(), req.auth!.tenantId],
    );
    return { ok: true };
  }

  @Put('notifications')
  async updateNotifications(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = notificationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid notification preferences');
    await this.db.execute(
      `UPDATE notification_preferences SET call_success_alert = ?, call_failed_alert = ?, daily_summary = ?, renewal_alerts = ?, updated_at = ?
       WHERE tenant_id = ?`,
      [parsed.data.callSuccessAlert, parsed.data.callFailedAlert, parsed.data.dailySummary, parsed.data.renewalAlerts, new Date().toISOString(), req.auth!.tenantId],
    );
    return { ok: true };
  }

  @Put('appearance')
  async updateAppearance(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = appearanceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid theme preference');
    await this.db.execute(
      `UPDATE users SET theme_preference = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      [parsed.data.themePreference, new Date().toISOString(), req.auth!.userId, req.auth!.tenantId],
    );
    return { ok: true, themePreference: parsed.data.themePreference };
  }

  @Put('profile')
  async updateProfile(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = profileSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid profile details');
    const d = parsed.data;
    const phone = d.mobileNumber && d.mobileNumber.trim().length >= 10 ? normalizeIndianPhone(d.mobileNumber) : (d.mobileNumber?.trim() || null);
    const nowIso = new Date().toISOString();

    const fullName = d.fullName?.trim() || d.ownerName?.trim();
    if (fullName || d.email || phone !== undefined) {
      await this.db.execute(
        `UPDATE users 
         SET full_name = COALESCE(?, full_name),
             email = COALESCE(?, email),
             mobile_number = ?,
             updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [fullName || null, d.email?.trim().toLowerCase() || null, phone, nowIso, req.auth!.userId, req.auth!.tenantId],
      );
    }

    if (d.businessName || d.ownerName || fullName || d.email || phone !== undefined || d.address !== undefined) {
      await this.db.execute(
        `UPDATE tenants
         SET business_name = COALESCE(?, business_name),
             owner_name = COALESCE(?, owner_name),
             email = COALESCE(?, email),
             mobile_number = COALESCE(?, mobile_number),
             address = CASE WHEN ? THEN ? ELSE address END,
             updated_at = ?
         WHERE id = ?`,
        [
          d.businessName?.trim() || null,
          d.ownerName?.trim() || fullName || null,
          d.email?.trim().toLowerCase() || null,
          phone || null,
          d.address !== undefined,
          d.address?.trim() || null,
          nowIso,
          req.auth!.tenantId,
        ],
      );
    }

    return { ok: true };
  }
}
