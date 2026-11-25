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
import { getIstDateString } from '../../common/ist-date.util';
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
}
