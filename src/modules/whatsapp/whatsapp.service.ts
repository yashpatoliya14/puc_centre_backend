import {
  Injectable,
  Logger,
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';

export interface SendTextMessageDto {
  to: string;
  message: string;
}

export interface SendTemplateMessageDto {
  to: string;
  templateName: string;
  languageCode?: string;
  bodyParameters?: string[];
}

export interface PucReminderInput {
  to: string;
  customerName: string;
  vehiclePlate: string;
  expiryDate: string;
  centreName: string;
  ownerName: string;
  centreAddress: string;
  contactNumber: string;
}

export interface InsuranceReminderInput {
  to: string;
  customerName: string;
  vehiclePlate: string;
  expiryDate: string;
  policyNumber: string;
  insurerName: string;
  centreName: string;
  ownerName: string;
  contactNumber: string;
}

export interface MetaMessageResponse {
  messaging_product?: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string }>;
}

export interface MetaWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          text?: { body: string };
          type: string;
        }>;
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  private get apiUrl(): string {
    const base = process.env.WHATSAPP_API_URL?.trim() || 'https://graph.facebook.com/v21.0';
    return base.replace(/\/+$/, '');
  }

  private get accessToken(): string {
    return process.env.WHATSAPP_ACCESS_TOKEN?.trim() || '';
  }

  private get phoneNumberId(): string {
    return process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || '';
  }

  private get wabaId(): string {
    return process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || '';
  }

  private get defaultTemplateName(): string {
    return process.env.WHATSAPP_TEMPLATE_NAME?.trim() || 'puc_certificate_utility';
  }

  private get defaultInsuranceTemplateName(): string {
    return process.env.WHATSAPP_INSURANCE_TEMPLATE_NAME?.trim() || 'vehicle_insurance';
  }

  private get defaultTemplateLanguage(): string {
    return process.env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || 'en';
  }

  /**
   * Send a template message using Meta WhatsApp Cloud API.
   * Matches the exact architecture of dairy-backend.
   */
  async sendTemplateMessage(dto: SendTemplateMessageDto): Promise<{ messageId: string }> {
    const components =
      dto.bodyParameters && dto.bodyParameters.length > 0
        ? [
            {
              type: 'body',
              parameters: dto.bodyParameters.map((text) => ({
                type: 'text',
                text: String(text || '').trim(),
              })),
            },
          ]
        : undefined;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.normalizePhoneNumber(dto.to),
      type: 'template',
      template: {
        name: dto.templateName,
        language: {
          code: dto.languageCode || this.defaultTemplateLanguage,
        },
        ...(components ? { components } : {}),
      },
    };

    const data = await this.postMessage(payload);
    return this.messageResult(data);
  }

  /**
   * Send PUC Renewal Reminder using approved Meta template "puc_certificate_utility".
   * Positional parameters:
   * {{1}}: Customer Name
   * {{2}}: Vehicle Plate
   * {{3}}: Expiry Date
   * {{4}}: PUC Centre Name
   * {{5}}: Owner Name
   * {{6}}: Address
   * {{7}}: Contact Number
   */
  async sendPucCertificateReminder(input: PucReminderInput): Promise<{ messageId: string; template: string }> {
    const templateName = this.defaultTemplateName;
    const bodyParameters = [
      input.customerName || 'Customer',
      input.vehiclePlate || 'Vehicle',
      input.expiryDate || 'Soon',
      input.centreName || 'PUC Testing Centre',
      input.ownerName || 'Centre Owner',
      input.centreAddress || 'Station Road',
      input.contactNumber || 'Contact Office',
    ];

    this.logger.log(
      `Sending WhatsApp template "${templateName}" to ${this.maskPhoneNumber(input.to)} for vehicle ${input.vehiclePlate}`,
    );

    const { messageId } = await this.sendTemplateMessage({
      to: input.to,
      templateName,
      languageCode: this.defaultTemplateLanguage,
      bodyParameters,
    });

    return { messageId, template: templateName };
  }

  /**
   * Send Vehicle Insurance Renewal Reminder using approved Meta template "vehicle_insurance".
   * Positional parameters:
   * {{1}}: Customer Name
   * {{2}}: Vehicle Plate
   * {{3}}: Expiry Date
   * {{4}}: Policy Number
   * {{5}}: Insurer Name
   * {{6}}: Centre Name
   * {{7}}: Owner Name
   * {{8}}: Contact Number
   */
  async sendInsuranceReminder(
    input: InsuranceReminderInput,
  ): Promise<{ messageId: string; template: string }> {
    const templateName = this.defaultInsuranceTemplateName;
    const bodyParameters = [
      input.customerName || 'Customer',
      input.vehiclePlate || 'Vehicle',
      input.expiryDate || 'Soon',
      input.policyNumber || 'N/A',
      input.insurerName || 'Insurance Company',
      input.centreName || 'PUC Testing Centre',
      input.ownerName || 'Centre Owner',
      input.contactNumber || 'Contact Office',
    ];

    this.logger.log(
      `Sending WhatsApp template "${templateName}" to ${this.maskPhoneNumber(input.to)} for vehicle ${input.vehiclePlate}`,
    );

    const { messageId } = await this.sendTemplateMessage({
      to: input.to,
      templateName,
      languageCode: this.defaultTemplateLanguage,
      bodyParameters,
    });

    return { messageId, template: templateName };
  }

  /**
   * Send free-form text message (valid within 24-hour service window).
   */
  async sendTextMessage(dto: SendTextMessageDto): Promise<{ messageId: string }> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.normalizePhoneNumber(dto.to),
      type: 'text',
      text: { preview_url: false, body: dto.message },
    };

    const data = await this.postMessage(payload);
    return this.messageResult(data);
  }

  /**
   * List message templates from Meta WABA account.
   */
  async listTemplates(): Promise<unknown[]> {
    const wabaId = this.wabaId;
    if (!wabaId || !this.accessToken) {
      throw new ServiceUnavailableException('WhatsApp Business Account ID or Access Token is missing');
    }

    const url = `${this.apiUrl}/${wabaId}/message_templates?limit=100`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error(`Failed to list Meta WhatsApp templates: ${errText}`);
      throw new BadGatewayException(`Meta API Error: ${errText}`);
    }

    const json: any = await res.json();
    return json.data || [];
  }

  /**
   * Verify incoming Webhook challenge from Meta App Dashboard.
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim();
    if (mode === 'subscribe' && token === expectedToken) {
      this.logger.log('Meta WhatsApp Webhook subscription verified successfully');
      return challenge;
    }
    this.logger.warn(`Meta Webhook verification mismatch: got token "${token}", mode "${mode}"`);
    return null;
  }

  /**
   * Process delivery receipts & message events from Meta.
   */
  processWebhookPayload(body: MetaWebhookPayload): void {
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const val = change.value;
        for (const msg of val?.messages ?? []) {
          this.logger.log(`Incoming WhatsApp message from ${msg.from} (ID: ${msg.id}): ${msg.text?.body || msg.type}`);
        }
        for (const status of val?.statuses ?? []) {
          this.logger.log(
            `WhatsApp status update: ${status.id} -> ${status.status} (recipient: ${status.recipient_id})`,
          );
        }
      }
    }
  }

  /**
   * Internal POST request to Meta Graph API.
   */
  private async postMessage(body: Record<string, unknown>): Promise<MetaMessageResponse> {
    const phoneNumberId = this.phoneNumberId;
    const token = this.accessToken;

    if (!phoneNumberId || !token) {
      this.logger.error('Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN in environment');
      throw new ServiceUnavailableException('WhatsApp Cloud API is not configured in .env');
    }

    const url = `${this.apiUrl}/${phoneNumberId}/messages`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const json: any = await res.json();

      if (!res.ok || json.error) {
        const metaError = json.error;
        const msg =
          metaError?.error_data?.details ||
          metaError?.message ||
          metaError?.error_user_msg ||
          `Meta HTTP ${res.status}`;
        this.logger.error(`Meta WhatsApp send error: ${JSON.stringify(metaError || json)}`);
        throw new BadGatewayException(`WhatsApp API error: ${msg}`);
      }

      return json as MetaMessageResponse;
    } catch (err: any) {
      if (err instanceof BadGatewayException || err instanceof ServiceUnavailableException) {
        throw err;
      }
      this.logger.error(`Exception while calling Meta WhatsApp API: ${err.message || err}`);
      throw new BadGatewayException(err.message || 'Failed to dispatch WhatsApp message');
    }
  }

  private messageResult(data: MetaMessageResponse): { messageId: string } {
    const messageId = data.messages?.[0]?.id;
    if (!messageId) {
      throw new BadGatewayException('Meta WhatsApp API returned no message ID');
    }
    return { messageId };
  }

  /**
   * Normalize phone number to international format:
   * Strips all non-digit characters.
   * If 10 digits starting with 6-9, prefixes with 91 (India).
   */
  normalizePhoneNumber(value: string): string {
    let normalized = value.replace(/[^\d]/g, '');
    if (normalized.length === 10 && /^[6-9]\d{9}$/.test(normalized)) {
      normalized = `91${normalized}`;
    }
    if (!/^[1-9]\d{7,14}$/.test(normalized)) {
      throw new BadGatewayException(
        `Invalid phone number "${value}". Must include valid country code (e.g. 919876543210)`,
      );
    }
    return normalized;
  }

  private maskPhoneNumber(phone: string): string {
    if (phone.length <= 4) return phone;
    const visibleStart = Math.min(4, Math.floor(phone.length / 2));
    const visibleEnd = 2;
    const maskedLength = phone.length - visibleStart - visibleEnd;
    return phone.slice(0, visibleStart) + '*'.repeat(Math.max(3, maskedLength)) + phone.slice(-visibleEnd);
  }
}
