import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  HttpCode,
  ForbiddenException,
  BadRequestException,
  UseGuards,
  Inject,
  Logger,
} from '@nestjs/common';
import { TenantAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { WhatsAppService, type MetaWebhookPayload } from './whatsapp.service';
import { DatabaseService } from '../../db/database.service';
import { ReminderEngineService } from '../reminders/reminder-engine.service';
import { addDaysToDateStr, diffDays, getIstDateString, getIstParts } from '../../common/ist-date.util';
import { toBool, type TenantRow } from '../../common/types';

@Controller(['api/whatsapp', 'whatsapp'])
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(
    @Inject(WhatsAppService) private readonly whatsappService: WhatsAppService,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ReminderEngineService) private readonly reminderEngine: ReminderEngineService,
  ) {}

  /**
   * 1. Meta Webhook Verification (GET /whatsapp/webhook or /api/whatsapp/webhook)
   */
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const result = this.whatsappService.verifyWebhook(mode, token, challenge);
    if (!result) throw new ForbiddenException('Meta Webhook verification token mismatch');
    return result;
  }

  /**
   * 2. Meta Webhook Events & Receipts (POST /whatsapp/webhook or /api/whatsapp/webhook)
   */
  @Post('webhook')
  @HttpCode(200)
  handleWebhook(@Body() body: MetaWebhookPayload) {
    this.whatsappService.processWebhookPayload(body);
    return 'EVENT_RECEIVED';
  }

  /**
   * 3. Send generic template message
   */
  @Post('send-template')
  @UseGuards(TenantAuthGuard)
  async sendTemplate(
    @Body()
    body: {
      to?: string;
      templateName?: string;
      languageCode?: string;
      bodyParameters?: string[];
    },
  ) {
    if (!body?.to || !body?.templateName) {
      throw new BadRequestException('Recipient "to" and "templateName" are required');
    }
    const result = await this.whatsappService.sendTemplateMessage({
      to: body.to,
      templateName: body.templateName,
      languageCode: body.languageCode,
      bodyParameters: body.bodyParameters,
    });
    return { ok: true, data: result };
  }

  /**
   * 4. Send PUC reminder using template "puc_certificate_utility"
   */
  @Post('send-puc-reminder')
  @UseGuards(TenantAuthGuard)
  async sendPucReminder(
    @Body()
    body: {
      to?: string;
      customerName?: string;
      vehiclePlate?: string;
      expiryDate?: string;
      centreName?: string;
      ownerName?: string;
      centreAddress?: string;
      contactNumber?: string;
    },
  ) {
    if (!body?.to || !body?.vehiclePlate) {
      throw new BadRequestException('Recipient "to" and "vehiclePlate" are required');
    }
    const result = await this.whatsappService.sendPucCertificateReminder({
      to: body.to,
      customerName: body.customerName || 'Customer',
      vehiclePlate: body.vehiclePlate,
      expiryDate: body.expiryDate || 'Soon',
      centreName: body.centreName || 'PUC Centre',
      ownerName: body.ownerName || 'Centre Owner',
      centreAddress: body.centreAddress || 'Station Road',
      contactNumber: body.contactNumber || 'Contact Office',
    });
    return { ok: true, data: result };
  }

  /**
   * 4B. Send Insurance reminder using template "vehicle_insurance"
   */
  @Post('send-insurance-reminder')
  @UseGuards(TenantAuthGuard)
  async sendInsuranceReminder(
    @Body()
    body: {
      to?: string;
      customerName?: string;
      vehiclePlate?: string;
      expiryDate?: string;
      policyNumber?: string;
      insurerName?: string;
      centreName?: string;
      ownerName?: string;
      contactNumber?: string;
    },
  ) {
    if (!body?.to || !body?.vehiclePlate) {
      throw new BadRequestException('Recipient "to" and "vehiclePlate" are required');
    }
    const result = await this.whatsappService.sendInsuranceReminder({
      to: body.to,
      customerName: body.customerName || 'Customer',
      vehiclePlate: body.vehiclePlate,
      expiryDate: body.expiryDate || 'Soon',
      policyNumber: body.policyNumber || 'N/A',
      insurerName: body.insurerName || 'Insurance Company',
      centreName: body.centreName || 'PUC Centre',
      ownerName: body.ownerName || 'Centre Owner',
      contactNumber: body.contactNumber || 'Contact Office',
    });
    return { ok: true, data: result };
  }

  /**
   * 5. List Meta WhatsApp templates
   */
  @Get('templates')
  @UseGuards(TenantAuthGuard)
  async listTemplates() {
    const templates = await this.whatsappService.listTemplates();
    return { ok: true, data: templates };
  }

  /**
   * 6. Configuration status
   */
  @Get('status')
  getStatus() {
    const isConfigured = Boolean(
      process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID,
    );
    return {
      ok: true,
      configured: isConfigured,
      phoneNumber: process.env.WHATSAPP_PHONE_NUMBER || null,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
      defaultTemplate: process.env.WHATSAPP_TEMPLATE_NAME || 'puc_certificate_utility',
      insuranceTemplate: process.env.WHATSAPP_INSURANCE_TEMPLATE_NAME || 'vehicle_insurance',
      language: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
    };
  }

  /**
   * 7. Recent automated & manual WhatsApp dispatch logs + today's quota usage
   */
  @Get('logs')
  @UseGuards(TenantAuthGuard)
  async listLogs(@Req() req: AuthenticatedRequest, @Query('limit') limitStr?: string) {
    const tenantId = req.auth!.tenantId;
    const todayIst = getIstDateString();
    const limit = Math.min(100, Math.max(5, Number(limitStr) || 25));

    const tenant = await this.db.queryOne<TenantRow>(`SELECT * FROM tenants WHERE id = ?`, [tenantId]);
    const counts = await this.db.queryOne<{ sent_today: number; failed_today: number }>(
      `SELECT
        SUM(CASE WHEN status = 'sent' AND slot_time != 'manual' THEN 1 ELSE 0 END) as sent_today,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_today
       FROM whatsapp_logs
       WHERE tenant_id = ? AND dispatch_date_ist = ?`,
      [tenantId, todayIst],
    );

    const items = await this.db.query<Record<string, unknown>>(
      `SELECT wl.*, c.full_name as customer_name, v.registration_number
       FROM whatsapp_logs wl
       LEFT JOIN customers c ON c.id = wl.customer_id
       LEFT JOIN vehicles v ON v.id = wl.vehicle_id
       WHERE wl.tenant_id = ?
       ORDER BY wl.created_at DESC
       LIMIT ?`,
      [tenantId, limit],
    );

    const sentToday = Number(counts?.sent_today || 0);
    let deliveryTimes: string[] = ['10:00'];
    try {
      const parsed = JSON.parse(tenant?.delivery_times || '["10:00"]');
      if (Array.isArray(parsed) && parsed.length > 0) deliveryTimes = parsed;
    } catch {}

    return {
      ok: true,
      summary: {
        messagesEnabled: toBool(tenant?.messages_enabled ?? true),
        sentToday,
        failedToday: Number(counts?.failed_today || 0),
        frequencyCount: Number(tenant?.delivery_frequency_count || 1),
        deliveryTimes,
        todayIst,
        unlimited: true,
      },
      items,
    };
  }

  /**
   * 8. Trigger the Settings-driven WhatsApp Engine on demand for this PUC centre
   */
  @Post('run-now')
  @UseGuards(TenantAuthGuard)
  async runEngineNow(
    @Body() body: { forceImmediate?: boolean },
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.reminderEngine.runWhatsAppSchedulerCycle(req.auth!.tenantId, {
      forceImmediate: Boolean(body?.forceImmediate),
    });
    return { ok: true, ...result };
  }

  /**
   * 9. Per-customer Settings-driven schedule preview (filterable by rule like 7d Before & Sent/Not Sent)
   */
  @Get('schedule-preview')
  @UseGuards(TenantAuthGuard)
  async getSchedulePreview(@Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    const istParts = getIstParts(new Date());
    const todayIst = istParts.dateStr;
    const nowTimeIst = `${String(istParts.hour).padStart(2, '0')}:${String(istParts.minute).padStart(2, '0')}`;

    const tenant = await this.db.queryOne<TenantRow>(`SELECT * FROM tenants WHERE id = ?`, [tenantId]);
    const messagesEnabled = toBool(tenant?.messages_enabled ?? true);
    const freqCount = Math.min(24, Math.max(1, Number(tenant?.delivery_frequency_count || 1)));

    let deliveryTimes: string[] = ['10:00'];
    try {
      const parsed = JSON.parse(tenant?.delivery_times || '["10:00"]');
      if (Array.isArray(parsed)) {
        const valid = parsed.map((t) => String(t || '').trim()).filter((t) => /^\d{2}:\d{2}$/.test(t));
        if (valid.length > 0) deliveryTimes = Array.from(new Set(valid.slice(0, freqCount))).sort();
      }
    } catch {}

    const parseNums = (raw: string | undefined, fallback: number[]) => {
      if (!raw) return fallback;
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : fallback;
      } catch {
        return fallback;
      }
    };

    const daysBefore = Array.from(new Set(parseNums(tenant?.remind_days_before, [7, 3, 0]))).sort((a, b) => b - a);
    const daysAfter = Array.from(new Set(parseNums(tenant?.remind_days_after, [1, 3]))).sort((a, b) => a - b);

    const rules = [
      ...daysBefore.map((d) => ({
        key: d === 0 ? 'on_expiry_0' : `before_${d}`,
        offset: Math.abs(d),
        label: d === 0 ? 'On Expiry (0d)' : `${d}d Before`,
      })),
      ...daysAfter.map((d) => ({
        key: `after_${d}`,
        offset: -Math.abs(d),
        label: `${d}d Overdue`,
      })),
    ];

    const pucRows = await this.db.query<{
      entity_id: string;
      customer_id: string;
      full_name: string;
      mobile_number: string;
      status: string;
      consent_given: number | boolean;
      reminders_enabled: number | boolean;
      registration_number: string;
      expiry_date: string;
    }>(
      `SELECT pc.id as entity_id, c.id as customer_id, c.full_name, c.mobile_number,
              c.status, c.consent_given, c.reminders_enabled, v.registration_number, pc.expiry_date
       FROM puc_certificates pc
       INNER JOIN customers c ON c.id = pc.customer_id
       INNER JOIN vehicles v ON v.id = pc.vehicle_id
       WHERE pc.tenant_id = ? AND pc.is_current = ? AND pc.cycle_status != 'renewed'
         AND pc.deleted_at IS NULL AND c.deleted_at IS NULL AND v.deleted_at IS NULL`,
      [tenantId, true],
    );

    const insRows = await this.db.query<{
      entity_id: string;
      customer_id: string;
      full_name: string;
      mobile_number: string;
      status: string;
      consent_given: number | boolean;
      reminders_enabled: number | boolean;
      registration_number: string;
      expiry_date: string;
    }>(
      `SELECT vi.id as entity_id, c.id as customer_id, c.full_name, c.mobile_number,
              c.status, c.consent_given, c.reminders_enabled, v.registration_number, vi.expiry_date
       FROM vehicle_insurances vi
       INNER JOIN customers c ON c.id = vi.customer_id
       INNER JOIN vehicles v ON v.id = vi.vehicle_id
       WHERE vi.tenant_id = ? AND vi.status = 'active'
         AND vi.deleted_at IS NULL AND c.deleted_at IS NULL AND v.deleted_at IS NULL`,
      [tenantId],
    );

    const logRows = await this.db.query<{
      entity_type: string;
      entity_id: string;
      dispatch_date_ist: string;
      slot_time: string;
      status: string;
      error_message: string | null;
      created_at: string;
    }>(
      `SELECT entity_type, entity_id, dispatch_date_ist, slot_time, status, error_message, created_at
       FROM whatsapp_logs
       WHERE tenant_id = ? AND slot_time != 'manual'
       ORDER BY created_at DESC`,
      [tenantId],
    );

    const logIndex = new Map<string, typeof logRows>();
    for (const row of logRows) {
      const k = `${row.entity_type}|${row.entity_id}|${row.dispatch_date_ist}`;
      const list = logIndex.get(k) || [];
      list.push(row);
      logIndex.set(k, list);
    }

    const targets = [
      ...pucRows.map((r) => ({ ...r, entityType: 'puc' as const })),
      ...insRows.map((r) => ({ ...r, entityType: 'insurance' as const })),
    ];

    const items: Array<{
      id: string;
      customerId: string;
      customerName: string;
      mobileNumber: string;
      vehiclePlate: string;
      entityType: 'puc' | 'insurance';
      expiryDate: string;
      ruleKey: string;
      ruleLabel: string;
      offsetDays: number;
      scheduledDateIst: string;
      scheduledTimes: string[];
      daysUntilScheduled: number;
      status: 'sent' | 'not_sent' | 'failed' | 'paused';
      statusLabel: string;
      sentSlots: string[];
      lastSentAt: string | null;
      lastError: string | null;
    }> = [];

    for (const target of targets) {
      if (!target.expiry_date) continue;
      const isEligible =
        target.status === 'active' && toBool(target.consent_given) && toBool(target.reminders_enabled);

      for (const rule of rules) {
        const scheduledDateIst = addDaysToDateStr(target.expiry_date, -rule.offset);
        const daysUntilScheduled = diffDays(todayIst, scheduledDateIst);
        const matchedLogs = logIndex.get(`${target.entityType}|${target.entity_id}|${scheduledDateIst}`) || [];

        const sentLogs = matchedLogs.filter((l) => l.status === 'sent');
        const failedLogs = matchedLogs.filter((l) => l.status === 'failed');
        const sentSlots = Array.from(new Set(sentLogs.map((l) => l.slot_time)));
        const allSlotsSent =
          sentSlots.length > 0 && deliveryTimes.every((slot) => sentSlots.includes(slot));

        let status: 'sent' | 'not_sent' | 'failed' | 'paused' = 'not_sent';
        let statusLabel = 'Scheduled';

        if (!isEligible) {
          status = 'paused';
          statusLabel = target.status === 'opted_out' ? 'Opted Out' : 'Customer Paused';
        } else if (allSlotsSent) {
          status = 'sent';
          statusLabel = 'Sent';
        } else if (sentSlots.length > 0) {
          status = 'sent';
          statusLabel = `Sent (${sentSlots.length}/${deliveryTimes.length})`;
        } else if (failedLogs.length > 0) {
          status = 'failed';
          statusLabel = 'Failed';
        } else if (!messagesEnabled) {
          status = 'not_sent';
          statusLabel = 'Paused in Settings';
        } else if (daysUntilScheduled === 0) {
          status = 'not_sent';
          statusLabel = 'Due Today';
        } else if (daysUntilScheduled > 0) {
          status = 'not_sent';
          statusLabel = 'Upcoming';
        } else {
          status = 'not_sent';
          statusLabel = 'Not Sent (Past)';
        }

        items.push({
          id: `${target.entityType}:${target.entity_id}:${rule.key}`,
          customerId: target.customer_id,
          customerName: target.full_name,
          mobileNumber: target.mobile_number,
          vehiclePlate: target.registration_number,
          entityType: target.entityType,
          expiryDate: target.expiry_date,
          ruleKey: rule.key,
          ruleLabel: rule.label,
          offsetDays: rule.offset,
          scheduledDateIst,
          scheduledTimes: deliveryTimes,
          daysUntilScheduled,
          status,
          statusLabel,
          sentSlots,
          lastSentAt: sentLogs[0]?.created_at || null,
          lastError: failedLogs[0]?.error_message || null,
        });
      }
    }

    // Sort: Due today first, then upcoming soonest ascending, then recent past descending
    items.sort((a, b) => {
      const rank = (d: number) => (d === 0 ? 0 : d > 0 ? 1 : 2);
      const ra = rank(a.daysUntilScheduled);
      const rb = rank(b.daysUntilScheduled);
      if (ra !== rb) return ra - rb;
      if (ra === 1) return a.daysUntilScheduled - b.daysUntilScheduled;
      if (ra === 2) return b.daysUntilScheduled - a.daysUntilScheduled;
      return a.customerName.localeCompare(b.customerName);
    });

    return {
      ok: true,
      todayIst,
      nowTimeIst,
      messagesEnabled,
      deliveryTimes,
      rules,
      counts: {
        total: items.length,
        sent: items.filter((i) => i.status === 'sent').length,
        notSent: items.filter((i) => i.status === 'not_sent').length,
        failed: items.filter((i) => i.status === 'failed').length,
        dueToday: items.filter((i) => i.daysUntilScheduled === 0).length,
      },
      items,
    };
  }
}
