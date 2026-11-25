import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type BetterSqlite3 from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

export type DbEngine = 'supabase-postgresql' | 'local-sqlite';

const SQLITE_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  mobile_number TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT,
  logo_url TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  automation_enabled INTEGER NOT NULL DEFAULT 1,
  auto_schedule_on_import INTEGER NOT NULL DEFAULT 1,
  default_language TEXT NOT NULL DEFAULT 'gu',
  default_call_time TEXT NOT NULL DEFAULT '10:00',
  calling_window_start TEXT NOT NULL DEFAULT '09:30',
  calling_window_end TEXT NOT NULL DEFAULT '19:30',
  calling_days_json TEXT NOT NULL DEFAULT '[1,2,3,4,5,6]',
  max_attempts INTEGER NOT NULL DEFAULT 3,
  retry_interval_minutes INTEGER NOT NULL DEFAULT 60,
  max_calls_per_customer INTEGER NOT NULL DEFAULT 6,
  max_messages_per_customer INTEGER NOT NULL DEFAULT 3,
  calls_enabled INTEGER NOT NULL DEFAULT 1,
  messages_enabled INTEGER NOT NULL DEFAULT 1,
  remind_days_before TEXT NOT NULL DEFAULT '[7,3,0]',
  remind_days_after TEXT NOT NULL DEFAULT '[1,3]',
  puc_message_template TEXT,
  insurance_message_template TEXT,
  voice_script_template TEXT,
  expiry_warning_days INTEGER NOT NULL DEFAULT 7,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  mobile_number TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  email_verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  reset_token TEXT,
  reset_token_expires_at TEXT,
  theme_preference TEXT NOT NULL DEFAULT 'dark',
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip_address TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_tenant_user ON user_sessions(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  mobile_number TEXT NOT NULL,
  alternate_mobile TEXT,
  address TEXT,
  notes TEXT,
  language TEXT NOT NULL DEFAULT 'gu',
  status TEXT NOT NULL DEFAULT 'active',
  consent_given INTEGER NOT NULL DEFAULT 1,
  dnd_registered INTEGER NOT NULL DEFAULT 0,
  reminders_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_status ON customers(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_mobile ON customers(tenant_id, mobile_number);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  registration_number TEXT NOT NULL,
  vehicle_type TEXT NOT NULL,
  fuel_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_vehicles_tenant_customer ON vehicles(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_tenant_reg ON vehicles(tenant_id, registration_number);

CREATE TABLE IF NOT EXISTS puc_certificates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  certificate_number TEXT,
  issue_date TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  cycle_status TEXT NOT NULL DEFAULT 'active',
  is_current INTEGER NOT NULL DEFAULT 1,
  renewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_certs_tenant_expiry ON puc_certificates(tenant_id, expiry_date, is_current);
CREATE INDEX IF NOT EXISTS idx_certs_tenant_customer ON puc_certificates(tenant_id, customer_id);

CREATE TABLE IF NOT EXISTS vehicle_insurances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  policy_number TEXT NOT NULL,
  insurance_company TEXT NOT NULL,
  policy_type TEXT NOT NULL DEFAULT 'Comprehensive',
  start_date TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  premium_amount REAL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_insurances_tenant_customer ON vehicle_insurances(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_insurances_tenant_expiry ON vehicle_insurances(tenant_id, expiry_date);

CREATE TABLE IF NOT EXISTS voice_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  script_body TEXT NOT NULL,
  audio_url TEXT,
  audio_filename TEXT,
  dlt_template_id TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_templates_tenant_lang ON voice_templates(tenant_id, language);

CREATE TABLE IF NOT EXISTS reminder_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  offset_days INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  voice_template_id TEXT REFERENCES voice_templates(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, offset_days)
);
CREATE INDEX IF NOT EXISTS idx_reminder_rules_tenant_active ON reminder_rules(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS reminder_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  certificate_id TEXT NOT NULL REFERENCES puc_certificates(id) ON DELETE CASCADE,
  reminder_rule_id TEXT NOT NULL REFERENCES reminder_rules(id) ON DELETE CASCADE,
  offset_days INTEGER NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  skip_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, certificate_id, reminder_rule_id)
);
CREATE INDEX IF NOT EXISTS idx_reminder_events_tenant_status ON reminder_events(tenant_id, status, scheduled_for);

CREATE TABLE IF NOT EXISTS calling_campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  voice_template_id TEXT REFERENCES voice_templates(id) ON DELETE SET NULL,
  expiry_range_start TEXT,
  expiry_range_end TEXT,
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  total_targets INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_status ON calling_campaigns(tenant_id, status);

CREATE TABLE IF NOT EXISTS campaign_customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES calling_campaigns(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  certificate_id TEXT REFERENCES puc_certificates(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, campaign_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_customers_tenant ON campaign_customers(tenant_id, campaign_id, status);

CREATE TABLE IF NOT EXISTS call_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reminder_event_id TEXT REFERENCES reminder_events(id) ON DELETE SET NULL,
  campaign_customer_id TEXT REFERENCES campaign_customers(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  certificate_id TEXT REFERENCES puc_certificates(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_call_jobs_tenant_status ON call_jobs(tenant_id, status, next_run_at);

CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_job_id TEXT REFERENCES call_jobs(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
  certificate_id TEXT REFERENCES puc_certificates(id) ON DELETE SET NULL,
  campaign_id TEXT REFERENCES calling_campaigns(id) ON DELETE SET NULL,
  reminder_type TEXT NOT NULL,
  reminder_label TEXT,
  phone_number TEXT NOT NULL,
  provider_name TEXT NOT NULL DEFAULT 'mock',
  provider_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  recording_url TEXT,
  rendered_message TEXT,
  language TEXT NOT NULL DEFAULT 'gu',
  error_message TEXT,
  initiated_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_call_logs_tenant_created ON call_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_tenant_status ON call_logs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_call_logs_provider_id ON call_logs(provider_call_id);

CREATE TABLE IF NOT EXISTS telephony_configurations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'exotel',
  mode TEXT NOT NULL DEFAULT 'mock',
  account_sid TEXT,
  subdomain TEXT NOT NULL DEFAULT 'api.in.exotel.com',
  api_key_encrypted TEXT,
  api_token_encrypted TEXT,
  caller_id TEXT,
  app_url TEXT,
  webhook_secret_encrypted TEXT,
  trai_entity_id TEXT,
  last_tested_at TEXT,
  last_test_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  call_success_alert INTEGER NOT NULL DEFAULT 0,
  call_failed_alert INTEGER NOT NULL DEFAULT 1,
  daily_summary INTEGER NOT NULL DEFAULT 1,
  renewal_alerts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at);
`;

function convertPlaceholdersToPg(sql: string): string {
  let idx = 0;
  const pgSql = sql.replace(/SUBSTR\((\w+\.?\w+),\s*1,\s*10\)/gi, 'SUBSTR(CAST($1 AS TEXT), 1, 10)');
  return pgSql.replace(/\?/g, () => `$${++idx}`);
}

function normalizeParamForSqlite(val: unknown): unknown {
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (val instanceof Date) return val.toISOString();
  if (val === undefined) return null;
  return val;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pgPool: Pool | null = null;
  private sqlite: BetterSqlite3.Database | null = null;
  private engine: DbEngine = 'local-sqlite';
  private initialized = false;

  private customSqlitePath?: string;

  constructor() {}

  setCustomSqlitePath(customPath: string) {
    this.customSqlitePath = customPath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (databaseUrl && !this.customSqlitePath) {
      try {
        this.pgPool = new Pool({
          connectionString: databaseUrl,
          ssl: databaseUrl.includes('supabase') || process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : undefined,
          max: 10,
          connectionTimeoutMillis: 10000,
        });
        this.pgPool.on('error', (err) => {
          console.error('[DatabaseService] Unexpected pg pool error:', err.message);
        });
        await this.pgPool.query('SELECT 1');
        const migrationCandidates = [
          path.resolve(process.cwd(), 'prisma/migrations/20261122000000_init/migration.sql'),
          path.resolve(__dirname, '../../prisma/migrations/20261122000000_init/migration.sql'),
          path.resolve(__dirname, '../../../prisma/migrations/20261122000000_init/migration.sql'),
        ];
        const migrationPath = migrationCandidates.find((p) => fs.existsSync(p));
        if (migrationPath) {
          const migrationSql = fs.readFileSync(migrationPath, 'utf8');
          await this.pgPool.query(migrationSql);
        }
        await this.pgPool.query(`
          CREATE TABLE IF NOT EXISTS vehicle_insurances (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
            policy_number TEXT NOT NULL,
            insurance_company TEXT NOT NULL,
            policy_type TEXT NOT NULL DEFAULT 'Comprehensive',
            start_date TEXT NOT NULL,
            expiry_date TEXT NOT NULL,
            premium_amount REAL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS idx_insurances_tenant_customer ON vehicle_insurances(tenant_id, customer_id);
          CREATE INDEX IF NOT EXISTS idx_insurances_tenant_expiry ON vehicle_insurances(tenant_id, expiry_date);
          ALTER TABLE tenants ADD COLUMN IF NOT EXISTS calls_enabled BOOLEAN NOT NULL DEFAULT TRUE;
          ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_call_on_registration BOOLEAN NOT NULL DEFAULT TRUE;
          ALTER TABLE tenants ADD COLUMN IF NOT EXISTS messages_enabled BOOLEAN NOT NULL DEFAULT TRUE;
          ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_messages_per_customer INTEGER NOT NULL DEFAULT 3;
          ALTER TABLE tenants ADD COLUMN IF NOT EXISTS remind_days_before TEXT NOT NULL DEFAULT '[7,3,0]';
          ALTER TABLE tenants ADD COLUMN IF NOT EXISTS remind_days_after TEXT NOT NULL DEFAULT '[1,3]';
          ALTER TABLE tenants ADD COLUMN IF NOT EXISTS puc_message_template TEXT;
          ALTER TABLE tenants ADD COLUMN IF NOT EXISTS insurance_message_template TEXT;
          ALTER TABLE tenants ADD COLUMN IF NOT EXISTS voice_script_template TEXT;
        `);
        this.engine = 'supabase-postgresql';
        this.initialized = true;
        console.log('[DatabaseService] Connected to external Supabase PostgreSQL.');
        return;
      } catch (err) {
        console.warn(
          '[DatabaseService] Could not connect to DATABASE_URL; falling back to local SQLite store:',
          err instanceof Error ? err.message : String(err),
        );
        if (this.pgPool) {
          await this.pgPool.end().catch(() => {});
          this.pgPool = null;
        }
      }
    }

    const dbPath = this.customSqlitePath || path.resolve(process.cwd(), 'data/pucflow.sqlite');
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    // Lazy-load better-sqlite3 only when PostgreSQL is unavailable so production servers without build tools still boot
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const DatabaseCtor = require('better-sqlite3') as typeof BetterSqlite3;
    this.sqlite = new DatabaseCtor(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.exec(SQLITE_SCHEMA);

    // Apply incremental SQLite column additions safely if upgrading existing local store
    const optionalCols = [
      "ALTER TABLE tenants ADD COLUMN calls_enabled INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE tenants ADD COLUMN auto_call_on_registration INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE tenants ADD COLUMN messages_enabled INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE tenants ADD COLUMN max_messages_per_customer INTEGER NOT NULL DEFAULT 3",
      "ALTER TABLE tenants ADD COLUMN remind_days_before TEXT NOT NULL DEFAULT '[7,3,0]'",
      "ALTER TABLE tenants ADD COLUMN remind_days_after TEXT NOT NULL DEFAULT '[1,3]'",
      "ALTER TABLE tenants ADD COLUMN puc_message_template TEXT",
      "ALTER TABLE tenants ADD COLUMN insurance_message_template TEXT",
      "ALTER TABLE tenants ADD COLUMN voice_script_template TEXT"
    ];
    for (const sql of optionalCols) {
      try { this.sqlite.exec(sql); } catch {}
    }

    this.engine = 'local-sqlite';
    this.initialized = true;
  }

  getEngine(): DbEngine {
    return this.engine;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.init();
    if (this.pgPool) {
      const pgSql = convertPlaceholdersToPg(sql);
      const res = await this.pgPool.query(pgSql, params);
      return res.rows as T[];
    }
    if (!this.sqlite) throw new Error('Database not initialized');
    const stmt = this.sqlite.prepare(sql);
    const normalized = params.map(normalizeParamForSqlite);
    return stmt.all(...normalized) as T[];
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
    await this.init();
    if (this.pgPool) {
      const pgSql = convertPlaceholdersToPg(sql);
      const res = await this.pgPool.query(pgSql, params);
      return { rowCount: res.rowCount ?? 0 };
    }
    if (!this.sqlite) throw new Error('Database not initialized');
    const stmt = this.sqlite.prepare(sql);
    const normalized = params.map(normalizeParamForSqlite);
    const info = stmt.run(...normalized);
    return { rowCount: info.changes };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pgPool) {
      await this.pgPool.end().catch(() => {});
    }
    if (this.sqlite) {
      this.sqlite.close();
    }
  }
}
