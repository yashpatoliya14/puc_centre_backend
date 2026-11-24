import { Inject, Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { DatabaseService } from '../../db/database.service';
import { decryptSecret, verifyHmacSignature } from '../../common/crypto.util';
import type { CallStatus } from '../../common/types';

export interface InitiateCallInput {
  tenantId: string;
  callLogId: string;
  toPhone: string;
  renderedMessage: string;
  language: string;
  audioUrl?: string | null;
  customField?: string;
}

export interface InitiateCallResult {
  success: boolean;
  providerName: 'exotel' | 'mock';
  providerCallId: string | null;
  initialStatus: CallStatus;
  errorMessage?: string;
  isMock: boolean;
}

export interface TelephonyConfigRecord {
  id: string;
  tenant_id: string;
  provider: string;
  mode: string;
  account_sid: string | null;
  subdomain: string;
  api_key_encrypted: string | null;
  api_token_encrypted: string | null;
  caller_id: string | null;
  app_url: string | null;
  webhook_secret_encrypted: string | null;
  trai_entity_id: string | null;
  last_tested_at: string | null;
  last_test_status: string | null;
}

export interface WebhookNormalizedEvent {
  providerCallId: string;
  status: CallStatus;
  durationSeconds: number;
  recordingUrl: string | null;
  customField: string | null;
  errorMessage: string | null;
}

export interface TelephonyProviderAdapter {
  readonly name: 'exotel' | 'mock';
  initiateCall(input: InitiateCallInput, config: ResolvedProviderConfig): Promise<InitiateCallResult>;
  getCallStatus(providerCallId: string, config: ResolvedProviderConfig): Promise<{ status: CallStatus; durationSeconds?: number }>;
  processWebhook(payload: Record<string, unknown>): WebhookNormalizedEvent | null;
  validateProviderConfiguration(config: ResolvedProviderConfig): Promise<{ ok: boolean; message: string; mode: 'live' | 'mock' }>;
}

export interface ResolvedProviderConfig {
  mode: 'mock' | 'live';
  accountSid: string;
  subdomain: string;
  apiKey: string;
  apiToken: string;
  callerId: string;
  appUrl: string;
  webhookSecret: string;
  callbackUrl: string;
}

function mapExotelStatus(rawStatus: string | undefined): CallStatus {
  const s = (rawStatus || '').toLowerCase().trim();
  switch (s) {
    case 'queued':
      return 'queued';
    case 'in-progress':
    case 'answered':
      return 'answered';
    case 'ringing':
      return 'ringing';
    case 'completed':
      return 'completed';
    case 'no-answer':
    case 'no_answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return 'initiated';
  }
}

function formatPhoneForExotel(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `0${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `0${digits.slice(2)}`;
  if (digits.length === 11 && digits.startsWith('0')) return digits;
  return phone;
}

export class ExotelAdapter implements TelephonyProviderAdapter {
  readonly name = 'exotel' as const;

  async initiateCall(input: InitiateCallInput, config: ResolvedProviderConfig): Promise<InitiateCallResult> {
    if (!config.accountSid || !config.apiKey || !config.apiToken || !config.callerId) {
      return {
        success: false,
        providerName: 'exotel',
        providerCallId: null,
        initialStatus: 'failed',
        errorMessage: 'Exotel credentials are incomplete. Please configure Account SID, API Key, Token, and ExoPhone Caller ID.',
        isMock: false,
      };
    }

    const endpoint = `https://${config.subdomain}/v1/Accounts/${encodeURIComponent(config.accountSid)}/Calls/connect.json`;
    const authHeader = `Basic ${Buffer.from(`${config.apiKey}:${config.apiToken}`).toString('base64')}`;

    const form = new URLSearchParams();
    form.set('From', formatPhoneForExotel(input.toPhone));
    form.set('CallerId', config.callerId);
    if (config.appUrl) {
      let resolvedUrl = config.appUrl.trim();
      if (/^\d+$/.test(resolvedUrl)) {
        resolvedUrl = `https://my.exotel.com/${config.accountSid}/exoml/start_voice/${resolvedUrl}`;
      }
      form.set('Url', resolvedUrl);
    }
    form.set('CustomField', input.customField || input.callLogId);
    if (config.callbackUrl && !config.callbackUrl.includes('localhost') && !config.callbackUrl.includes('127.0.0.1')) {
      form.set('StatusCallback', config.callbackUrl);
      form.set('StatusCallbackContentType', 'application/json');
    }
    form.set('Record', 'true');
    form.set('TimeOut', '30');

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10000),
      });

      const bodyText = await response.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        // non-json response
      }

      if (!response.ok) {
        return {
          success: false,
          providerName: 'exotel',
          providerCallId: null,
          initialStatus: 'failed',
          errorMessage: `Exotel HTTP ${response.status}: ${bodyText.slice(0, 180)}`,
          isMock: false,
        };
      }

      const callObj = (parsed.Call as Record<string, unknown> | undefined) ?? parsed;
      const callSid = String(callObj.Sid || callObj.CallSid || '');
      return {
        success: true,
        providerName: 'exotel',
        providerCallId: callSid || `EXO_${crypto.randomBytes(6).toString('hex')}`,
        initialStatus: 'initiated',
        isMock: false,
      };
    } catch (err) {
      return {
        success: false,
        providerName: 'exotel',
        providerCallId: null,
        initialStatus: 'failed',
        errorMessage: `Exotel request timeout/error: ${err instanceof Error ? err.message : String(err)}`,
        isMock: false,
      };
    }
  }

  async getCallStatus(providerCallId: string, config: ResolvedProviderConfig): Promise<{ status: CallStatus; durationSeconds?: number }> {
    const endpoint = `https://${config.subdomain}/v1/Accounts/${encodeURIComponent(config.accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`;
    const authHeader = `Basic ${Buffer.from(`${config.apiKey}:${config.apiToken}`).toString('base64')}`;
    const response = await fetch(endpoint, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`Exotel status check failed (${response.status})`);
    }
    const data = (await response.json()) as { Call?: { Status?: string; Duration?: number } };
    return {
      status: mapExotelStatus(data.Call?.Status),
      durationSeconds: Number(data.Call?.Duration || 0),
    };
  }

  processWebhook(payload: Record<string, unknown>): WebhookNormalizedEvent | null {
    const callSid = String(payload.CallSid || payload.Sid || '').trim();
    if (!callSid) return null;
    const status = mapExotelStatus(String(payload.Status || payload.EventType || ''));
    const duration = Number(payload.ConversationDuration ?? payload.Duration ?? 0) || 0;
    const recordingUrl = payload.RecordingUrl ? String(payload.RecordingUrl) : null;
    const customField = payload.CustomField ? String(payload.CustomField) : null;
    return {
      providerCallId: callSid,
      status,
      durationSeconds: duration,
      recordingUrl,
      customField,
      errorMessage: status === 'failed' ? String(payload.ErrorMessage || 'Provider reported failure') : null,
    };
  }

  async validateProviderConfiguration(config: ResolvedProviderConfig): Promise<{ ok: boolean; message: string; mode: 'live' | 'mock' }> {
    if (!config.accountSid || !config.apiKey || !config.apiToken) {
      return {
        ok: false,
        mode: 'live',
        message: 'Missing Exotel Account SID, API Key, or API Token.',
      };
    }
    try {
      const endpoint = `https://${config.subdomain}/v1/Accounts/${encodeURIComponent(config.accountSid)}/IncomingPhoneNumbers.json`;
      const authHeader = `Basic ${Buffer.from(`${config.apiKey}:${config.apiToken}`).toString('base64')}`;
      const res = await fetch(endpoint, {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        return { ok: true, mode: 'live', message: 'Connected to Exotel API successfully.' };
      }
      return {
        ok: false,
        mode: 'live',
        message: `Exotel authentication failed (HTTP ${res.status}). Check SID, API Key, and Token.`,
      };
    } catch (err) {
      return {
        ok: false,
        mode: 'live',
        message: `Could not reach Exotel endpoint (${config.subdomain}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

export class MockCallAdapter implements TelephonyProviderAdapter {
  readonly name = 'mock' as const;

  async initiateCall(_input: InitiateCallInput): Promise<InitiateCallResult> {
    const providerCallId = `MOCK-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    return {
      success: true,
      providerName: 'mock',
      providerCallId,
      initialStatus: 'initiated',
      isMock: true,
    };
  }

  async getCallStatus(): Promise<{ status: CallStatus; durationSeconds?: number }> {
    return { status: 'completed', durationSeconds: 34 };
  }

  processWebhook(payload: Record<string, unknown>): WebhookNormalizedEvent | null {
    const providerCallId = String(payload.CallSid || payload.providerCallId || '').trim();
    if (!providerCallId) return null;
    const status = mapExotelStatus(String(payload.Status || payload.status || 'completed'));
    return {
      providerCallId,
      status,
      durationSeconds: Number(payload.ConversationDuration ?? payload.durationSeconds ?? 0) || 0,
      recordingUrl: payload.RecordingUrl ? String(payload.RecordingUrl) : null,
      customField: payload.CustomField ? String(payload.CustomField) : null,
      errorMessage: payload.errorMessage ? String(payload.errorMessage) : null,
    };
  }

  async validateProviderConfiguration(): Promise<{ ok: boolean; message: string; mode: 'live' | 'mock' }> {
    return {
      ok: true,
      mode: 'mock',
      message: 'Simulated Calling Mode is active and ready. Calls progress through realistic lifecycle webhooks without dialing external numbers.',
    };
  }
}

export function renderVoiceTemplate(
  scriptBody: string,
  variables: {
    customer_name: string;
    vehicle_number: string;
    expiry_date: string;
    centre_name: string;
    contact_number: string;
  },
): string {
  return scriptBody
    .replace(/\{customer_name\}/g, variables.customer_name)
    .replace(/\{vehicle_number\}/g, variables.vehicle_number)
    .replace(/\{expiry_date\}/g, variables.expiry_date)
    .replace(/\{centre_name\}/g, variables.centre_name)
    .replace(/\{puc_centre_name\}/g, variables.centre_name)
    .replace(/\{contact_number\}/g, variables.contact_number);
}

@Injectable()
export class CallingService {
  private readonly exotelAdapter = new ExotelAdapter();
  private readonly mockAdapter = new MockCallAdapter();
  // In-memory sliding-window per-tenant rate limiter (max 30 outbound dials / minute per tenant)
  private readonly tenantCallTimestamps = new Map<string, number[]>();

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async resolveTenantProviderConfig(tenantId: string): Promise<ResolvedProviderConfig> {
    const row = await this.db.queryOne<TelephonyConfigRecord>(
      `SELECT * FROM telephony_configurations WHERE tenant_id = ?`,
      [tenantId],
    );

    const baseUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const accountSid = row?.account_sid || process.env.EXOTEL_ACCOUNT_SID || '';
    const apiKey = decryptSecret(row?.api_key_encrypted) || process.env.EXOTEL_API_KEY || '';
    const apiToken = decryptSecret(row?.api_token_encrypted) || process.env.EXOTEL_API_TOKEN || '';
    const callerId = row?.caller_id || process.env.EXOTEL_CALLER_ID || '';
    const appUrl = row?.app_url || process.env.EXOTEL_APP_URL || '';
    const webhookSecret = decryptSecret(row?.webhook_secret_encrypted) || process.env.EXOTEL_WEBHOOK_SECRET || '';
    const subdomain = process.env.EXOTEL_SUBDOMAIN || row?.subdomain || 'api.exotel.com';

    const hasLiveCreds = Boolean(accountSid && apiKey && apiToken && callerId);
    const mode: 'mock' | 'live' = (row?.mode === 'live' || (!row?.account_sid && hasLiveCreds)) && hasLiveCreds ? 'live' : 'mock';

    return {
      mode,
      accountSid,
      subdomain,
      apiKey,
      apiToken,
      callerId,
      appUrl,
      webhookSecret,
      callbackUrl: `${baseUrl}/api/webhooks/telephony/${mode === 'live' ? 'exotel' : 'mock'}`,
    };
  }

  private checkRateLimit(tenantId: string): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    const recent = (this.tenantCallTimestamps.get(tenantId) || []).filter((ts) => now - ts < windowMs);
    if (recent.length >= 30) {
      this.tenantCallTimestamps.set(tenantId, recent);
      return false;
    }
    recent.push(now);
    this.tenantCallTimestamps.set(tenantId, recent);
    return true;
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    if (!this.checkRateLimit(input.tenantId)) {
      return {
        success: false,
        providerName: 'mock',
        providerCallId: null,
        initialStatus: 'failed',
        errorMessage: 'Outbound calling rate limit exceeded (30 calls/minute). Call will retry automatically.',
        isMock: true,
      };
    }

    const config = await this.resolveTenantProviderConfig(input.tenantId);
    const adapter = config.mode === 'live' ? this.exotelAdapter : this.mockAdapter;
    return adapter.initiateCall(input, config);
  }

  async getCallStatus(tenantId: string, providerCallId: string): Promise<{ status: CallStatus; durationSeconds?: number }> {
    const config = await this.resolveTenantProviderConfig(tenantId);
    const adapter = config.mode === 'live' ? this.exotelAdapter : this.mockAdapter;
    return adapter.getCallStatus(providerCallId, config);
  }

  async validateProviderConfiguration(tenantId: string): Promise<{ ok: boolean; message: string; mode: 'live' | 'mock' }> {
    const config = await this.resolveTenantProviderConfig(tenantId);
    const adapter = config.mode === 'live' ? this.exotelAdapter : this.mockAdapter;
    const result = await adapter.validateProviderConfiguration(config);
    await this.db.execute(
      `UPDATE telephony_configurations SET last_tested_at = ?, last_test_status = ?, updated_at = ? WHERE tenant_id = ?`,
      [new Date().toISOString(), result.ok ? `ok:${result.mode}` : `error:${result.message.slice(0, 120)}`, new Date().toISOString(), tenantId],
    );
    return result;
  }

  parseWebhook(provider: string, payload: Record<string, unknown>): WebhookNormalizedEvent | null {
    const adapter = provider === 'exotel' ? this.exotelAdapter : this.mockAdapter;
    return adapter.processWebhook(payload);
  }

  async verifyWebhookSignature(tenantId: string, rawBody: string, signatureHeader?: string): Promise<boolean> {
    const config = await this.resolveTenantProviderConfig(tenantId);
    if (!config.webhookSecret) {
      // No webhook secret configured (e.g. local simulated webhook)
      return config.mode === 'mock';
    }
    if (!signatureHeader) return false;
    return verifyHmacSignature(rawBody, signatureHeader, config.webhookSecret);
  }
}
