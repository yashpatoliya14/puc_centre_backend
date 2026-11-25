import { Inject, Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { DatabaseService } from '../../db/database.service';
import { hashPassword } from '../../common/crypto.util';
import { addDaysToDateStr, computeReminderScheduledIso, getIstDateString } from '../../common/ist-date.util';
import {
  DEFAULT_ENGLISH_TEMPLATE,
  DEFAULT_GUJARATI_TEMPLATE,
  DEFAULT_HINDI_TEMPLATE,
} from '../../common/types';

export const DEMO_EMAIL = 'owner@pucflow.in';
export const DEMO_PASSWORD = 'PucFlow@2026';
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase() || 'admin@pucflow.in';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || 'Admin@2026';

@Injectable()
export class SeedService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async createDefaultTenantResources(tenantId: string, centreName: string): Promise<{
    guTemplateId: string;
    hiTemplateId: string;
    enTemplateId: string;
    ruleIds: { offset: number; id: string; label: string }[];
  }> {
    const nowIso = new Date().toISOString();

    // Telephony configuration (Mock mode active out of the box)
    await this.db.execute(
      `INSERT INTO telephony_configurations (id, tenant_id, provider, mode, subdomain, last_test_status, created_at, updated_at)
       VALUES (?, ?, 'exotel', 'mock', 'api.in.exotel.com', 'ok:mock', ?, ?)`,
      [crypto.randomUUID(), tenantId, nowIso, nowIso],
    );

    // Notification preferences
    await this.db.execute(
      `INSERT INTO notification_preferences (id, tenant_id, call_success_alert, call_failed_alert, daily_summary, renewal_alerts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), tenantId, false, true, true, true, nowIso, nowIso],
    );

    // Voice templates (Gujarati, Hindi, English)
    const guTemplateId = crypto.randomUUID();
    const hiTemplateId = crypto.randomUUID();
    const enTemplateId = crypto.randomUUID();

    await this.db.execute(
      `INSERT INTO voice_templates (id, tenant_id, name, language, script_body, dlt_template_id, approval_status, is_default, created_at, updated_at)
       VALUES (?, ?, ?, 'gu', ?, 'DLT-GUJ-PUC-1001', 'approved', ?, ?, ?)`,
      [guTemplateId, tenantId, `${centreName} — Gujarati Renewal Reminder`, DEFAULT_GUJARATI_TEMPLATE, true, nowIso, nowIso],
    );
    await this.db.execute(
      `INSERT INTO voice_templates (id, tenant_id, name, language, script_body, dlt_template_id, approval_status, is_default, created_at, updated_at)
       VALUES (?, ?, ?, 'hi', ?, 'DLT-HIN-PUC-1002', 'approved', ?, ?, ?)`,
      [hiTemplateId, tenantId, `${centreName} — Hindi Renewal Reminder`, DEFAULT_HINDI_TEMPLATE, false, nowIso, nowIso],
    );
    await this.db.execute(
      `INSERT INTO voice_templates (id, tenant_id, name, language, script_body, dlt_template_id, approval_status, is_default, created_at, updated_at)
       VALUES (?, ?, ?, 'en', ?, 'DLT-ENG-PUC-1003', 'approved', ?, ?, ?)`,
      [enTemplateId, tenantId, `${centreName} — English Renewal Reminder`, DEFAULT_ENGLISH_TEMPLATE, false, nowIso, nowIso],
    );

    // Default 4-stage reminder rules: -7, -2, 0, +2
    const defaultRules = [
      { label: '7 days before expiry', offset: -7, sort: 1 },
      { label: '2 days before expiry', offset: -2, sort: 2 },
      { label: 'On expiry date', offset: 0, sort: 3 },
      { label: '2 days after expiry', offset: 2, sort: 4 },
    ];
    const ruleIds: { offset: number; id: string; label: string }[] = [];
    for (const r of defaultRules) {
      const id = crypto.randomUUID();
      await this.db.execute(
        `INSERT INTO reminder_rules (id, tenant_id, label, offset_days, is_active, sort_order, voice_template_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, tenantId, r.label, r.offset, true, r.sort, guTemplateId, nowIso, nowIso],
      );
      ruleIds.push({ offset: r.offset, id, label: r.label });
    }

    return { guTemplateId, hiTemplateId, enTemplateId, ruleIds };
  }

  async seedSampleCentreData(
    tenantId: string,
    userId: string,
    resources: {
      guTemplateId: string;
      ruleIds: { offset: number; id: string; label: string }[];
    },
  ): Promise<void> {
    const today = getIstDateString();
    const nowIso = new Date().toISOString();

    const sampleCustomers = [
      { name: 'Rajeshbhai Patel', phone: '+919825104211', alt: '+919825104299', reg: 'GJ-01-KD-4821', vtype: '4W', fuel: 'Petrol', certNo: 'GJ01PUC20260112', expiryOffset: 0, lang: 'gu', status: 'active', address: 'Navrangpura, Ahmedabad', notes: 'Prefers morning call before 11 AM', renewedPrev: false },
      { name: 'Kiranben Shah', phone: '+919898213455', alt: null, reg: 'GJ-01-RP-9034', vtype: '2W', fuel: 'Petrol', certNo: 'GJ01PUC20260118', expiryOffset: 0, lang: 'gu', status: 'active', address: 'Satellite, Ahmedabad', notes: 'Honda Activa 6G', renewedPrev: false },
      { name: 'Mahesh Desai', phone: '+919724088310', alt: null, reg: 'GJ-05-JM-7720', vtype: '4W', fuel: 'Diesel', certNo: 'GJ05PUC20260089', expiryOffset: 2, lang: 'gu', status: 'active', address: 'Bopal, Ahmedabad', notes: 'SUV 6-month cycle', renewedPrev: false },
      { name: 'Snehal Joshi', phone: '+919909145622', alt: null, reg: 'GJ-01-HQ-2291', vtype: '4W', fuel: 'CNG', certNo: 'GJ01PUC20260204', expiryOffset: 3, lang: 'hi', status: 'active', address: 'Prahlad Nagar, Ahmedabad', notes: 'WagonR CNG kit', renewedPrev: false },
      { name: 'Prakash Solanki', phone: '+919824556712', alt: null, reg: 'GJ-18-BC-6140', vtype: '3W', fuel: 'CNG', certNo: 'GJ18PUC20260045', expiryOffset: 5, lang: 'gu', status: 'active', address: 'Gota, Ahmedabad', notes: 'Auto rickshaw fleet', renewedPrev: false },
      { name: 'Ananya Mehta', phone: '+919879301120', alt: null, reg: 'GJ-01-WK-8812', vtype: '4W', fuel: 'Petrol', certNo: 'GJ01PUC20260290', expiryOffset: 6, lang: 'en', status: 'active', address: 'Sindhu Bhavan Road, Ahmedabad', notes: 'English voice reminder requested', renewedPrev: false },
      { name: 'Harshad Panchal', phone: '+919825619944', alt: null, reg: 'GJ-01-TC-3305', vtype: 'LCV', fuel: 'Diesel', certNo: 'GJ01PUC20250981', expiryOffset: -2, lang: 'gu', status: 'active', address: 'Naroda GIDC, Ahmedabad', notes: 'Commercial delivery tempo', renewedPrev: false },
      { name: 'Vikram Rathod', phone: '+919978440219', alt: null, reg: 'GJ-27-AA-5519', vtype: '2W', fuel: 'Petrol', certNo: 'GJ27PUC20250812', expiryOffset: -5, lang: 'hi', status: 'active', address: 'Vastral, Ahmedabad', notes: 'Overdue follow-up needed', renewedPrev: false },
      { name: 'Nilesh Chauhan', phone: '+919426311008', alt: null, reg: 'GJ-01-CV-1148', vtype: 'HCV', fuel: 'Diesel', certNo: 'GJ01PUC20250774', expiryOffset: -9, lang: 'gu', status: 'active', address: 'Changodar, Ahmedabad', notes: 'Heavy transport vehicle', renewedPrev: false },
      { name: 'Meera Trivedi', phone: '+919825099114', alt: null, reg: 'GJ-01-ML-6004', vtype: '4W', fuel: 'Petrol', certNo: 'GJ01PUC20260331', expiryOffset: 45, lang: 'en', status: 'active', address: 'Thaltej, Ahmedabad', notes: 'Recently renewed after 2-day reminder', renewedPrev: true },
      { name: 'Devendra Parmar', phone: '+919725402188', alt: null, reg: 'GJ-01-NB-7422', vtype: '2W', fuel: 'Petrol', certNo: 'GJ01PUC20260344', expiryOffset: 120, lang: 'gu', status: 'active', address: 'Maninagar, Ahmedabad', notes: 'Renewed on time', renewedPrev: true },
      { name: 'Jignesh Modi', phone: '+919898774311', alt: null, reg: 'GJ-01-EX-9910', vtype: '4W', fuel: 'CNG', certNo: 'GJ01PUC20260350', expiryOffset: 88, lang: 'gu', status: 'active', address: 'Chandkheda, Ahmedabad', notes: 'Renewed after call', renewedPrev: true },
      { name: 'Roshni Vyas', phone: '+919925120344', alt: null, reg: 'GJ-01-RV-4120', vtype: '2W', fuel: 'Petrol', certNo: 'GJ01PUC20260358', expiryOffset: 155, lang: 'hi', status: 'active', address: 'Naranpura, Ahmedabad', notes: 'Renewed 1-year BS6 certificate', renewedPrev: true },
      { name: 'Sureshbhai Makwana', phone: '+919824910227', alt: null, reg: 'GJ-01-SM-2098', vtype: '4W', fuel: 'Diesel', certNo: 'GJ01PUC20260361', expiryOffset: 62, lang: 'gu', status: 'opted_out', address: 'Odhav, Ahmedabad', notes: 'Opted out of automated calls', renewedPrev: false },
      { name: 'Bhumika Bhatt', phone: '+919879882011', alt: null, reg: 'GJ-01-BB-7315', vtype: '4W', fuel: 'Hybrid', certNo: 'GJ01PUC20260380', expiryOffset: 14, lang: 'en', status: 'active', address: 'Bodakdev, Ahmedabad', notes: 'Toyota Hyryder Hybrid', renewedPrev: false },
      { name: 'Hitesh Gajjar', phone: '+919727319040', alt: null, reg: 'GJ-01-HG-5042', vtype: '2W', fuel: 'Petrol', certNo: 'GJ01PUC20260392', expiryOffset: 1, lang: 'gu', status: 'active', address: 'Memnagar, Ahmedabad', notes: 'Expiring tomorrow', renewedPrev: false },
    ];

    const createdRefs: { customerId: string; vehicleId: string; certId: string; phone: string; name: string; reg: string; expiryDate: string; lang: string; expiryOffset: number }[] = [];

    for (const c of sampleCustomers) {
      const customerId = crypto.randomUUID();
      const vehicleId = crypto.randomUUID();
      const certId = crypto.randomUUID();
      const expiryDate = addDaysToDateStr(today, c.expiryOffset);
      const issueDate = addDaysToDateStr(expiryDate, -180);

      await this.db.execute(
        `INSERT INTO customers (id, tenant_id, full_name, mobile_number, alternate_mobile, address, notes, language, status, consent_given, dnd_registered, reminders_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customerId,
          tenantId,
          c.name,
          c.phone,
          c.alt,
          c.address,
          c.notes,
          c.lang,
          c.status,
          c.status !== 'opted_out',
          false,
          c.status !== 'opted_out',
          nowIso,
          nowIso,
        ],
      );

      await this.db.execute(
        `INSERT INTO vehicles (id, tenant_id, customer_id, registration_number, vehicle_type, fuel_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [vehicleId, tenantId, customerId, c.reg, c.vtype, c.fuel, nowIso, nowIso],
      );

      if (c.renewedPrev) {
        // Historical renewed cycle so "Customers who renewed" & renewal trend chart have real DB history
        const oldCertId = crypto.randomUUID();
        const renewedDaysAgo = Math.floor(2 + Math.random() * 18);
        const renewedAtDate = new Date(Date.now() - renewedDaysAgo * 86400_000).toISOString();
        const oldExpiry = addDaysToDateStr(today, -renewedDaysAgo + 1);
        const oldIssue = addDaysToDateStr(oldExpiry, -180);
        await this.db.execute(
          `INSERT INTO puc_certificates (id, tenant_id, customer_id, vehicle_id, certificate_number, issue_date, expiry_date, cycle_status, is_current, renewed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'renewed', ?, ?, ?, ?)`,
          [oldCertId, tenantId, customerId, vehicleId, `${c.certNo}-OLD`, oldIssue, oldExpiry, false, renewedAtDate, renewedAtDate, renewedAtDate],
        );
      }

      await this.db.execute(
        `INSERT INTO puc_certificates (id, tenant_id, customer_id, vehicle_id, certificate_number, issue_date, expiry_date, cycle_status, is_current, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [certId, tenantId, customerId, vehicleId, c.certNo, issueDate, expiryDate, true, nowIso, nowIso],
      );

      createdRefs.push({ customerId, vehicleId, certId, phone: c.phone, name: c.name, reg: c.reg, expiryDate, lang: c.lang, expiryOffset: c.expiryOffset });

      // Generate scheduled reminder events & jobs for active expiring/expired certificates
      if (c.status === 'active' && c.expiryOffset >= -5 && c.expiryOffset <= 15) {
        for (const r of resources.ruleIds) {
          const schedIso = computeReminderScheduledIso(expiryDate, r.offset, '10:00');
          const eventId = crypto.randomUUID();
          const jobId = crypto.randomUUID();
          const isPast = new Date(schedIso).getTime() < Date.now() - 3600_000;
          await this.db.execute(
            `INSERT INTO reminder_events (id, tenant_id, customer_id, certificate_id, reminder_rule_id, offset_days, scheduled_for, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [eventId, tenantId, customerId, certId, r.id, r.offset, schedIso, isPast ? 'completed' : 'scheduled', nowIso, nowIso],
          );
          await this.db.execute(
            `INSERT INTO call_jobs (id, tenant_id, reminder_event_id, customer_id, certificate_id, idempotency_key, attempt_number, max_attempts, next_run_at, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 3, ?, ?, ?, ?)`,
            [jobId, tenantId, eventId, customerId, certId, `rem:${tenantId}:${certId}:${r.id}`, schedIso, isPast ? 'completed' : 'scheduled', nowIso, nowIso],
          );
        }
      }
    }

    // Create a realistic Calling Campaign
    const campaignId = crypto.randomUUID();
    const campaignTargets = createdRefs.filter((r) => r.expiryOffset <= 7 && r.expiryOffset >= -10);
    await this.db.execute(
      `INSERT INTO calling_campaigns (id, tenant_id, name, description, voice_template_id, expiry_range_start, expiry_range_end, scheduled_at, status, total_targets, completed_count, failed_count, created_at, updated_at)
       VALUES (?, ?, 'Weekly Expiring PUC Drive', 'Automated outreach for vehicles expiring this week in Ahmedabad West.', ?, ?, ?, ?, 'paused', ?, 3, 1, ?, ?)`,
      [campaignId, tenantId, resources.guTemplateId, addDaysToDateStr(today, -10), addDaysToDateStr(today, 7), nowIso, campaignTargets.length, nowIso, nowIso],
    );

    for (let i = 0; i < campaignTargets.length; i++) {
      const target = campaignTargets[i];
      const ccStatus = i < 3 ? 'completed' : i === 3 ? 'failed' : 'pending';
      await this.db.execute(
        `INSERT INTO campaign_customers (id, tenant_id, campaign_id, customer_id, certificate_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), tenantId, campaignId, target.customerId, target.certId, ccStatus, nowIso, nowIso],
      );
    }

    // Seed 24 realistic historical call logs spread over the past 14 days so charts & Call History are rich
    const statuses: ('completed' | 'no_answer' | 'busy' | 'failed')[] = [
      'completed', 'completed', 'completed', 'completed', 'no_answer', 'completed', 'busy', 'failed',
    ];
    for (let i = 0; i < 24; i++) {
      const ref = createdRefs[i % createdRefs.length];
      const daysAgo = Math.floor((i / 24) * 13);
      const callTime = new Date(Date.now() - daysAgo * 86400_000 - (i % 5) * 3600_000).toISOString();
      const status = statuses[i % statuses.length];
      const duration = status === 'completed' ? 28 + ((i * 7) % 35) : 0;
      const reminderTypes = ['auto_before', 'auto_on_expiry', 'auto_after', 'campaign', 'manual'];
      const rType = reminderTypes[i % reminderTypes.length];
      const rLabels: Record<string, string> = {
        auto_before: '2 days before expiry',
        auto_on_expiry: 'On expiry date',
        auto_after: '2 days after expiry',
        campaign: 'Weekly Expiring PUC Drive',
        manual: 'Manual Owner Call',
      };
      await this.db.execute(
        `INSERT INTO call_logs (id, tenant_id, customer_id, vehicle_id, certificate_id, campaign_id, reminder_type, reminder_label, phone_number, provider_name, provider_call_id, status, duration_seconds, rendered_message, language, initiated_at, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mock', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          tenantId,
          ref.customerId,
          ref.vehicleId,
          ref.certId,
          rType === 'campaign' ? campaignId : null,
          rType,
          rLabels[rType],
          ref.phone,
          `MOCK-SEED-${String(1000 + i)}`,
          status,
          duration,
          `નમસ્કાર ${ref.name} જી, તમારા વાહન નંબર ${ref.reg} નું PUC સર્ટિફિકેટ ${ref.expiryDate} ના રોજ પૂર્ણ થવાનું છે.`,
          ref.lang,
          callTime,
          callTime,
          callTime,
          callTime,
        ],
      );
    }

    // Seed initial audit logs
    const auditItems = [
      { action: 'certificate.renewed', entityType: 'puc_certificate', meta: { customer: 'Meera Trivedi', vehicle: 'GJ-01-ML-6004' }, hoursAgo: 4 },
      { action: 'customer.imported', entityType: 'customer', meta: { count: 16, source: 'Initial Centre Setup' }, hoursAgo: 10 },
      { action: 'campaign.created', entityType: 'calling_campaign', meta: { name: 'Weekly Expiring PUC Drive' }, hoursAgo: 18 },
      { action: 'reminder_rule.updated', entityType: 'reminder_rule', meta: { schedule: ['-7d', '-2d', '0d', '+2d'] }, hoursAgo: 26 },
    ];
    for (const item of auditItems) {
      const ts = new Date(Date.now() - item.hoursAgo * 3600_000).toISOString();
      await this.db.execute(
        `INSERT INTO audit_logs (id, tenant_id, user_id, action, entity_type, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), tenantId, userId, item.action, item.entityType, JSON.stringify(item.meta), ts],
      );
    }
  }

  async ensureDemoTenantExists(): Promise<void> {
    await this.ensureAdminExists();
    const existing = await this.db.queryOne<{ id: string }>(`SELECT id FROM users WHERE email = ?`, [DEMO_EMAIL]);
    if (existing) return;

    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await this.db.execute(
      `INSERT INTO tenants (id, business_name, owner_name, mobile_number, email, address, timezone, automation_enabled, auto_schedule_on_import, default_language, default_call_time, calling_window_start, calling_window_end, calling_days_json, max_attempts, retry_interval_minutes, max_calls_per_customer, expiry_warning_days, created_at, updated_at)
       VALUES (?, 'Shree Ganesh PUC Testing Centre', 'Yash Patoliya', '+919825012345', ?, 'Shop 12, SG Highway Service Road, Ahmedabad, Gujarat 380054', 'Asia/Kolkata', ?, ?, 'gu', '10:00', '09:30', '19:30', '[1,2,3,4,5,6]', 3, 60, 6, 7, ?, ?)`,
      [tenantId, DEMO_EMAIL, true, true, nowIso, nowIso],
    );

    await this.db.execute(
      `INSERT INTO users (id, tenant_id, email, full_name, mobile_number, password_hash, role, email_verified, theme_preference, created_at, updated_at)
       VALUES (?, ?, ?, 'Yash Patoliya', '+919825012345', ?, 'owner', ?, 'dark', ?, ?)`,
      [userId, tenantId, DEMO_EMAIL, hashPassword(DEMO_PASSWORD), true, nowIso, nowIso],
    );

    const resources = await this.createDefaultTenantResources(tenantId, 'Shree Ganesh PUC');
    await this.seedSampleCentreData(tenantId, userId, resources);
    console.log(`[SeedService] Pre-loaded sample PUC centre (${DEMO_EMAIL}).`);
  }

  async ensureAdminExists(): Promise<void> {
    const existing = await this.db.queryOne<{ id: string; role: string }>(
      `SELECT id, role FROM users WHERE email = ? AND deleted_at IS NULL`,
      [ADMIN_EMAIL],
    );
    if (existing) {
      if (existing.role !== 'admin') {
        await this.db.execute(`UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?`, [
          new Date().toISOString(),
          existing.id,
        ]);
      }
      return;
    }

    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await this.db.execute(
      `INSERT INTO tenants (id, business_name, owner_name, mobile_number, email, address, timezone, automation_enabled, auto_schedule_on_import, default_language, default_call_time, calling_window_start, calling_window_end, calling_days_json, max_attempts, retry_interval_minutes, max_calls_per_customer, expiry_warning_days, created_at, updated_at)
       VALUES (?, 'PUC Flow Platform Admin', 'System Administrator', '+919999999999', ?, 'HQ', 'Asia/Kolkata', ?, ?, 'en', '10:00', '09:30', '19:30', '[1,2,3,4,5,6]', 3, 60, 6, 7, ?, ?)`,
      [tenantId, ADMIN_EMAIL, false, false, nowIso, nowIso],
    );

    await this.db.execute(
      `INSERT INTO users (id, tenant_id, email, full_name, mobile_number, password_hash, role, email_verified, theme_preference, created_at, updated_at)
       VALUES (?, ?, ?, 'Platform Admin', '+919999999999', ?, 'admin', ?, 'dark', ?, ?)`,
      [userId, tenantId, ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), true, nowIso, nowIso],
    );

    console.log(`[SeedService] Admin account ready (${ADMIN_EMAIL}).`);
  }
}
