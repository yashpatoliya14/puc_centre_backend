import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import crypto from 'crypto';
import { Queue, Worker } from 'bullmq';
import { DatabaseService } from '../../db/database.service';
import { CallingService, renderVoiceTemplate } from '../telephony/calling.service';
import { AuditService } from '../audit/audit.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import {
  computeReminderScheduledIso,
  diffDays,
  formatReadableDate,
  getIstDateString,
  getIstParts,
  isWithinCallingWindow,
  parseHHMM,
} from '../../common/ist-date.util';
import {
  DEFAULT_ENGLISH_TEMPLATE,
  DEFAULT_GUJARATI_TEMPLATE,
  DEFAULT_HINDI_TEMPLATE,
  toBool,
  type CallStatus,
  type TenantRow,
} from '../../common/types';

interface CustomerEligibilityInput {
  status: string;
  consent_given: number | boolean;
  dnd_registered: number | boolean;
  reminders_enabled: number | boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

export function evaluateCallingEligibility(
  tenant: Pick<TenantRow, 'automation_enabled' | 'max_calls_per_customer'>,
  customer: CustomerEligibilityInput,
  currentCycleCallCount: number,
  options: { isManual?: boolean; isCampaign?: boolean } = {},
): EligibilityResult {
  if (!options.isManual && !options.isCampaign && !toBool(tenant.automation_enabled)) {
    return { eligible: false, reason: 'Automation disabled for centre' };
  }
  if (customer.status === 'opted_out') {
    return { eligible: false, reason: 'Customer opted out of reminders' };
  }
  if (customer.status !== 'active') {
    return { eligible: false, reason: 'Customer account is inactive' };
  }
  if (!toBool(customer.consent_given)) {
    return { eligible: false, reason: 'Missing customer calling consent' };
  }
  if (toBool(customer.dnd_registered)) {
    return { eligible: false, reason: 'Customer registered on TRAI DND' };
  }
  if (!options.isManual && !toBool(customer.reminders_enabled)) {
    return { eligible: false, reason: 'Automated reminders disabled for customer' };
  }
  if (!options.isManual && currentCycleCallCount >= tenant.max_calls_per_customer) {
    return { eligible: false, reason: `Max calls per customer (${tenant.max_calls_per_customer}) reached` };
  }
  return { eligible: true };
}

@Injectable()
export class ReminderEngineService implements OnModuleDestroy {
  private static readonly SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

  private bullQueue: Queue | null = null;
  private bullWorker: Worker | null = null;
  private schedulerInterval: NodeJS.Timeout | null = null;
  private startupWhatsAppTimer: NodeJS.Timeout | null = null;
  private nextWhatsAppWakeupTimer: NodeJS.Timeout | null = null;
  private cachedWhatsAppSlots = new Map<string, string[]>();
  private whatsappCycleRunning = false;
  private runningWhatsAppTenants = new Set<string>();
  private simulatedTimers = new Set<NodeJS.Timeout>();

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CallingService) private readonly callingService: CallingService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(WhatsAppService) private readonly whatsappService: WhatsAppService,
  ) {}

  startBackgroundLoops(): void {
    const redisUrl = process.env.REDIS_URL?.trim();
    if (redisUrl) {
      try {
        const parsed = new URL(redisUrl);
        const connection = {
          host: parsed.hostname,
          port: Number(parsed.port) || 6379,
          password: parsed.password || undefined,
          maxRetriesPerRequest: null,
        };
        this.bullQueue = new Queue('pucflow-calls', { connection });
        this.bullWorker = new Worker(
          'pucflow-calls',
          async (job) => {
            const { callJobId } = job.data as { callJobId: string };
            await this.executeCallJob(callJobId, { ignoreWindow: false });
          },
          { connection, concurrency: 5 },
        );
        console.log('[ReminderEngine] BullMQ + Redis worker started.');
      } catch (err) {
        console.warn('[ReminderEngine] Redis unavailable, using in-process queue:', err instanceof Error ? err.message : String(err));
      }
    }

    if (!this.schedulerInterval) {
      // Background DB sync runs once every 4 hours (instead of every 60s) to minimize API/DB calls;
      // exact WhatsApp dispatch uses targeted single-shot timers to each configured IST slot.
      this.schedulerInterval = setInterval(() => {
        this.runSchedulerCycle(undefined, { ignoreWindow: false }).catch((err) => {
          console.error('[ReminderEngine] Background tick failed:', err);
        });
        this.runWhatsAppSchedulerCycle(undefined, { ignoreWindow: false }).catch((err) => {
          console.error('[ReminderEngine] WhatsApp 4-hour sync tick failed:', err);
        });
      }, ReminderEngineService.SYNC_INTERVAL_MS);
    }

    if (!this.startupWhatsAppTimer) {
      this.startupWhatsAppTimer = setTimeout(() => {
        this.startupWhatsAppTimer = null;
        this.runWhatsAppSchedulerCycle(undefined, { ignoreWindow: false }).catch((err) => {
          console.error('[ReminderEngine] Initial WhatsApp tick failed:', err);
        });
      }, 5_000);
    }
  }

  private scheduleNextWhatsAppWakeup(now: Date = new Date()): void {
    if (this.nextWhatsAppWakeupTimer) {
      clearTimeout(this.nextWhatsAppWakeupTimer);
      this.nextWhatsAppWakeupTimer = null;
    }

    const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
    const istDate = new Date(istMs);
    const nowSecs =
      istDate.getUTCHours() * 3600 + istDate.getUTCMinutes() * 60 + istDate.getUTCSeconds();

    let minDelaySecs = ReminderEngineService.SYNC_INTERVAL_MS / 1000;
    for (const slots of this.cachedWhatsAppSlots.values()) {
      for (const slot of slots) {
        // Wake 5s after HH:mm:00 IST so we land cleanly inside [HH:mm, HH:mm + 5m)
        const targetSecs = parseHHMM(slot) * 60 + 5;
        const delta =
          targetSecs > nowSecs ? targetSecs - nowSecs : 86400 - nowSecs + targetSecs;
        if (delta < minDelaySecs) {
          minDelaySecs = delta;
        }
      }
    }

    const delayMs = Math.max(5_000, Math.min(ReminderEngineService.SYNC_INTERVAL_MS, minDelaySecs * 1000));
    this.nextWhatsAppWakeupTimer = setTimeout(() => {
      this.nextWhatsAppWakeupTimer = null;
      this.runWhatsAppSchedulerCycle(undefined, { ignoreWindow: false }).catch((err) => {
        console.error('[ReminderEngine] Scheduled slot WhatsApp wakeup failed:', err);
      });
    }, delayMs);
  }

  async refreshScheduleForTenant(tenantId: string, messagesEnabled: boolean, deliveryTimes: string[]): Promise<void> {
    if (messagesEnabled && deliveryTimes.length > 0) {
      this.cachedWhatsAppSlots.set(tenantId, deliveryTimes);
    } else {
      this.cachedWhatsAppSlots.delete(tenantId);
    }
    this.scheduleNextWhatsAppWakeup(new Date());
  }

  getQueueMode(): 'bullmq-redis' | 'in-process' {
    return this.bullQueue ? 'bullmq-redis' : 'in-process';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerInterval) clearInterval(this.schedulerInterval);
    if (this.startupWhatsAppTimer) clearTimeout(this.startupWhatsAppTimer);
    if (this.nextWhatsAppWakeupTimer) clearTimeout(this.nextWhatsAppWakeupTimer);
    for (const timer of this.simulatedTimers) clearTimeout(timer);
    this.simulatedTimers.clear();
    if (this.bullWorker) await this.bullWorker.close().catch(() => {});
    if (this.bullQueue) await this.bullQueue.close().catch(() => {});
  }

  /**
   * Generates idempotent reminder_events and call_jobs for a certificate cycle based on tenant's active reminder_rules.
   * Never creates duplicate reminders for the same (tenant_id, certificate_id, reminder_rule_id).
   */
  async generateScheduleForCertificate(
    tenantId: string,
    customerId: string,
    certificateId: string,
    expiryDate: string,
    options: { now?: Date } = {},
  ): Promise<{ createdEvents: number; createdJobs: number }> {
    const tenant = await this.db.queryOne<TenantRow>(
      `SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL`,
      [tenantId],
    );
    if (!tenant) return { createdEvents: 0, createdJobs: 0 };

    const rules = await this.db.query<{
      id: string;
      label: string;
      offset_days: number;
      is_active: number | boolean;
    }>(
      `SELECT id, label, offset_days, is_active FROM reminder_rules
       WHERE tenant_id = ? AND is_active = ? ORDER BY offset_days ASC`,
      [tenantId, true],
    );

    const now = options.now ?? new Date();
    const todayIst = getIstDateString(now);
    let createdEvents = 0;
    let createdJobs = 0;

    for (const rule of rules) {
      const existing = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM reminder_events WHERE tenant_id = ? AND certificate_id = ? AND reminder_rule_id = ?`,
        [tenantId, certificateId, rule.id],
      );
      if (existing) {
        continue; // Idempotent: never schedule the same reminder twice for the same cycle
      }

      const scheduledForIso = computeReminderScheduledIso(expiryDate, rule.offset_days, tenant.default_call_time);
      const scheduledDateIst = getIstDateString(new Date(scheduledForIso));

      // Skip reminders that are more than 14 days stale in the past
      const diffMs = now.getTime() - new Date(scheduledForIso).getTime();
      const isTooOld = diffMs > 14 * 24 * 60 * 60 * 1000 && scheduledDateIst < todayIst;
      if (isTooOld) continue;

      const eventId = crypto.randomUUID();
      const nowIso = now.toISOString();
      await this.db.execute(
        `INSERT INTO reminder_events (id, tenant_id, customer_id, certificate_id, reminder_rule_id, offset_days, scheduled_for, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        [eventId, tenantId, customerId, certificateId, rule.id, rule.offset_days, scheduledForIso, nowIso, nowIso],
      );
      createdEvents++;

      // Create corresponding idempotent call_job
      const idempotencyKey = `rem:${tenantId}:${certificateId}:${rule.id}`;
      const existingJob = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM call_jobs WHERE idempotency_key = ?`,
        [idempotencyKey],
      );
      if (!existingJob) {
        const jobId = crypto.randomUUID();
        await this.db.execute(
          `INSERT INTO call_jobs (id, tenant_id, reminder_event_id, customer_id, certificate_id, idempotency_key, attempt_number, max_attempts, next_run_at, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'scheduled', ?, ?)`,
          [jobId, tenantId, eventId, customerId, certificateId, idempotencyKey, tenant.max_attempts, scheduledForIso, nowIso, nowIso],
        );
        createdJobs++;
      }
    }

    return { createdEvents, createdJobs };
  }

  /**
   * Cancels all pending/scheduled/retrying reminders and jobs for a certificate cycle
   * (called when a customer renews early or when an expiry date is modified).
   */
  async cancelPendingForCertificate(tenantId: string, certificateId: string, reason: string): Promise<{ cancelledEvents: number; cancelledJobs: number }> {
    const nowIso = new Date().toISOString();
    const ev = await this.db.execute(
      `UPDATE reminder_events
       SET status = 'cancelled', skip_reason = ?, updated_at = ?
       WHERE tenant_id = ? AND certificate_id = ? AND status IN ('scheduled', 'queued')`,
      [reason, nowIso, tenantId, certificateId],
    );
    const jb = await this.db.execute(
      `UPDATE call_jobs
       SET status = 'cancelled', last_error = ?, updated_at = ?
       WHERE tenant_id = ? AND certificate_id = ? AND status IN ('scheduled', 'queued', 'retrying')`,
      [reason, nowIso, tenantId, certificateId],
    );
    return { cancelledEvents: ev.rowCount, cancelledJobs: jb.rowCount };
  }

  /**
   * When a certificate's expiry date changes, cancel stale scheduled jobs and delete un-dispatched
   * events so fresh rules can be scheduled cleanly for the new date.
   */
  async rescheduleOnExpiryChange(
    tenantId: string,
    customerId: string,
    certificateId: string,
    newExpiryDate: string,
  ): Promise<{ cancelledJobs: number; createdJobs: number }> {
    const cancelled = await this.cancelPendingForCertificate(tenantId, certificateId, 'Certificate expiry date updated');
    // Remove cancelled (never-dispatched) reminder_events & cancelled call_jobs so unique constraints allow clean regeneration
    await this.db.execute(
      `DELETE FROM call_jobs WHERE tenant_id = ? AND certificate_id = ? AND status = 'cancelled'`,
      [tenantId, certificateId],
    );
    await this.db.execute(
      `DELETE FROM reminder_events WHERE tenant_id = ? AND certificate_id = ? AND status = 'cancelled'`,
      [tenantId, certificateId],
    );
    const generated = await this.generateScheduleForCertificate(tenantId, customerId, certificateId, newExpiryDate);
    return { cancelledJobs: cancelled.cancelledJobs, createdJobs: generated.createdJobs };
  }

  /**
   * Periodic scheduler tick: checks due call_jobs and dispatches eligible ones.
   */
  async runSchedulerCycle(
    tenantIdFilter?: string,
    options: { ignoreWindow?: boolean; now?: Date } = {},
  ): Promise<{ scanned: number; dispatched: number; skipped: number; deferredWindow: number }> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    const tenants = tenantIdFilter
      ? await this.db.query<TenantRow>(`SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL`, [tenantIdFilter])
      : await this.db.query<TenantRow>(`SELECT * FROM tenants WHERE deleted_at IS NULL`);

    let scanned = 0;
    let dispatched = 0;
    let skipped = 0;
    let deferredWindow = 0;

    for (const tenant of tenants) {
      // Check due jobs for this tenant
      const dueJobs = await this.db.query<{
        id: string;
        reminder_event_id: string | null;
        campaign_customer_id: string | null;
        customer_id: string;
        certificate_id: string | null;
        attempt_number: number;
        max_attempts: number;
      }>(
        `SELECT id, reminder_event_id, campaign_customer_id, customer_id, certificate_id, attempt_number, max_attempts
         FROM call_jobs
         WHERE tenant_id = ? AND status IN ('scheduled', 'queued', 'retrying') AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT 50`,
        [tenant.id, nowIso],
      );

      for (const job of dueJobs) {
        scanned++;

        // Automation gate for non-campaign reminder jobs
        if (job.reminder_event_id && !toBool(tenant.automation_enabled)) {
          skipped++;
          continue;
        }

        // Calling window check in Asia/Kolkata
        const callingDays = JSON.parse(tenant.calling_days_json || '[1,2,3,4,5,6]') as number[];
        if (!options.ignoreWindow && !isWithinCallingWindow(callingDays, tenant.calling_window_start, tenant.calling_window_end, now)) {
          deferredWindow++;
          continue;
        }

        if (this.bullQueue && !options.ignoreWindow) {
          await this.db.execute(`UPDATE call_jobs SET status = 'queued', updated_at = ? WHERE id = ?`, [nowIso, job.id]);
          await this.bullQueue.add('dial', { callJobId: job.id }, { jobId: `${job.id}-a${job.attempt_number}` });
          dispatched++;
        } else {
          const outcome = await this.executeCallJob(job.id, { ignoreWindow: options.ignoreWindow, now });
          if (outcome.dispatched) dispatched++;
          else skipped++;
        }
      }
    }

    return { scanned, dispatched, skipped, deferredWindow };
  }

  private parseNumberList(raw: string | undefined, fallback: number[]): number[] {
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return fallback;
      return parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    } catch {
      return fallback;
    }
  }

  private parseDeliverySlots(rawTimes: string | undefined, countRaw: number | undefined): string[] {
    const count = Math.min(24, Math.max(1, Number(countRaw || 1)));
    let list: string[] = ['10:00'];
    if (rawTimes) {
      try {
        const parsed = JSON.parse(rawTimes);
        if (Array.isArray(parsed)) {
          const valid = parsed
            .map((t) => String(t || '').trim())
            .filter((t) => /^\d{2}:\d{2}$/.test(t));
          if (valid.length > 0) list = valid;
        }
      } catch {}
    }
    return Array.from(new Set(list.slice(0, count))).sort((a, b) => parseHHMM(a) - parseHHMM(b));
  }

  private formatDdMmYyyy(dateStr?: string | null): string {
    if (!dateStr) return 'Soon';
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
    return match ? `${match[3]}/${match[2]}/${match[1]}` : dateStr;
  }

  /**
   * Settings-driven WhatsApp Reminder Engine:
   * Evaluates messages_enabled, delivery_times/delivery_frequency_count (IST),
   * remind_days_before/remind_days_after, and daily_message_limit per tenant.
   */
  async runWhatsAppSchedulerCycle(
    tenantIdFilter?: string,
    options: { now?: Date; forceImmediate?: boolean; ignoreWindow?: boolean } = {},
  ): Promise<{
    checkedTenants: number;
    sent: number;
    failed: number;
    skipped: number;
    deferredTime: number;
    limitReached: number;
  }> {
    if (!tenantIdFilter) {
      if (this.whatsappCycleRunning) {
        return { checkedTenants: 0, sent: 0, failed: 0, skipped: 0, deferredTime: 0, limitReached: 0 };
      }
      this.whatsappCycleRunning = true;
    } else {
      // Wait briefly if this specific tenant is mid-dispatch so manual runs never silently no-op
      for (let i = 0; i < 20 && this.runningWhatsAppTenants.has(tenantIdFilter); i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
      if (this.runningWhatsAppTenants.has(tenantIdFilter)) {
        return { checkedTenants: 0, sent: 0, failed: 0, skipped: 0, deferredTime: 0, limitReached: 0 };
      }
    }

    const now = options.now ?? new Date();
    const istParts = getIstParts(now);
    const todayIst = istParts.dateStr;
    const nowMinutes = istParts.minutesSinceMidnight;

    let checkedTenants = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let deferredTime = 0;
    let limitReached = 0;

    try {
      const tenants = tenantIdFilter
        ? await this.db.query<TenantRow>(`SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL`, [tenantIdFilter])
        : await this.db.query<TenantRow>(`SELECT * FROM tenants WHERE deleted_at IS NULL`);

      for (const tenant of tenants) {
        if (this.runningWhatsAppTenants.has(tenant.id)) continue;
        this.runningWhatsAppTenants.add(tenant.id);
        try {
          checkedTenants++;
          if (toBool(tenant.is_blocked) || !toBool(tenant.messages_enabled ?? true)) {
            this.cachedWhatsAppSlots.delete(tenant.id);
            skipped++;
            continue;
          }

          const slots = this.parseDeliverySlots(tenant.delivery_times, tenant.delivery_frequency_count);
          this.cachedWhatsAppSlots.set(tenant.id, slots);
          // Only dispatch during the configured slot window [HH:mm, HH:mm + 5m) IST so already-passed times never fire immediately on customer edits
          const dueSlots = slots.filter((s) => {
            const slotMin = parseHHMM(s);
            return nowMinutes >= slotMin && nowMinutes < slotMin + 5;
          });
          const activeSlots =
            dueSlots.length > 0
              ? dueSlots
              : options.forceImmediate
                ? [slots[0] || 'immediate']
                : [];

          if (activeSlots.length === 0) {
            deferredTime++;
            continue;
          }

          const daysBefore = this.parseNumberList(tenant.remind_days_before, [7, 3, 0]);
          const daysAfter = this.parseNumberList(tenant.remind_days_after, [1, 3]);
          const offsetSet = new Set<number>([
            ...daysBefore.map((d) => Math.abs(d)),
            ...daysAfter.map((d) => -Math.abs(d)),
          ]);

          if (offsetSet.size === 0) {
            skipped++;
            continue;
          }

          type Candidate = {
            entityType: 'puc' | 'insurance';
            entityId: string;
            customerId: string;
            vehicleId: string;
            customerName: string;
            mobileNumber: string;
            vehiclePlate: string;
            expiryDate: string;
            offsetDays: number;
            policyNumber?: string;
            insurerName?: string;
          };

          const candidates: Candidate[] = [];

          const pucRows = await this.db.query<{
            entity_id: string;
            customer_id: string;
            vehicle_id: string;
            full_name: string;
            mobile_number: string;
            registration_number: string;
            expiry_date: string;
          }>(
            `SELECT pc.id as entity_id, c.id as customer_id, v.id as vehicle_id,
                    c.full_name, c.mobile_number, v.registration_number, pc.expiry_date
             FROM puc_certificates pc
             INNER JOIN customers c ON c.id = pc.customer_id
             INNER JOIN vehicles v ON v.id = pc.vehicle_id
             WHERE pc.tenant_id = ? AND pc.is_current = ? AND pc.cycle_status != 'renewed'
               AND pc.deleted_at IS NULL AND c.deleted_at IS NULL AND v.deleted_at IS NULL
               AND c.status = 'active' AND c.consent_given = ? AND c.reminders_enabled = ?`,
            [tenant.id, true, true, true],
          );

          for (const r of pucRows) {
            if (!r.expiry_date) continue;
            const daysUntil = diffDays(todayIst, r.expiry_date);
            if (!offsetSet.has(daysUntil)) continue;
            candidates.push({
              entityType: 'puc',
              entityId: r.entity_id,
              customerId: r.customer_id,
              vehicleId: r.vehicle_id,
              customerName: r.full_name,
              mobileNumber: r.mobile_number,
              vehiclePlate: r.registration_number,
              expiryDate: r.expiry_date,
              offsetDays: daysUntil,
            });
          }

          const insRows = await this.db.query<{
            entity_id: string;
            customer_id: string;
            vehicle_id: string;
            full_name: string;
            mobile_number: string;
            registration_number: string;
            expiry_date: string;
            policy_number: string;
            insurance_company: string;
          }>(
            `SELECT vi.id as entity_id, c.id as customer_id, v.id as vehicle_id,
                    c.full_name, c.mobile_number, v.registration_number, vi.expiry_date,
                    vi.policy_number, vi.insurance_company
             FROM vehicle_insurances vi
             INNER JOIN customers c ON c.id = vi.customer_id
             INNER JOIN vehicles v ON v.id = vi.vehicle_id
             WHERE vi.tenant_id = ? AND vi.status = 'active'
               AND vi.deleted_at IS NULL AND c.deleted_at IS NULL AND v.deleted_at IS NULL
               AND c.status = 'active' AND c.consent_given = ? AND c.reminders_enabled = ?`,
            [tenant.id, true, true],
          );

          for (const r of insRows) {
            if (!r.expiry_date) continue;
            const daysUntil = diffDays(todayIst, r.expiry_date);
            if (!offsetSet.has(daysUntil)) continue;
            candidates.push({
              entityType: 'insurance',
              entityId: r.entity_id,
              customerId: r.customer_id,
              vehicleId: r.vehicle_id,
              customerName: r.full_name,
              mobileNumber: r.mobile_number,
              vehiclePlate: r.registration_number,
              expiryDate: r.expiry_date,
              offsetDays: daysUntil,
              policyNumber: r.policy_number,
              insurerName: r.insurance_company,
            });
          }

          if (candidates.length === 0) {
            continue;
          }

          // Prioritize due-today (0), most recent overdue, and closest upcoming expiry
          candidates.sort((a, b) => Math.abs(a.offsetDays) - Math.abs(b.offsetDays) || a.offsetDays - b.offsetDays);

          for (const slotTime of activeSlots) {
            for (const item of candidates) {

              const alreadyHandled = await this.db.queryOne<{ id: string }>(
                `SELECT id FROM whatsapp_logs
                 WHERE tenant_id = ? AND entity_type = ? AND entity_id = ?
                   AND dispatch_date_ist = ? AND slot_time = ?`,
                [tenant.id, item.entityType, item.entityId, todayIst, slotTime],
              );
              if (alreadyHandled) continue;

              const nowIso = new Date().toISOString();
              const tplFallback =
                item.entityType === 'insurance'
                  ? process.env.WHATSAPP_INSURANCE_TEMPLATE_NAME?.trim() || 'vehicle_insurance'
                  : process.env.WHATSAPP_TEMPLATE_NAME?.trim() || 'puc_certificate_utility';

              try {
                const sendRes =
                  item.entityType === 'insurance'
                    ? await this.whatsappService.sendInsuranceReminder({
                        to: item.mobileNumber,
                        customerName: item.customerName,
                        vehiclePlate: item.vehiclePlate,
                        expiryDate: this.formatDdMmYyyy(item.expiryDate),
                        policyNumber: item.policyNumber || 'N/A',
                        insurerName: item.insurerName || 'Insurance Company',
                        centreName: tenant.business_name || 'PUC Testing Centre',
                        ownerName: tenant.owner_name || 'Centre Owner',
                        contactNumber: tenant.mobile_number || 'Helpline',
                      })
                    : await this.whatsappService.sendPucCertificateReminder({
                        to: item.mobileNumber,
                        customerName: item.customerName,
                        vehiclePlate: item.vehiclePlate,
                        expiryDate: this.formatDdMmYyyy(item.expiryDate),
                        centreName: tenant.business_name || 'PUC Testing Centre',
                        ownerName: tenant.owner_name || 'Centre Owner',
                        centreAddress: tenant.address || 'Station Road',
                        contactNumber: tenant.mobile_number || 'Helpline',
                      });

                await this.db.execute(
                  `INSERT INTO whatsapp_logs (id, tenant_id, customer_id, vehicle_id, entity_type, entity_id, reminder_offset_days, dispatch_date_ist, slot_time, template_name, phone_number, provider_message_id, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`,
                  [
                    crypto.randomUUID(),
                    tenant.id,
                    item.customerId,
                    item.vehicleId,
                    item.entityType,
                    item.entityId,
                    item.offsetDays,
                    todayIst,
                    slotTime,
                    sendRes.template,
                    item.mobileNumber,
                    sendRes.messageId,
                    nowIso,
                  ],
                );

                await this.auditService.log({
                  tenantId: tenant.id,
                  action: 'whatsapp_reminder.auto_sent',
                  entityType: 'customer',
                  entityId: item.customerId,
                  metadata: {
                    messageId: sendRes.messageId,
                    template: sendRes.template,
                    reminderType: item.entityType,
                    vehicle: item.vehiclePlate,
                    slotTime,
                    offsetDays: item.offsetDays,
                  },
                });

                sent++;
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : 'WhatsApp send failed';
                await this.db.execute(
                  `INSERT INTO whatsapp_logs (id, tenant_id, customer_id, vehicle_id, entity_type, entity_id, reminder_offset_days, dispatch_date_ist, slot_time, template_name, phone_number, status, error_message, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?)`,
                  [
                    crypto.randomUUID(),
                    tenant.id,
                    item.customerId,
                    item.vehicleId,
                    item.entityType,
                    item.entityId,
                    item.offsetDays,
                    todayIst,
                    slotTime,
                    tplFallback,
                    item.mobileNumber,
                    errMsg.slice(0, 500),
                    nowIso,
                  ],
                );

                await this.auditService.log({
                  tenantId: tenant.id,
                  action: 'whatsapp_reminder.auto_failed',
                  entityType: 'customer',
                  entityId: item.customerId,
                  metadata: {
                    error: errMsg,
                    template: tplFallback,
                    reminderType: item.entityType,
                    vehicle: item.vehiclePlate,
                    slotTime,
                  },
                });

                failed++;
              }
            }
          }
        } finally {
          this.runningWhatsAppTenants.delete(tenant.id);
        }
      }

      return { checkedTenants, sent, failed, skipped, deferredTime, limitReached };
    } finally {
      if (!tenantIdFilter) {
        this.whatsappCycleRunning = false;
        if (this.schedulerInterval) {
          this.scheduleNextWhatsAppWakeup(new Date());
        }
      }
    }
  }

  async executeCallJob(
    callJobId: string,
    options: { ignoreWindow?: boolean; now?: Date; forceMockSync?: boolean } = {},
  ): Promise<{ dispatched: boolean; reason?: string; callLogId?: string }> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    const job = await this.db.queryOne<{
      id: string;
      tenant_id: string;
      reminder_event_id: string | null;
      campaign_customer_id: string | null;
      customer_id: string;
      certificate_id: string | null;
      attempt_number: number;
      max_attempts: number;
      status: string;
    }>(`SELECT * FROM call_jobs WHERE id = ?`, [callJobId]);

    if (!job || !['scheduled', 'queued', 'retrying'].includes(job.status)) {
      return { dispatched: false, reason: 'Job is not in runnable state' };
    }

    const tenant = await this.db.queryOne<TenantRow>(
      `SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL`,
      [job.tenant_id],
    );
    if (!tenant) return { dispatched: false, reason: 'Tenant not found' };

    // If campaign job, verify campaign is running (not paused/stopped)
    let campaignId: string | null = null;
    let campaignTemplateId: string | null = null;
    if (job.campaign_customer_id) {
      const cc = await this.db.queryOne<{
        campaign_id: string;
        campaign_status: string;
        voice_template_id: string | null;
      }>(
        `SELECT cc.campaign_id, c.status as campaign_status, c.voice_template_id
         FROM campaign_customers cc
         INNER JOIN calling_campaigns c ON c.id = cc.campaign_id
         WHERE cc.id = ? AND cc.tenant_id = ?`,
        [job.campaign_customer_id, job.tenant_id],
      );
      if (!cc) return { dispatched: false, reason: 'Campaign target not found' };
      if (cc.campaign_status === 'paused') {
        return { dispatched: false, reason: 'Campaign is paused' };
      }
      if (cc.campaign_status === 'stopped') {
        await this.db.execute(`UPDATE call_jobs SET status = 'cancelled', last_error = 'Campaign stopped', updated_at = ? WHERE id = ?`, [nowIso, job.id]);
        await this.db.execute(`UPDATE campaign_customers SET status = 'cancelled', updated_at = ? WHERE id = ?`, [nowIso, job.campaign_customer_id]);
        return { dispatched: false, reason: 'Campaign stopped' };
      }
      campaignId = cc.campaign_id;
      campaignTemplateId = cc.voice_template_id;
    }

    // Verify certificate has not already been renewed
    let cert: { id: string; vehicle_id: string; expiry_date: string; cycle_status: string; is_current: number | boolean; registration_number: string } | null = null;
    if (job.certificate_id) {
      cert = await this.db.queryOne(
        `SELECT pc.id, pc.vehicle_id, pc.expiry_date, pc.cycle_status, pc.is_current, v.registration_number
         FROM puc_certificates pc
         INNER JOIN vehicles v ON v.id = pc.vehicle_id
         WHERE pc.id = ? AND pc.tenant_id = ? AND pc.deleted_at IS NULL`,
        [job.certificate_id, job.tenant_id],
      );
      if (!cert || cert.cycle_status === 'renewed' || !toBool(cert.is_current)) {
        await this.db.execute(`UPDATE call_jobs SET status = 'cancelled', last_error = 'PUC already renewed', updated_at = ? WHERE id = ?`, [nowIso, job.id]);
        if (job.reminder_event_id) {
          await this.db.execute(`UPDATE reminder_events SET status = 'cancelled', skip_reason = 'PUC already renewed', updated_at = ? WHERE id = ?`, [nowIso, job.reminder_event_id]);
        }
        return { dispatched: false, reason: 'PUC certificate already renewed' };
      }
    }

    const customer = await this.db.queryOne<{
      id: string;
      full_name: string;
      mobile_number: string;
      language: string;
      status: string;
      consent_given: number | boolean;
      dnd_registered: number | boolean;
      reminders_enabled: number | boolean;
    }>(`SELECT * FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`, [job.customer_id, job.tenant_id]);

    if (!customer) {
      await this.db.execute(`UPDATE call_jobs SET status = 'cancelled', last_error = 'Customer deleted', updated_at = ? WHERE id = ?`, [nowIso, job.id]);
      return { dispatched: false, reason: 'Customer deleted' };
    }

    const countRow = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM call_logs WHERE tenant_id = ? AND customer_id = ? AND (? IS NULL OR certificate_id = ?) AND status != 'cancelled'`,
      [job.tenant_id, customer.id, job.certificate_id, job.certificate_id],
    );
    const eligibility = evaluateCallingEligibility(tenant, customer, Number(countRow?.cnt || 0), {
      isCampaign: Boolean(job.campaign_customer_id),
    });

    if (!eligibility.eligible) {
      await this.db.execute(`UPDATE call_jobs SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ?`, [eligibility.reason || 'Ineligible', nowIso, job.id]);
      if (job.reminder_event_id) {
        await this.db.execute(`UPDATE reminder_events SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ?`, [eligibility.reason || 'Ineligible', nowIso, job.reminder_event_id]);
      }
      if (job.campaign_customer_id) {
        await this.db.execute(`UPDATE campaign_customers SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ?`, [eligibility.reason || 'Ineligible', nowIso, job.campaign_customer_id]);
      }
      return { dispatched: false, reason: eligibility.reason };
    }

    // Resolve reminder label & type
    let reminderType = campaignId ? 'campaign' : 'auto_before';
    let reminderLabel = campaignId ? 'Campaign Call' : 'Automated Reminder';
    let ruleTemplateId: string | null = campaignTemplateId;

    if (job.reminder_event_id) {
      const ev = await this.db.queryOne<{ offset_days: number; label: string; voice_template_id: string | null }>(
        `SELECT re.offset_days, rr.label, rr.voice_template_id
         FROM reminder_events re
         INNER JOIN reminder_rules rr ON rr.id = re.reminder_rule_id
         WHERE re.id = ? AND re.tenant_id = ?`,
        [job.reminder_event_id, job.tenant_id],
      );
      if (ev) {
        reminderLabel = ev.label;
        reminderType = ev.offset_days < 0 ? 'auto_before' : ev.offset_days === 0 ? 'auto_on_expiry' : 'auto_after';
        ruleTemplateId = ev.voice_template_id;
      }
    }

    const { renderedMessage, audioUrl, language } = await this.resolveRenderedVoiceMessage(
      tenant,
      customer,
      cert?.registration_number || 'Vehicle',
      cert?.expiry_date || getIstDateString(now),
      ruleTemplateId,
    );

    // Mark job processing and insert call_log BEFORE calling provider
    await this.db.execute(`UPDATE call_jobs SET status = 'processing', updated_at = ? WHERE id = ?`, [nowIso, job.id]);
    if (job.reminder_event_id) {
      await this.db.execute(`UPDATE reminder_events SET status = 'dispatched', updated_at = ? WHERE id = ?`, [nowIso, job.reminder_event_id]);
    }

    const callLogId = crypto.randomUUID();
    await this.db.execute(
      `INSERT INTO call_logs (id, tenant_id, call_job_id, customer_id, vehicle_id, certificate_id, campaign_id, reminder_type, reminder_label, phone_number, provider_name, status, rendered_message, language, initiated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mock', 'queued', ?, ?, ?, ?, ?)`,
      [
        callLogId,
        job.tenant_id,
        job.id,
        customer.id,
        cert?.vehicle_id ?? null,
        cert?.id ?? null,
        campaignId,
        reminderType,
        reminderLabel,
        customer.mobile_number,
        renderedMessage,
        language,
        nowIso,
        nowIso,
        nowIso,
      ],
    );

    const providerRes = await this.callingService.initiateCall({
      tenantId: job.tenant_id,
      callLogId,
      toPhone: customer.mobile_number,
      renderedMessage,
      language,
      audioUrl,
      customField: callLogId,
    });

    if (!providerRes.success) {
      await this.db.execute(
        `UPDATE call_logs SET provider_name = ?, status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
        [providerRes.providerName, providerRes.errorMessage || 'Provider request failed', nowIso, nowIso, callLogId],
      );
      await this.scheduleRetryOrFail(job.id, job.tenant_id, job.attempt_number, job.max_attempts, tenant.retry_interval_minutes, providerRes.errorMessage || 'Provider failure', job.campaign_customer_id, now);
      return { dispatched: true, callLogId };
    }

    // Never assume API request == delivered! Save initiated status & providerCallId; wait for webhook.
    await this.db.execute(
      `UPDATE call_logs SET provider_name = ?, provider_call_id = ?, status = ?, updated_at = ? WHERE id = ?`,
      [providerRes.providerName, providerRes.providerCallId, providerRes.initialStatus, nowIso, callLogId],
    );

    // If running in Simulated Calling Mode, fire realistic asynchronous webhook transitions
    if (providerRes.isMock && providerRes.providerCallId && !options.forceMockSync) {
      this.scheduleMockWebhookLifecycle(job.tenant_id, providerRes.providerCallId, callLogId);
    }

    return { dispatched: true, callLogId };
  }

  /**
   * Manual one-off call triggered directly by the PUC centre owner (where permitted by consent/DND).
   */
  async triggerManualCall(
    tenantId: string,
    userId: string,
    customerId: string,
    certificateId?: string | null,
    templateId?: string | null,
  ): Promise<{ callLogId: string; status: CallStatus; providerName: string; providerCallId: string | null }> {
    const tenant = await this.db.queryOne<TenantRow>(
      `SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL`,
      [tenantId],
    );
    if (!tenant) throw new Error('Tenant not found');

    const customer = await this.db.queryOne<{
      id: string;
      full_name: string;
      mobile_number: string;
      language: string;
      status: string;
      consent_given: number | boolean;
      dnd_registered: number | boolean;
      reminders_enabled: number | boolean;
    }>(`SELECT * FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`, [customerId, tenantId]);

    if (!customer) throw new Error('Customer not found');

    const eligibility = evaluateCallingEligibility(tenant, customer, 0, { isManual: true });
    if (!eligibility.eligible) {
      throw new Error(eligibility.reason || 'Customer is not eligible for calling');
    }

    const cert = certificateId
      ? await this.db.queryOne<{ id: string; vehicle_id: string; expiry_date: string; registration_number: string }>(
          `SELECT pc.id, pc.vehicle_id, pc.expiry_date, v.registration_number
           FROM puc_certificates pc INNER JOIN vehicles v ON v.id = pc.vehicle_id
           WHERE pc.id = ? AND pc.tenant_id = ?`,
          [certificateId, tenantId],
        )
      : await this.db.queryOne<{ id: string; vehicle_id: string; expiry_date: string; registration_number: string }>(
          `SELECT pc.id, pc.vehicle_id, pc.expiry_date, v.registration_number
           FROM puc_certificates pc INNER JOIN vehicles v ON v.id = pc.vehicle_id
           WHERE pc.customer_id = ? AND pc.tenant_id = ? AND pc.is_current = ? AND pc.deleted_at IS NULL
           ORDER BY pc.created_at DESC LIMIT 1`,
          [customerId, tenantId, true],
        );

    const { renderedMessage, audioUrl, language } = await this.resolveRenderedVoiceMessage(
      tenant,
      customer,
      cert?.registration_number || 'Vehicle',
      cert?.expiry_date || getIstDateString(),
      templateId ?? null,
    );

    const nowIso = new Date().toISOString();
    const callLogId = crypto.randomUUID();
    await this.db.execute(
      `INSERT INTO call_logs (id, tenant_id, customer_id, vehicle_id, certificate_id, reminder_type, reminder_label, phone_number, provider_name, status, rendered_message, language, initiated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'manual', 'Manual Owner Call', ?, 'mock', 'queued', ?, ?, ?, ?, ?)`,
      [callLogId, tenantId, customer.id, cert?.vehicle_id ?? null, cert?.id ?? null, customer.mobile_number, renderedMessage, language, nowIso, nowIso, nowIso],
    );

    const providerRes = await this.callingService.initiateCall({
      tenantId,
      callLogId,
      toPhone: customer.mobile_number,
      renderedMessage,
      language,
      audioUrl,
      customField: callLogId,
    });

    await this.db.execute(
      `UPDATE call_logs SET provider_name = ?, provider_call_id = ?, status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      [
        providerRes.providerName,
        providerRes.providerCallId,
        providerRes.initialStatus,
        providerRes.errorMessage ?? null,
        nowIso,
        callLogId,
      ],
    );

    await this.auditService.log({
      tenantId,
      userId,
      action: 'call.manual_initiated',
      entityType: 'call_log',
      entityId: callLogId,
      metadata: { customerId, providerName: providerRes.providerName, status: providerRes.initialStatus },
    });

    if (providerRes.isMock && providerRes.providerCallId) {
      this.scheduleMockWebhookLifecycle(tenantId, providerRes.providerCallId, callLogId);
    }

    return {
      callLogId,
      status: providerRes.initialStatus,
      providerName: providerRes.providerName,
      providerCallId: providerRes.providerCallId,
    };
  }

  /**
   * Processes incoming telephony provider webhooks, updates call logs, syncs campaign/reminder status,
   * and triggers controlled retries on unanswered/busy/failed attempts.
   */
  async processStatusWebhook(
    provider: string,
    payload: Record<string, unknown>,
    options: { now?: Date } = {},
  ): Promise<{ updated: boolean; callLogId?: string; status?: CallStatus; retryScheduled?: boolean }> {
    const event = this.callingService.parseWebhook(provider, payload);
    if (!event) return { updated: false };

    const log = await this.db.queryOne<{
      id: string;
      tenant_id: string;
      call_job_id: string | null;
      campaign_id: string | null;
    }>(
      `SELECT id, tenant_id, call_job_id, campaign_id FROM call_logs
       WHERE provider_call_id = ? OR id = ?
       LIMIT 1`,
      [event.providerCallId, event.customField || ''],
    );

    if (!log) return { updated: false };

    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const isTerminal = ['completed', 'no_answer', 'busy', 'failed', 'cancelled'].includes(event.status);

    await this.db.execute(
      `UPDATE call_logs
       SET status = ?, duration_seconds = CASE WHEN ? > 0 THEN ? ELSE duration_seconds END,
           recording_url = COALESCE(?, recording_url),
           error_message = COALESCE(?, error_message),
           completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
           updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        event.status,
        event.durationSeconds,
        event.durationSeconds,
        event.recordingUrl,
        event.errorMessage,
        isTerminal,
        nowIso,
        nowIso,
        log.id,
        log.tenant_id,
      ],
    );

    let retryScheduled = false;

    if (log.call_job_id && isTerminal) {
      const job = await this.db.queryOne<{
        id: string;
        reminder_event_id: string | null;
        campaign_customer_id: string | null;
        attempt_number: number;
        max_attempts: number;
      }>(`SELECT * FROM call_jobs WHERE id = ? AND tenant_id = ?`, [log.call_job_id, log.tenant_id]);

      const tenant = await this.db.queryOne<TenantRow>(`SELECT * FROM tenants WHERE id = ?`, [log.tenant_id]);

      if (job && tenant) {
        if (event.status === 'completed') {
          await this.db.execute(`UPDATE call_jobs SET status = 'completed', updated_at = ? WHERE id = ?`, [nowIso, job.id]);
          if (job.reminder_event_id) {
            await this.db.execute(`UPDATE reminder_events SET status = 'completed', updated_at = ? WHERE id = ?`, [nowIso, job.reminder_event_id]);
          }
          if (job.campaign_customer_id) {
            await this.db.execute(`UPDATE campaign_customers SET status = 'completed', updated_at = ? WHERE id = ?`, [nowIso, job.campaign_customer_id]);
          }
        } else if (['no_answer', 'busy', 'failed'].includes(event.status)) {
          retryScheduled = await this.scheduleRetryOrFail(
            job.id,
            log.tenant_id,
            job.attempt_number,
            job.max_attempts,
            tenant.retry_interval_minutes,
            `Call outcome: ${event.status}`,
            job.campaign_customer_id,
            now,
          );
        }
      }
    }

    if (log.campaign_id && isTerminal) {
      await this.recomputeCampaignStats(log.tenant_id, log.campaign_id);
    }

    return { updated: true, callLogId: log.id, status: event.status, retryScheduled };
  }

  private async scheduleRetryOrFail(
    jobId: string,
    tenantId: string,
    attemptNumber: number,
    maxAttempts: number,
    retryIntervalMinutes: number,
    reason: string,
    campaignCustomerId: string | null,
    now: Date,
  ): Promise<boolean> {
    const nowIso = now.toISOString();
    if (attemptNumber < maxAttempts) {
      // Controlled backoff: retryIntervalMinutes * attemptNumber
      const nextRunAt = new Date(now.getTime() + retryIntervalMinutes * attemptNumber * 60_000).toISOString();
      await this.db.execute(
        `UPDATE call_jobs SET status = 'retrying', attempt_number = ?, next_run_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [attemptNumber + 1, nextRunAt, reason, nowIso, jobId, tenantId],
      );
      return true;
    }

    await this.db.execute(
      `UPDATE call_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      [reason, nowIso, jobId, tenantId],
    );
    if (campaignCustomerId) {
      await this.db.execute(
        `UPDATE campaign_customers SET status = 'failed', skip_reason = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
        [reason, nowIso, campaignCustomerId, tenantId],
      );
    }
    return false;
  }

  async recomputeCampaignStats(tenantId: string, campaignId: string): Promise<void> {
    const stats = await this.db.queryOne<{ total: number; completed: number; failed: number; remaining: number }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status IN ('failed', 'skipped') THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status IN ('pending', 'queued') THEN 1 ELSE 0 END) as remaining
       FROM campaign_customers
       WHERE tenant_id = ? AND campaign_id = ?`,
      [tenantId, campaignId],
    );
    if (!stats) return;

    const current = await this.db.queryOne<{ status: string }>(
      `SELECT status FROM calling_campaigns WHERE id = ? AND tenant_id = ?`,
      [campaignId, tenantId],
    );
    const nextStatus =
      current?.status === 'running' && Number(stats.remaining || 0) === 0 && Number(stats.total || 0) > 0
        ? 'completed'
        : current?.status || 'draft';

    await this.db.execute(
      `UPDATE calling_campaigns
       SET total_targets = ?, completed_count = ?, failed_count = ?, status = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [Number(stats.total || 0), Number(stats.completed || 0), Number(stats.failed || 0), nextStatus, new Date().toISOString(), campaignId, tenantId],
    );
  }

  private async resolveRenderedVoiceMessage(
    tenant: TenantRow,
    customer: { full_name: string; language: string },
    vehicleNumber: string,
    expiryDate: string,
    preferredTemplateId: string | null,
  ): Promise<{ renderedMessage: string; audioUrl: string | null; language: string }> {
    const lang = customer.language || tenant.default_language || 'gu';
    let tpl: { script_body: string; audio_url: string | null; language: string } | null = null;

    if (preferredTemplateId) {
      tpl = await this.db.queryOne(
        `SELECT script_body, audio_url, language FROM voice_templates WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
        [preferredTemplateId, tenant.id],
      );
    }
    if (!tpl) {
      tpl = await this.db.queryOne(
        `SELECT script_body, audio_url, language FROM voice_templates
         WHERE tenant_id = ? AND language = ? AND deleted_at IS NULL
         ORDER BY is_default DESC, created_at ASC LIMIT 1`,
        [tenant.id, lang],
      );
    }

    const fallbackScript =
      lang === 'gu' ? DEFAULT_GUJARATI_TEMPLATE : lang === 'hi' ? DEFAULT_HINDI_TEMPLATE : DEFAULT_ENGLISH_TEMPLATE;

    const renderedMessage = renderVoiceTemplate(tpl?.script_body || fallbackScript, {
      customer_name: customer.full_name,
      vehicle_number: vehicleNumber,
      expiry_date: formatReadableDate(expiryDate),
      centre_name: tenant.business_name,
      contact_number: tenant.mobile_number,
    });

    return {
      renderedMessage,
      audioUrl: tpl?.audio_url ?? null,
      language: tpl?.language || lang,
    };
  }

  private scheduleMockWebhookLifecycle(_tenantId: string, providerCallId: string, callLogId: string): void {
    const t1 = setTimeout(() => {
      this.simulatedTimers.delete(t1);
      this.processStatusWebhook('mock', { CallSid: providerCallId, CustomField: callLogId, Status: 'ringing' }).catch(() => {});
    }, 900);

    const t2 = setTimeout(() => {
      this.simulatedTimers.delete(t2);
      this.processStatusWebhook('mock', { CallSid: providerCallId, CustomField: callLogId, Status: 'answered' }).catch(() => {});
    }, 2200);

    const t3 = setTimeout(() => {
      this.simulatedTimers.delete(t3);
      // 82% completed, 12% no_answer, 6% busy for realistic operational feel
      const roll = Math.random();
      const terminalStatus = roll < 0.82 ? 'completed' : roll < 0.94 ? 'no-answer' : 'busy';
      const duration = terminalStatus === 'completed' ? Math.floor(24 + Math.random() * 28) : 0;
      this.processStatusWebhook('mock', {
        CallSid: providerCallId,
        CustomField: callLogId,
        Status: terminalStatus,
        ConversationDuration: duration,
      }).catch(() => {});
    }, 4000);

    this.simulatedTimers.add(t1);
    this.simulatedTimers.add(t2);
    this.simulatedTimers.add(t3);
  }
}
