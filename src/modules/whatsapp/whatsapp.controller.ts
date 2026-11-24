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
  Logger,
} from '@nestjs/common';
import { TenantAuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { WhatsAppService, type MetaWebhookPayload } from './whatsapp.service';

@Controller(['api/whatsapp', 'whatsapp'])
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(private readonly whatsappService: WhatsAppService) {}

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
      language: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
    };
  }
}
