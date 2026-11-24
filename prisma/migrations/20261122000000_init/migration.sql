-- PucFlow Initial PostgreSQL Migration (Supabase Ready)
-- Creates all 15 normalized multi-tenant tables, foreign keys, composite indexes, and idempotency constraints.

CREATE TABLE IF NOT EXISTS "tenants" (
  "id" TEXT PRIMARY KEY,
  "business_name" TEXT NOT NULL,
  "owner_name" TEXT NOT NULL,
  "mobile_number" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "address" TEXT,
  "logo_url" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  "automation_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "auto_schedule_on_import" BOOLEAN NOT NULL DEFAULT TRUE,
  "default_language" TEXT NOT NULL DEFAULT 'gu',
  "default_call_time" TEXT NOT NULL DEFAULT '10:00',
  "calling_window_start" TEXT NOT NULL DEFAULT '09:30',
  "calling_window_end" TEXT NOT NULL DEFAULT '19:30',
  "calling_days_json" TEXT NOT NULL DEFAULT '[1,2,3,4,5,6]',
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "retry_interval_minutes" INTEGER NOT NULL DEFAULT 60,
  "max_calls_per_customer" INTEGER NOT NULL DEFAULT 6,
  "expiry_warning_days" INTEGER NOT NULL DEFAULT 7,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deleted_at" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL UNIQUE,
  "full_name" TEXT NOT NULL,
  "mobile_number" TEXT,
  "password_hash" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'owner',
  "email_verified" BOOLEAN NOT NULL DEFAULT FALSE,
  "verification_token" TEXT,
  "reset_token" TEXT,
  "reset_token_expires_at" TIMESTAMPTZ,
  "theme_preference" TEXT NOT NULL DEFAULT 'dark',
  "last_login_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deleted_at" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_users_tenant" ON "users"("tenant_id");

CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "user_agent" TEXT,
  "ip_address" TEXT,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_user_sessions_tenant_user" ON "user_sessions"("tenant_id", "user_id");

CREATE TABLE IF NOT EXISTS "customers" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "full_name" TEXT NOT NULL,
  "mobile_number" TEXT NOT NULL,
  "alternate_mobile" TEXT,
  "address" TEXT,
  "notes" TEXT,
  "language" TEXT NOT NULL DEFAULT 'gu',
  "status" TEXT NOT NULL DEFAULT 'active',
  "consent_given" BOOLEAN NOT NULL DEFAULT TRUE,
  "dnd_registered" BOOLEAN NOT NULL DEFAULT FALSE,
  "reminders_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deleted_at" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_customers_tenant_status" ON "customers"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "idx_customers_tenant_mobile" ON "customers"("tenant_id", "mobile_number");

CREATE TABLE IF NOT EXISTS "vehicles" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" TEXT NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "registration_number" TEXT NOT NULL,
  "vehicle_type" TEXT NOT NULL,
  "fuel_type" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deleted_at" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_vehicles_tenant_customer" ON "vehicles"("tenant_id", "customer_id");
CREATE INDEX IF NOT EXISTS "idx_vehicles_tenant_reg" ON "vehicles"("tenant_id", "registration_number");

CREATE TABLE IF NOT EXISTS "puc_certificates" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" TEXT NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "vehicle_id" TEXT NOT NULL REFERENCES "vehicles"("id") ON DELETE CASCADE,
  "certificate_number" TEXT,
  "issue_date" TEXT NOT NULL,
  "expiry_date" TEXT NOT NULL,
  "cycle_status" TEXT NOT NULL DEFAULT 'active',
  "is_current" BOOLEAN NOT NULL DEFAULT TRUE,
  "renewed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deleted_at" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_certs_tenant_expiry" ON "puc_certificates"("tenant_id", "expiry_date", "is_current");
CREATE INDEX IF NOT EXISTS "idx_certs_tenant_customer" ON "puc_certificates"("tenant_id", "customer_id");

CREATE TABLE IF NOT EXISTS "voice_templates" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "script_body" TEXT NOT NULL,
  "audio_url" TEXT,
  "audio_filename" TEXT,
  "dlt_template_id" TEXT,
  "approval_status" TEXT NOT NULL DEFAULT 'approved',
  "is_default" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deleted_at" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_voice_templates_tenant_lang" ON "voice_templates"("tenant_id", "language");

CREATE TABLE IF NOT EXISTS "reminder_rules" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "label" TEXT NOT NULL,
  "offset_days" INTEGER NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "voice_template_id" TEXT REFERENCES "voice_templates"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("tenant_id", "offset_days")
);
CREATE INDEX IF NOT EXISTS "idx_reminder_rules_tenant_active" ON "reminder_rules"("tenant_id", "is_active");

CREATE TABLE IF NOT EXISTS "reminder_events" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" TEXT NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "certificate_id" TEXT NOT NULL REFERENCES "puc_certificates"("id") ON DELETE CASCADE,
  "reminder_rule_id" TEXT NOT NULL REFERENCES "reminder_rules"("id") ON DELETE CASCADE,
  "offset_days" INTEGER NOT NULL,
  "scheduled_for" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "skip_reason" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("tenant_id", "certificate_id", "reminder_rule_id")
);
CREATE INDEX IF NOT EXISTS "idx_reminder_events_tenant_status" ON "reminder_events"("tenant_id", "status", "scheduled_for");

CREATE TABLE IF NOT EXISTS "calling_campaigns" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "voice_template_id" TEXT REFERENCES "voice_templates"("id") ON DELETE SET NULL,
  "expiry_range_start" TEXT,
  "expiry_range_end" TEXT,
  "scheduled_at" TIMESTAMPTZ,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "total_targets" INTEGER NOT NULL DEFAULT 0,
  "completed_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deleted_at" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "idx_campaigns_tenant_status" ON "calling_campaigns"("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "campaign_customers" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "campaign_id" TEXT NOT NULL REFERENCES "calling_campaigns"("id") ON DELETE CASCADE,
  "customer_id" TEXT NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "certificate_id" TEXT REFERENCES "puc_certificates"("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "skip_reason" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("tenant_id", "campaign_id", "customer_id")
);
CREATE INDEX IF NOT EXISTS "idx_campaign_customers_tenant" ON "campaign_customers"("tenant_id", "campaign_id", "status");

CREATE TABLE IF NOT EXISTS "call_jobs" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "reminder_event_id" TEXT REFERENCES "reminder_events"("id") ON DELETE SET NULL,
  "campaign_customer_id" TEXT REFERENCES "campaign_customers"("id") ON DELETE SET NULL,
  "customer_id" TEXT NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "certificate_id" TEXT REFERENCES "puc_certificates"("id") ON DELETE SET NULL,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "attempt_number" INTEGER NOT NULL DEFAULT 1,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "next_run_at" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_call_jobs_tenant_status" ON "call_jobs"("tenant_id", "status", "next_run_at");

CREATE TABLE IF NOT EXISTS "call_logs" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "call_job_id" TEXT REFERENCES "call_jobs"("id") ON DELETE SET NULL,
  "customer_id" TEXT NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "vehicle_id" TEXT REFERENCES "vehicles"("id") ON DELETE SET NULL,
  "certificate_id" TEXT REFERENCES "puc_certificates"("id") ON DELETE SET NULL,
  "campaign_id" TEXT REFERENCES "calling_campaigns"("id") ON DELETE SET NULL,
  "reminder_type" TEXT NOT NULL,
  "reminder_label" TEXT,
  "phone_number" TEXT NOT NULL,
  "provider_name" TEXT NOT NULL DEFAULT 'mock',
  "provider_call_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "duration_seconds" INTEGER NOT NULL DEFAULT 0,
  "recording_url" TEXT,
  "rendered_message" TEXT,
  "language" TEXT NOT NULL DEFAULT 'gu',
  "error_message" TEXT,
  "initiated_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_call_logs_tenant_created" ON "call_logs"("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_call_logs_tenant_status" ON "call_logs"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "idx_call_logs_provider_id" ON "call_logs"("provider_call_id");

CREATE TABLE IF NOT EXISTS "telephony_configurations" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL UNIQUE REFERENCES "tenants"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL DEFAULT 'exotel',
  "mode" TEXT NOT NULL DEFAULT 'mock',
  "account_sid" TEXT,
  "subdomain" TEXT NOT NULL DEFAULT 'api.in.exotel.com',
  "api_key_encrypted" TEXT,
  "api_token_encrypted" TEXT,
  "caller_id" TEXT,
  "app_url" TEXT,
  "webhook_secret_encrypted" TEXT,
  "trai_entity_id" TEXT,
  "last_tested_at" TIMESTAMPTZ,
  "last_test_status" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL UNIQUE REFERENCES "tenants"("id") ON DELETE CASCADE,
  "call_success_alert" BOOLEAN NOT NULL DEFAULT FALSE,
  "call_failed_alert" BOOLEAN NOT NULL DEFAULT TRUE,
  "daily_summary" BOOLEAN NOT NULL DEFAULT TRUE,
  "renewal_alerts" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" TEXT PRIMARY KEY,
  "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "metadata_json" TEXT,
  "ip_address" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_audit_logs_tenant_created" ON "audit_logs"("tenant_id", "created_at");
