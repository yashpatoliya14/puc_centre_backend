import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { DatabaseService } from '../../db/database.service';
import { addDaysToDateStr, getIstDateString } from '../../common/ist-date.util';
import { TenantAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuditService } from '../audit/audit.service';

@Controller('api')
@UseGuards(TenantAuthGuard)
export class DashboardController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  @Get('dashboard/overview')
  async getOverview(@Req() req: AuthenticatedRequest) {
    const tenantId = req.auth!.tenantId;
    const todayIst = getIstDateString();
    const in7Days = addDaysToDateStr(todayIst, 7);

    const custStats = await this.db.queryOne<{
      total_customers: number;
      active_puc_customers: number;
      expiring_today: number;
      expiring_within_7d: number;
      already_expired: number;
    }>(
      `SELECT
        COUNT(DISTINCT c.id) as total_customers,
        COUNT(DISTINCT CASE WHEN pc.expiry_date >= ? AND c.status = 'active' THEN c.id END) as active_puc_customers,
        COUNT(DISTINCT CASE WHEN pc.expiry_date = ? THEN pc.id END) as expiring_today,
        COUNT(DISTINCT CASE WHEN pc.expiry_date >= ? AND pc.expiry_date <= ? THEN pc.id END) as expiring_within_7d,
        COUNT(DISTINCT CASE WHEN pc.expiry_date < ? THEN pc.id END) as already_expired
       FROM customers c
       LEFT JOIN puc_certificates pc ON pc.customer_id = c.id AND pc.tenant_id = c.tenant_id AND pc.is_current = ? AND pc.deleted_at IS NULL
       WHERE c.tenant_id = ? AND c.deleted_at IS NULL`,
      [todayIst, todayIst, todayIst, in7Days, todayIst, true, tenantId],
    );

    const renewedRow = await this.db.queryOne<{ renewed_customers: number }>(
      `SELECT COUNT(DISTINCT customer_id) as renewed_customers
       FROM puc_certificates
       WHERE tenant_id = ? AND cycle_status = 'renewed' AND deleted_at IS NULL`,
      [tenantId],
    );

    const callStats = await this.db.queryOne<{
      total_automated_calls: number;
      successful_calls: number;
      failed_calls: number;
    }>(
      `SELECT
        COUNT(*) as total_automated_calls,
        SUM(CASE WHEN status IN ('completed', 'answered') THEN 1 ELSE 0 END) as successful_calls,
        SUM(CASE WHEN status IN ('failed', 'no_answer', 'busy') THEN 1 ELSE 0 END) as failed_calls
       FROM call_logs
       WHERE tenant_id = ?`,
      [tenantId],
    );

    // Build 14-day Daily Calling Activity chart from real call_logs
    const start14 = addDaysToDateStr(todayIst, -13);
    const rawDailyCalls = await this.db.query<{
      day: string;
      successful: number;
      failed: number;
      total: number;
    }>(
      `SELECT
        SUBSTR(CAST(created_at AS TEXT), 1, 10) as day,
        SUM(CASE WHEN status IN ('completed', 'answered') THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status IN ('failed', 'no_answer', 'busy') THEN 1 ELSE 0 END) as failed,
        COUNT(*) as total
       FROM call_logs
       WHERE tenant_id = ? AND SUBSTR(CAST(created_at AS TEXT), 1, 10) >= ?
       GROUP BY SUBSTR(CAST(created_at AS TEXT), 1, 10)
       ORDER BY day ASC`,
      [tenantId, start14],
    );
    const callMap = new Map(rawDailyCalls.map((r) => [r.day, r]));
    const dailyCallingActivity = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDaysToDateStr(todayIst, -i);
      const hit = callMap.get(d);
      dailyCallingActivity.push({
        date: d,
        label: d.slice(5),
        successful: Number(hit?.successful || 0),
        failed: Number(hit?.failed || 0),
        total: Number(hit?.total || 0),
      });
    }

    // Build 14-day Renewal Trend chart from real puc_certificates
    const rawRenewals = await this.db.query<{ day: string; renewed: number }>(
      `SELECT SUBSTR(CAST(renewed_at AS TEXT), 1, 10) as day, COUNT(*) as renewed
       FROM puc_certificates
       WHERE tenant_id = ? AND cycle_status = 'renewed' AND renewed_at IS NOT NULL AND SUBSTR(CAST(renewed_at AS TEXT), 1, 10) >= ?
       GROUP BY SUBSTR(CAST(renewed_at AS TEXT), 1, 10)`,
      [tenantId, start14],
    );
    const rawNewCerts = await this.db.query<{ day: string; added: number }>(
      `SELECT SUBSTR(CAST(created_at AS TEXT), 1, 10) as day, COUNT(*) as added
       FROM puc_certificates
       WHERE tenant_id = ? AND is_current = ? AND SUBSTR(CAST(created_at AS TEXT), 1, 10) >= ?
       GROUP BY SUBSTR(CAST(created_at AS TEXT), 1, 10)`,
      [tenantId, true, start14],
    );
    const renewMap = new Map(rawRenewals.map((r) => [r.day, Number(r.renewed || 0)]));
    const newCertMap = new Map(rawNewCerts.map((r) => [r.day, Number(r.added || 0)]));
    const renewalTrend = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDaysToDateStr(todayIst, -i);
      renewalTrend.push({
        date: d,
        label: d.slice(5),
        renewals: renewMap.get(d) || 0,
        issued: newCertMap.get(d) || 0,
      });
    }

    const upcomingRenewals = await this.db.query(
      `SELECT c.id as customer_id, c.full_name, c.mobile_number, c.language,
              v.registration_number, v.vehicle_type, v.fuel_type,
              pc.id as certificate_id, pc.expiry_date, pc.certificate_number
       FROM puc_certificates pc
       INNER JOIN customers c ON c.id = pc.customer_id
       INNER JOIN vehicles v ON v.id = pc.vehicle_id
       WHERE pc.tenant_id = ? AND pc.is_current = ? AND pc.deleted_at IS NULL AND c.deleted_at IS NULL
         AND pc.expiry_date <= ?
       ORDER BY pc.expiry_date ASC
       LIMIT 8`,
      [tenantId, true, in7Days],
    );

    const recentCalls = await this.db.query(
      `SELECT cl.id, cl.phone_number, cl.status, cl.duration_seconds, cl.reminder_type, cl.reminder_label,
              cl.provider_call_id, cl.provider_name, cl.created_at,
              c.full_name as customer_name, v.registration_number
       FROM call_logs cl
       INNER JOIN customers c ON c.id = cl.customer_id
       LEFT JOIN vehicles v ON v.id = cl.vehicle_id
       WHERE cl.tenant_id = ?
       ORDER BY cl.created_at DESC
       LIMIT 8`,
      [tenantId],
    );

    const recentActivity = await this.auditService.listRecent(tenantId, 8);

    const pendingJobsRow = await this.db.queryOne<{ pending_jobs: number }>(
      `SELECT COUNT(*) as pending_jobs FROM call_jobs WHERE tenant_id = ? AND status IN ('scheduled', 'queued', 'retrying')`,
      [tenantId],
    );

    return {
      kpis: {
        totalCustomers: Number(custStats?.total_customers || 0),
        activePucCustomers: Number(custStats?.active_puc_customers || 0),
        expiringToday: Number(custStats?.expiring_today || 0),
        expiringWithin7Days: Number(custStats?.expiring_within_7d || 0),
        alreadyExpired: Number(custStats?.already_expired || 0),
        totalAutomatedCalls: Number(callStats?.total_automated_calls || 0),
        successfulCalls: Number(callStats?.successful_calls || 0),
        failedCalls: Number(callStats?.failed_calls || 0),
        customersRenewed: Number(renewedRow?.renewed_customers || 0),
        pendingScheduledCalls: Number(pendingJobsRow?.pending_jobs || 0),
      },
      renewalTrend,
      dailyCallingActivity,
      upcomingRenewals,
      recentCalls,
      recentActivity,
    };
  }

  @Get('reports/renewals')
  async renewalReport(
    @Req() req: AuthenticatedRequest,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const tenantId = req.auth!.tenantId;
    const todayIst = getIstDateString();
    const from = dateFrom || addDaysToDateStr(todayIst, -30);
    const to = dateTo || addDaysToDateStr(todayIst, 30);

    const summary = await this.db.queryOne<{
      total_renewed: number;
      due_in_range: number;
      expired_unrenewed: number;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM puc_certificates WHERE tenant_id = ? AND cycle_status = 'renewed' AND SUBSTR(CAST(COALESCE(renewed_at, updated_at) AS TEXT), 1, 10) BETWEEN ? AND ?) as total_renewed,
        (SELECT COUNT(*) FROM puc_certificates WHERE tenant_id = ? AND is_current = ? AND expiry_date BETWEEN ? AND ? AND deleted_at IS NULL) as due_in_range,
        (SELECT COUNT(*) FROM puc_certificates WHERE tenant_id = ? AND is_current = ? AND expiry_date < ? AND deleted_at IS NULL) as expired_unrenewed`,
      [tenantId, from, to, tenantId, true, from, to, tenantId, true, todayIst],
    );

    const byVehicleType = await this.db.query<{ vehicle_type: string; total: number; expired: number; renewed: number }>(
      `SELECT v.vehicle_type,
              COUNT(DISTINCT CASE WHEN pc.is_current = ? THEN pc.id END) as total,
              COUNT(DISTINCT CASE WHEN pc.is_current = ? AND pc.expiry_date < ? THEN pc.id END) as expired,
              COUNT(DISTINCT CASE WHEN pc.cycle_status = 'renewed' THEN pc.id END) as renewed
       FROM vehicles v
       LEFT JOIN puc_certificates pc ON pc.vehicle_id = v.id AND pc.deleted_at IS NULL
       WHERE v.tenant_id = ? AND v.deleted_at IS NULL
       GROUP BY v.vehicle_type
       ORDER BY total DESC`,
      [true, true, todayIst, tenantId],
    );

    const rows = await this.db.query(
      `SELECT c.full_name, c.mobile_number, v.registration_number, v.vehicle_type, v.fuel_type,
              pc.certificate_number, pc.issue_date, pc.expiry_date, pc.cycle_status, pc.renewed_at
       FROM puc_certificates pc
       INNER JOIN customers c ON c.id = pc.customer_id
       INNER JOIN vehicles v ON v.id = pc.vehicle_id
       WHERE pc.tenant_id = ? AND pc.deleted_at IS NULL
         AND (pc.expiry_date BETWEEN ? AND ? OR pc.cycle_status = 'renewed')
       ORDER BY pc.expiry_date ASC
       LIMIT 200`,
      [tenantId, from, to],
    );

    return { dateFrom: from, dateTo: to, summary, byVehicleType, rows };
  }

  @Get('reports/calling')
  async callingReport(
    @Req() req: AuthenticatedRequest,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const tenantId = req.auth!.tenantId;
    const todayIst = getIstDateString();
    const from = dateFrom || addDaysToDateStr(todayIst, -30);
    const to = dateTo || todayIst;

    const byStatus = await this.db.query<{ status: string; count: number; avg_duration: number }>(
      `SELECT status, COUNT(*) as count, ROUND(AVG(duration_seconds), 1) as avg_duration
       FROM call_logs
       WHERE tenant_id = ? AND SUBSTR(CAST(created_at AS TEXT), 1, 10) BETWEEN ? AND ?
       GROUP BY status
       ORDER BY count DESC`,
      [tenantId, from, to],
    );

    const byReminderType = await this.db.query<{ reminder_type: string; total: number; successful: number; failed: number }>(
      `SELECT reminder_type,
              COUNT(*) as total,
              SUM(CASE WHEN status IN ('completed', 'answered') THEN 1 ELSE 0 END) as successful,
              SUM(CASE WHEN status IN ('failed', 'no_answer', 'busy') THEN 1 ELSE 0 END) as failed
       FROM call_logs
       WHERE tenant_id = ? AND SUBSTR(CAST(created_at AS TEXT), 1, 10) BETWEEN ? AND ?
       GROUP BY reminder_type`,
      [tenantId, from, to],
    );

    const totals = await this.db.queryOne<{ total_calls: number; total_duration: number; answered_calls: number }>(
      `SELECT COUNT(*) as total_calls,
              COALESCE(SUM(duration_seconds), 0) as total_duration,
              SUM(CASE WHEN status IN ('completed', 'answered') THEN 1 ELSE 0 END) as answered_calls
       FROM call_logs
       WHERE tenant_id = ? AND SUBSTR(CAST(created_at AS TEXT), 1, 10) BETWEEN ? AND ?`,
      [tenantId, from, to],
    );

    return {
      dateFrom: from,
      dateTo: to,
      totals: {
        totalCalls: Number(totals?.total_calls || 0),
        totalDurationSeconds: Number(totals?.total_duration || 0),
        answeredCalls: Number(totals?.answered_calls || 0),
        answerRatePct:
          Number(totals?.total_calls || 0) > 0
            ? Math.round((Number(totals?.answered_calls || 0) / Number(totals?.total_calls || 0)) * 100)
            : 0,
      },
      byStatus,
      byReminderType,
    };
  }
}
