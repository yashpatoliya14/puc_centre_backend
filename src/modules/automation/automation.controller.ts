import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
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
import type { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { DatabaseService } from '../../db/database.service';
import { TenantAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { ReminderEngineService } from '../reminders/reminder-engine.service';
import { CallingService } from '../telephony/calling.service';
import { AuditService } from '../audit/audit.service';
import { getIstDateString } from '../../common/ist-date.util';
import { toBool } from '../../common/types';

const AUDIO_UPLOAD_DIR = path.resolve(process.cwd(), 'data/uploads/audio');

const ruleSchema = z.object({
  label: z.string().min(2).max(100),
  offsetDays: z.number().int().min(-90).max(90),
  isActive: z.boolean().optional().default(true),
  voiceTemplateId: z.string().optional().nullable(),
});

const templateSchema = z.object({
  name: z.string().min(2).max(120),
  language: z.enum(['gu', 'hi', 'en']),
  scriptBody: z.string().min(10).max(1500),
  dltTemplateId: z.string().max(80).optional().nullable(),
  approvalStatus: z.enum(['draft', 'pending_approval', 'approved']).optional().default('approved'),
  isDefault: z.boolean().optional().default(false),
});

const campaignSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(400).optional().nullable(),
  voiceTemplateId: z.string().optional().nullable(),
  expiryRangeStart: z.string().optional().nullable(),
  expiryRangeEnd: z.string().optional().nullable(),
  scheduledAt: z.string().optional().nullable(),
  customerIds: z.array(z.string()).optional(),
});

@Controller('api')
export class AutomationController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ReminderEngineService) private readonly reminderEngine: ReminderEngineService,
    @Inject(CallingService) private readonly callingService: CallingService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  // =========================================================================
  // REMINDER RULES
  // =========================================================================

  @Get('reminder-rules')
  @UseGuards(TenantAuthGuard)
  async listRules(@Req() req: AuthenticatedRequest) {
    const rows = await this.db.query<{
      id: string;
      label: string;
      offset_days: number;
      is_active: number | boolean;
      sort_order: number;
      voice_template_id: string | null;
      template_name: string | null;
    }>(
      `SELECT rr.*, vt.name as template_name
       FROM reminder_rules rr
       LEFT JOIN voice_templates vt ON vt.id = rr.voice_template_id
       WHERE rr.tenant_id = ?
       ORDER BY rr.offset_days ASC`,
      [req.auth!.tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      offsetDays: r.offset_days,
      isActive: toBool(r.is_active),
      sortOrder: r.sort_order,
      voiceTemplateId: r.voice_template_id,
      templateName: r.template_name,
    }));
  }

  @Post('reminder-rules')
  @UseGuards(TenantAuthGuard)
  async createRule(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = ruleSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid reminder rule');
    }
    const tenantId = req.auth!.tenantId;
    const countRow = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM reminder_rules WHERE tenant_id = ?`,
      [tenantId],
    );
    if (Number(countRow?.cnt || 0) >= 12) {
      throw new BadRequestException('Maximum of 12 reminder rules allowed per PUC centre.');
    }

    const dup = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM reminder_rules WHERE tenant_id = ? AND offset_days = ?`,
      [tenantId, parsed.data.offsetDays],
    );
    if (dup) {
      throw new BadRequestException(`A reminder rule for offset ${parsed.data.offsetDays} days already exists.`);
    }

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO reminder_rules (id, tenant_id, label, offset_days, is_active, sort_order, voice_template_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tenantId, parsed.data.label.trim(), parsed.data.offsetDays, parsed.data.isActive, parsed.data.offsetDays + 100, parsed.data.voiceTemplateId || null, nowIso, nowIso],
    );

    // Automatically schedule this new rule for existing active certificates
    if (parsed.data.isActive) {
      const activeCerts = await this.db.query<{ id: string; customer_id: string; expiry_date: string }>(
        `SELECT id, customer_id, expiry_date FROM puc_certificates WHERE tenant_id = ? AND is_current = ? AND deleted_at IS NULL`,
        [tenantId, true],
      );
      for (const c of activeCerts) {
        await this.reminderEngine.generateScheduleForCertificate(tenantId, c.customer_id, c.id, c.expiry_date);
      }
    }

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'reminder_rule.created',
      entityType: 'reminder_rule',
      entityId: id,
      metadata: { offsetDays: parsed.data.offsetDays, label: parsed.data.label },
    });

    return { id };
  }

  @Put('reminder-rules/:id')
  @UseGuards(TenantAuthGuard)
  async updateRule(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = ruleSchema.partial().safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid rule update');
    }
    const tenantId = req.auth!.tenantId;
    const existing = await this.db.queryOne<{
      id: string;
      label: string;
      offset_days: number;
      is_active: number | boolean;
      voice_template_id: string | null;
    }>(`SELECT * FROM reminder_rules WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
    if (!existing) throw new NotFoundException('Reminder rule not found');

    const label = parsed.data.label ?? existing.label;
    const offsetDays = parsed.data.offsetDays ?? existing.offset_days;
    const isActive = parsed.data.isActive ?? toBool(existing.is_active);
    const voiceTemplateId = parsed.data.voiceTemplateId !== undefined ? parsed.data.voiceTemplateId : existing.voice_template_id;

    if (offsetDays !== existing.offset_days) {
      const dup = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM reminder_rules WHERE tenant_id = ? AND offset_days = ? AND id != ?`,
        [tenantId, offsetDays, id],
      );
      if (dup) throw new BadRequestException(`Another rule already uses offset ${offsetDays} days.`);
    }

    await this.db.execute(
      `UPDATE reminder_rules SET label = ?, offset_days = ?, is_active = ?, voice_template_id = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [label, offsetDays, isActive, voiceTemplateId, new Date().toISOString(), id, tenantId],
    );

    if (!isActive) {
      // Cancel scheduled jobs for disabled rule
      await this.db.execute(
        `UPDATE call_jobs SET status = 'cancelled', last_error = 'Reminder rule disabled', updated_at = ?
         WHERE tenant_id = ? AND status IN ('scheduled', 'queued') AND reminder_event_id IN (
           SELECT id FROM reminder_events WHERE tenant_id = ? AND reminder_rule_id = ?
         )`,
        [new Date().toISOString(), tenantId, tenantId, id],
      );
    }

    return { ok: true };
  }

  @Delete('reminder-rules/:id')
  @UseGuards(TenantAuthGuard)
  async deleteRule(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    await this.db.execute(
      `UPDATE call_jobs SET status = 'cancelled', last_error = 'Reminder rule deleted', updated_at = ?
       WHERE tenant_id = ? AND status IN ('scheduled', 'queued', 'retrying') AND reminder_event_id IN (
         SELECT id FROM reminder_events WHERE tenant_id = ? AND reminder_rule_id = ?
       )`,
      [new Date().toISOString(), tenantId, tenantId, id],
    );
    await this.db.execute(`DELETE FROM reminder_rules WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
    return { ok: true };
  }

  // =========================================================================
  // SCHEDULED CALLS & MANUAL EXECUTION
  // =========================================================================

  @Get('scheduled-calls')
  @UseGuards(TenantAuthGuard)
  async listScheduledCalls(@Req() req: AuthenticatedRequest, @Query('status') statusFilter?: string) {
    const tenantId = req.auth!.tenantId;
    const conditions = ['cj.tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (statusFilter && statusFilter !== 'all') {
      conditions.push('cj.status = ?');
      params.push(statusFilter);
    } else {
      conditions.push(`cj.status IN ('scheduled', 'queued', 'retrying', 'processing', 'cancelled', 'failed')`);
    }

    const rows = await this.db.query(
      `SELECT cj.*, c.full_name as customer_name, c.mobile_number, c.language, c.reminders_enabled, c.consent_given, c.dnd_registered,
              v.registration_number, pc.expiry_date, rr.label as rule_label, cc.name as campaign_name
       FROM call_jobs cj
       INNER JOIN customers c ON c.id = cj.customer_id
       LEFT JOIN puc_certificates pc ON pc.id = cj.certificate_id
       LEFT JOIN vehicles v ON v.id = pc.vehicle_id
       LEFT JOIN reminder_events re ON re.id = cj.reminder_event_id
       LEFT JOIN reminder_rules rr ON rr.id = re.reminder_rule_id
       LEFT JOIN campaign_customers ccu ON ccu.id = cj.campaign_customer_id
       LEFT JOIN calling_campaigns cc ON cc.id = ccu.campaign_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY cj.next_run_at ASC
       LIMIT 100`,
      params,
    );
    return rows;
  }

  @Post('scheduled-calls/run-now')
  @UseGuards(TenantAuthGuard)
  async runSchedulerNow(@Body() body: { ignoreWindow?: boolean }, @Req() req: AuthenticatedRequest) {
    const result = await this.reminderEngine.runSchedulerCycle(req.auth!.tenantId, {
      ignoreWindow: body?.ignoreWindow !== false,
    });
    await this.auditService.log({
      tenantId: req.auth!.tenantId,
      userId: req.auth!.userId,
      action: 'scheduler.manual_run',
      entityType: 'call_job',
      metadata: result,
    });
    return result;
  }

  @Post('scheduled-calls/:id/dispatch')
  @UseGuards(TenantAuthGuard)
  async dispatchSingleJob(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const job = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM call_jobs WHERE id = ? AND tenant_id = ?`,
      [id, req.auth!.tenantId],
    );
    if (!job) throw new NotFoundException('Scheduled job not found');
    return this.reminderEngine.executeCallJob(job.id, { ignoreWindow: true });
  }

  @Post('scheduled-calls/:id/cancel')
  @UseGuards(TenantAuthGuard)
  async cancelScheduledCall(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const nowIso = new Date().toISOString();
    await this.db.execute(
      `UPDATE call_jobs SET status = 'cancelled', last_error = 'Cancelled by owner', updated_at = ?
       WHERE id = ? AND tenant_id = ? AND status IN ('scheduled', 'queued', 'retrying')`,
      [nowIso, id, req.auth!.tenantId],
    );
    return { ok: true };
  }

  @Post('calls/manual')
  @UseGuards(TenantAuthGuard)
  async triggerManualCall(
    @Body() body: { customerId?: string; certificateId?: string; templateId?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body?.customerId) throw new BadRequestException('customerId is required');
    try {
      return await this.reminderEngine.triggerManualCall(
        req.auth!.tenantId,
        req.auth!.userId,
        body.customerId,
        body.certificateId,
        body.templateId,
      );
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Unable to initiate call');
    }
  }

  // =========================================================================
  // CALL HISTORY & EXPORT
  // =========================================================================

  @Get('call-history')
  @UseGuards(TenantAuthGuard)
  async listCallHistory(
    @Req() req: AuthenticatedRequest,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') pageStr?: string,
    @Query('pageSize') pageSizeStr?: string,
  ) {
    const tenantId = req.auth!.tenantId;
    const page = Math.max(1, Number(pageStr) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(pageSizeStr) || 20));
    const conditions = ['cl.tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (search && search.trim()) {
      const p = `%${search.trim().toLowerCase()}%`;
      conditions.push(`(LOWER(c.full_name) LIKE ? OR LOWER(cl.phone_number) LIKE ? OR LOWER(COALESCE(v.registration_number, '')) LIKE ? OR LOWER(COALESCE(cl.provider_call_id, '')) LIKE ?)`);
      params.push(p, p, p, p);
    }
    if (status && status !== 'all') {
      conditions.push('cl.status = ?');
      params.push(status);
    }
    if (customerId) {
      conditions.push('cl.customer_id = ?');
      params.push(customerId);
    }
    if (dateFrom) {
      conditions.push('SUBSTR(CAST(cl.created_at AS TEXT), 1, 10) >= ?');
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push('SUBSTR(CAST(cl.created_at AS TEXT), 1, 10) <= ?');
      params.push(dateTo);
    }

    const where = conditions.join(' AND ');
    const base = `
      FROM call_logs cl
      INNER JOIN customers c ON c.id = cl.customer_id
      LEFT JOIN vehicles v ON v.id = cl.vehicle_id
      LEFT JOIN calling_campaigns cc ON cc.id = cl.campaign_id
    `;

    const countRow = await this.db.queryOne<{ total: number }>(`SELECT COUNT(*) as total ${base} WHERE ${where}`, params);
    const total = Number(countRow?.total || 0);

    const items = await this.db.query(
      `SELECT cl.*, c.full_name as customer_name, v.registration_number, cc.name as campaign_name
       ${base}
       WHERE ${where}
       ORDER BY cl.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    return {
      items,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  @Get('call-history/export/csv')
  @UseGuards(TenantAuthGuard)
  async exportCallHistoryCsv(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT cl.created_at, c.full_name as customer_name, cl.phone_number, v.registration_number,
              cl.duration_seconds, cl.status, cl.reminder_type, cl.reminder_label,
              cc.name as campaign_name, cl.provider_name, cl.provider_call_id
       FROM call_logs cl
       INNER JOIN customers c ON c.id = cl.customer_id
       LEFT JOIN vehicles v ON v.id = cl.vehicle_id
       LEFT JOIN calling_campaigns cc ON cc.id = cl.campaign_id
       WHERE cl.tenant_id = ?
       ORDER BY cl.created_at DESC
       LIMIT 2000`,
      [req.auth!.tenantId],
    );
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Call Date', 'Customer Name', 'Phone Number', 'Vehicle Number', 'Duration (s)', 'Status', 'Reminder Type', 'Label', 'Campaign', 'Provider', 'Provider Call ID'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [r.created_at, r.customer_name, r.phone_number, r.registration_number, r.duration_seconds, r.status, r.reminder_type, r.reminder_label, r.campaign_name, r.provider_name, r.provider_call_id]
          .map(esc)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pucflow-call-history-${getIstDateString()}.csv"`);
    res.send(lines.join('\n'));
  }

  // =========================================================================
  // VOICE TEMPLATES & AUDIO UPLOAD
  // =========================================================================

  @Get('voice-templates')
  @UseGuards(TenantAuthGuard)
  async listTemplates(@Req() req: AuthenticatedRequest) {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM voice_templates WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, language ASC, created_at ASC`,
      [req.auth!.tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      language: r.language,
      scriptBody: r.script_body,
      audioUrl: r.audio_url,
      audioFilename: r.audio_filename,
      dltTemplateId: r.dlt_template_id,
      approvalStatus: r.approval_status,
      isDefault: toBool(r.is_default),
      createdAt: r.created_at,
    }));
  }

  @Post('voice-templates')
  @UseGuards(TenantAuthGuard)
  async createTemplate(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = templateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid template');
    const tenantId = req.auth!.tenantId;
    const nowIso = new Date().toISOString();

    if (parsed.data.isDefault) {
      await this.db.execute(
        `UPDATE voice_templates SET is_default = ?, updated_at = ? WHERE tenant_id = ? AND language = ?`,
        [false, nowIso, tenantId, parsed.data.language],
      );
    }

    const id = crypto.randomUUID();
    await this.db.execute(
      `INSERT INTO voice_templates (id, tenant_id, name, language, script_body, dlt_template_id, approval_status, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tenantId, parsed.data.name.trim(), parsed.data.language, parsed.data.scriptBody.trim(), parsed.data.dltTemplateId?.trim() || null, parsed.data.approvalStatus, parsed.data.isDefault, nowIso, nowIso],
    );
    return { id };
  }

  @Put('voice-templates/:id')
  @UseGuards(TenantAuthGuard)
  async updateTemplate(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = templateSchema.partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid template update');
    const tenantId = req.auth!.tenantId;
    const existing = await this.db.queryOne<Record<string, unknown>>(
      `SELECT * FROM voice_templates WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [id, tenantId],
    );
    if (!existing) throw new NotFoundException('Voice template not found');

    const nowIso = new Date().toISOString();
    const lang = parsed.data.language ?? String(existing.language);
    const isDefault = parsed.data.isDefault ?? toBool(existing.is_default);

    if (isDefault) {
      await this.db.execute(
        `UPDATE voice_templates SET is_default = ?, updated_at = ? WHERE tenant_id = ? AND language = ?`,
        [false, nowIso, tenantId, lang],
      );
    }

    await this.db.execute(
      `UPDATE voice_templates SET name = ?, language = ?, script_body = ?, dlt_template_id = ?, approval_status = ?, is_default = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        parsed.data.name?.trim() ?? existing.name,
        lang,
        parsed.data.scriptBody?.trim() ?? existing.script_body,
        parsed.data.dltTemplateId !== undefined ? parsed.data.dltTemplateId : existing.dlt_template_id,
        parsed.data.approvalStatus ?? existing.approval_status,
        isDefault,
        nowIso,
        id,
        tenantId,
      ],
    );
    return { ok: true };
  }

  @Delete('voice-templates/:id')
  @UseGuards(TenantAuthGuard)
  async deleteTemplate(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.db.execute(
      `UPDATE voice_templates SET deleted_at = ? WHERE id = ? AND tenant_id = ?`,
      [new Date().toISOString(), id, req.auth!.tenantId],
    );
    return { ok: true };
  }

  @Post('voice-templates/:id/audio')
  @UseGuards(TenantAuthGuard)
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 8 * 1024 * 1024 } }))
  async uploadTemplateAudio(
    @Param('id') id: string,
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!file || !file.buffer) throw new BadRequestException('Audio file is required');
    const tenantId = req.auth!.tenantId;
    const existing = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM voice_templates WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [id, tenantId],
    );
    if (!existing) throw new NotFoundException('Voice template not found');

    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = ['.mp3', '.wav', '.ogg', '.webm', '.m4a'];
    if (!allowed.includes(ext)) {
      throw new BadRequestException('Only MP3, WAV, OGG, WEBM, or M4A audio files are supported');
    }

    fs.mkdirSync(AUDIO_UPLOAD_DIR, { recursive: true });
    const safeFilename = `${tenantId.slice(0, 8)}_${id.slice(0, 8)}_${Date.now()}${ext}`;
    const targetPath = path.resolve(AUDIO_UPLOAD_DIR, safeFilename);
    if (!targetPath.startsWith(AUDIO_UPLOAD_DIR + path.sep)) {
      throw new BadRequestException('Invalid file path');
    }
    fs.writeFileSync(targetPath, file.buffer);

    const audioUrl = `/api/audio/${safeFilename}`;
    await this.db.execute(
      `UPDATE voice_templates SET audio_url = ?, audio_filename = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      [audioUrl, file.originalname.slice(0, 120), new Date().toISOString(), id, tenantId],
    );
    return { ok: true, audioUrl, audioFilename: file.originalname };
  }

  @Get('audio/:filename')
  async streamAudio(@Param('filename') filename: string, @Res() res: Response) {
    if (!/^[a-zA-Z0-9_-]+\.(mp3|wav|ogg|webm|m4a)$/.test(filename)) {
      throw new BadRequestException('Invalid audio filename');
    }
    const resolved = path.resolve(AUDIO_UPLOAD_DIR, filename);
    if (!resolved.startsWith(AUDIO_UPLOAD_DIR + path.sep) || !fs.existsSync(resolved)) {
      throw new NotFoundException('Audio file not found');
    }
    res.sendFile(resolved);
  }

  // =========================================================================
  // CALLING CAMPAIGNS
  // =========================================================================

  @Get('campaigns')
  @UseGuards(TenantAuthGuard)
  async listCampaigns(@Req() req: AuthenticatedRequest) {
    return this.db.query(
      `SELECT c.*, vt.name as template_name, vt.language as template_language
       FROM calling_campaigns c
       LEFT JOIN voice_templates vt ON vt.id = c.voice_template_id
       WHERE c.tenant_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC`,
      [req.auth!.tenantId],
    );
  }

  @Get('campaigns/:id')
  @UseGuards(TenantAuthGuard)
  async getCampaign(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    const campaign = await this.db.queryOne(
      `SELECT c.*, vt.name as template_name, vt.language as template_language
       FROM calling_campaigns c
       LEFT JOIN voice_templates vt ON vt.id = c.voice_template_id
       WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL`,
      [id, tenantId],
    );
    if (!campaign) throw new NotFoundException('Campaign not found');

    const customers = await this.db.query(
      `SELECT cc.*, c.full_name, c.mobile_number, c.language, c.consent_given, c.dnd_registered,
              v.registration_number, pc.expiry_date,
              (SELECT status FROM call_logs cl WHERE cl.campaign_id = cc.campaign_id AND cl.customer_id = cc.customer_id ORDER BY cl.created_at DESC LIMIT 1) as latest_call_status,
              (SELECT duration_seconds FROM call_logs cl WHERE cl.campaign_id = cc.campaign_id AND cl.customer_id = cc.customer_id ORDER BY cl.created_at DESC LIMIT 1) as latest_call_duration
       FROM campaign_customers cc
       INNER JOIN customers c ON c.id = cc.customer_id
       LEFT JOIN puc_certificates pc ON pc.id = cc.certificate_id
       LEFT JOIN vehicles v ON v.id = pc.vehicle_id
       WHERE cc.campaign_id = ? AND cc.tenant_id = ?
       ORDER BY cc.created_at ASC`,
      [id, tenantId],
    );

    return { campaign, customers };
  }

  @Post('campaigns')
  @UseGuards(TenantAuthGuard)
  async createCampaign(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = campaignSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid campaign');
    const tenantId = req.auth!.tenantId;
    const data = parsed.data;

    let targetRows: { customer_id: string; certificate_id: string | null }[] = [];
    if (data.customerIds && data.customerIds.length > 0) {
      for (const cid of data.customerIds.slice(0, 300)) {
        const row = await this.db.queryOne<{ customer_id: string; certificate_id: string | null }>(
          `SELECT c.id as customer_id, pc.id as certificate_id
           FROM customers c
           LEFT JOIN puc_certificates pc ON pc.customer_id = c.id AND pc.is_current = ? AND pc.deleted_at IS NULL
           WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL`,
          [true, cid, tenantId],
        );
        if (row) targetRows.push(row);
      }
    } else if (data.expiryRangeStart && data.expiryRangeEnd) {
      targetRows = await this.db.query<{ customer_id: string; certificate_id: string | null }>(
        `SELECT c.id as customer_id, pc.id as certificate_id
         FROM puc_certificates pc
         INNER JOIN customers c ON c.id = pc.customer_id
         WHERE pc.tenant_id = ? AND pc.is_current = ? AND pc.deleted_at IS NULL AND c.deleted_at IS NULL
           AND pc.expiry_date BETWEEN ? AND ?
         LIMIT 300`,
        [tenantId, true, data.expiryRangeStart, data.expiryRangeEnd],
      );
    } else {
      throw new BadRequestException('Select specific customers or provide an expiry date range');
    }

    if (targetRows.length === 0) {
      throw new BadRequestException('No matching customers found for the selected criteria');
    }

    const campaignId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const initialStatus = data.scheduledAt ? 'scheduled' : 'draft';

    await this.db.execute(
      `INSERT INTO calling_campaigns (id, tenant_id, name, description, voice_template_id, expiry_range_start, expiry_range_end, scheduled_at, status, total_targets, completed_count, failed_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [campaignId, tenantId, data.name.trim(), data.description?.trim() || null, data.voiceTemplateId || null, data.expiryRangeStart || null, data.expiryRangeEnd || null, data.scheduledAt || null, initialStatus, targetRows.length, nowIso, nowIso],
    );

    const seen = new Set<string>();
    for (const t of targetRows) {
      if (seen.has(t.customer_id)) continue;
      seen.add(t.customer_id);
      await this.db.execute(
        `INSERT INTO campaign_customers (id, tenant_id, campaign_id, customer_id, certificate_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [crypto.randomUUID(), tenantId, campaignId, t.customer_id, t.certificate_id, nowIso, nowIso],
      );
    }

    await this.auditService.log({
      tenantId,
      userId: req.auth!.userId,
      action: 'campaign.created',
      entityType: 'calling_campaign',
      entityId: campaignId,
      metadata: { name: data.name, targetCount: seen.size },
    });

    return { id: campaignId, totalTargets: seen.size };
  }

  @Post('campaigns/:id/start')
  @UseGuards(TenantAuthGuard)
  async startCampaign(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.enqueueAndRunCampaign(req.auth!.tenantId, req.auth!.userId, id, 'started');
  }

  @Post('campaigns/:id/resume')
  @UseGuards(TenantAuthGuard)
  async resumeCampaign(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.enqueueAndRunCampaign(req.auth!.tenantId, req.auth!.userId, id, 'resumed');
  }

  private async enqueueAndRunCampaign(tenantId: string, userId: string, campaignId: string, actionLabel: string) {
    const campaign = await this.db.queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM calling_campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [campaignId, tenantId],
    );
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.status === 'stopped') throw new BadRequestException('Stopped campaigns cannot be resumed');

    const nowIso = new Date().toISOString();
    await this.db.execute(`UPDATE calling_campaigns SET status = 'running', updated_at = ? WHERE id = ? AND tenant_id = ?`, [
      nowIso, campaignId, tenantId,
    ]);

    const pendingTargets = await this.db.query<{
      id: string;
      customer_id: string;
      certificate_id: string | null;
    }>(
      `SELECT id, customer_id, certificate_id FROM campaign_customers
       WHERE tenant_id = ? AND campaign_id = ? AND status IN ('pending', 'queued')`,
      [tenantId, campaignId],
    );

    const tenant = await this.db.queryOne<{ max_attempts: number }>(`SELECT max_attempts FROM tenants WHERE id = ?`, [tenantId]);
    let dispatched = 0;

    for (const target of pendingTargets) {
      const idempKey = `camp:${tenantId}:${campaignId}:${target.customer_id}`;
      let job = await this.db.queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM call_jobs WHERE idempotency_key = ?`,
        [idempKey],
      );
      if (!job) {
        const jobId = crypto.randomUUID();
        await this.db.execute(
          `INSERT INTO call_jobs (id, tenant_id, campaign_customer_id, customer_id, certificate_id, idempotency_key, attempt_number, max_attempts, next_run_at, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'queued', ?, ?)`,
          [jobId, tenantId, target.id, target.customer_id, target.certificate_id, idempKey, tenant?.max_attempts || 3, nowIso, nowIso, nowIso],
        );
        job = { id: jobId, status: 'queued' };
      } else if (job.status === 'scheduled' || job.status === 'retrying') {
        await this.db.execute(`UPDATE call_jobs SET status = 'queued', next_run_at = ?, updated_at = ? WHERE id = ?`, [nowIso, nowIso, job.id]);
      }

      await this.db.execute(`UPDATE campaign_customers SET status = 'queued', updated_at = ? WHERE id = ?`, [nowIso, target.id]);
      const outcome = await this.reminderEngine.executeCallJob(job.id, { ignoreWindow: true });
      if (outcome.dispatched) dispatched++;
    }

    await this.reminderEngine.recomputeCampaignStats(tenantId, campaignId);
    await this.auditService.log({
      tenantId,
      userId,
      action: `campaign.${actionLabel}`,
      entityType: 'calling_campaign',
      entityId: campaignId,
      metadata: { dispatched },
    });

    return { ok: true, dispatched };
  }

  @Post('campaigns/:id/pause')
  @UseGuards(TenantAuthGuard)
  async pauseCampaign(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    await this.db.execute(
      `UPDATE calling_campaigns SET status = 'paused', updated_at = ? WHERE id = ? AND tenant_id = ?`,
      [new Date().toISOString(), id, tenantId],
    );
    await this.auditService.log({ tenantId, userId: req.auth!.userId, action: 'campaign.paused', entityType: 'calling_campaign', entityId: id });
    return { ok: true };
  }

  @Post('campaigns/:id/stop')
  @UseGuards(TenantAuthGuard)
  async stopCampaign(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    const nowIso = new Date().toISOString();
    await this.db.execute(
      `UPDATE calling_campaigns SET status = 'stopped', updated_at = ? WHERE id = ? AND tenant_id = ?`,
      [nowIso, id, tenantId],
    );
    await this.db.execute(
      `UPDATE campaign_customers SET status = 'cancelled', updated_at = ? WHERE campaign_id = ? AND tenant_id = ? AND status IN ('pending', 'queued')`,
      [nowIso, id, tenantId],
    );
    await this.db.execute(
      `UPDATE call_jobs SET status = 'cancelled', last_error = 'Campaign stopped', updated_at = ?
       WHERE tenant_id = ? AND status IN ('scheduled', 'queued', 'retrying') AND campaign_customer_id IN (
         SELECT id FROM campaign_customers WHERE campaign_id = ? AND tenant_id = ?
       )`,
      [nowIso, tenantId, id, tenantId],
    );
    await this.auditService.log({ tenantId, userId: req.auth!.userId, action: 'campaign.stopped', entityType: 'calling_campaign', entityId: id });
    return { ok: true };
  }

  @Delete('campaigns/:id')
  @UseGuards(TenantAuthGuard)
  async deleteCampaign(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    await this.stopCampaign(id, req);
    await this.db.execute(
      `UPDATE calling_campaigns SET deleted_at = ? WHERE id = ? AND tenant_id = ?`,
      [new Date().toISOString(), id, req.auth!.tenantId],
    );
    return { ok: true };
  }

  // =========================================================================
  // TELEPHONY WEBHOOK RECEIVER (Exotel & Mock)
  // =========================================================================

  @Post('webhooks/telephony/:provider')
  async handleTelephonyWebhook(
    @Param('provider') provider: string,
    @Body() payload: Record<string, unknown>,
    @Headers('x-exotel-signature') signatureHeader: string | undefined,
    @Req() req: Request,
  ) {
    const event = this.callingService.parseWebhook(provider, payload);
    if (!event) {
      throw new BadRequestException('Invalid telephony webhook payload');
    }

    // Look up owning tenant to validate HMAC signature
    const existingLog = await this.db.queryOne<{ tenant_id: string }>(
      `SELECT tenant_id FROM call_logs WHERE provider_call_id = ? OR id = ? LIMIT 1`,
      [event.providerCallId, event.customField || ''],
    );
    if (existingLog && provider === 'exotel') {
      const rawBody = JSON.stringify(req.body || {});
      const valid = await this.callingService.verifyWebhookSignature(existingLog.tenant_id, rawBody, signatureHeader);
      if (!valid) {
        throw new BadRequestException('Invalid webhook signature');
      }
    }

    return this.reminderEngine.processStatusWebhook(provider, payload);
  }

  // =========================================================================
  // DYNAMIC TEXT-TO-SPEECH (ExoML) VOICE ENDPOINT
  // =========================================================================

  @Get('telephony/exoml')
  async getExoML(@Query() query: Record<string, string>, @Res() res: Response) {
    const callSid = query.CallSid || query.Sid || '';
    const customField = query.CustomField || '';
    let message = 'નમસ્કાર, તમારા વાહનનું PUC પૂર્ણ થવાનું છે. સમયસર રિન્યુ કરાવી લો.';
    let lang = 'hi-IN';

    if (callSid || customField) {
      const log = await this.db.queryOne<{ rendered_message: string; language: string }>(
        `SELECT rendered_message, language FROM call_logs WHERE provider_call_id = ? OR id = ? ORDER BY created_at DESC LIMIT 1`,
        [callSid, customField],
      );
      if (log?.rendered_message) {
        message = log.rendered_message;
        if (log.language === 'en') lang = 'en-IN';
        else if (log.language === 'hi') lang = 'hi-IN';
        else lang = 'hi-IN'; // Exotel Indian voice engine
      }
    }

    const safeMessage = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman" language="${lang}">${safeMessage}</Say>
  <Hangup/>
</Response>`;
    res.set('Content-Type', 'text/xml');
    res.send(xml);
  }
}
