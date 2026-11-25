import { Injectable, Logger, ServiceUnavailableException, BadGatewayException } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export interface SendVerificationEmailInput {
  to: string;
  ownerName: string;
  businessName: string;
  code: string;
}

export interface SendPasswordResetEmailInput {
  to: string;
  ownerName: string;
  code: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  private get smtpHost(): string {
    return process.env.BREVO_SMTP_HOST?.trim() || 'smtp-relay.brevo.com';
  }

  private get smtpPort(): number {
    return Number(process.env.BREVO_SMTP_PORT) || 587;
  }

  private get smtpUser(): string {
    return process.env.BREVO_SMTP_USER?.trim() || '';
  }

  private get smtpKey(): string {
    return process.env.BREVO_SMTP_KEY?.trim() || '';
  }

  private get fromEmail(): string {
    return process.env.BREVO_FROM_EMAIL?.trim() || this.smtpUser || 'no-reply@pucflow.in';
  }

  private get fromName(): string {
    return process.env.BREVO_FROM_NAME?.trim() || 'PUC Flow';
  }

  isConfigured(): boolean {
    return Boolean(this.smtpKey && this.smtpUser);
  }

  hasKeyOnly(): boolean {
    return Boolean(this.smtpKey);
  }

  private createTransporter(): Transporter {
    if (!this.smtpKey) {
      throw new ServiceUnavailableException('Brevo SMTP key (BREVO_SMTP_KEY) is not configured');
    }
    if (!this.smtpUser) {
      throw new ServiceUnavailableException(
        'Brevo SMTP login username (BREVO_SMTP_USER) is missing in server .env',
      );
    }

    return nodemailer.createTransport({
      host: this.smtpHost,
      port: this.smtpPort,
      secure: this.smtpPort === 465,
      auth: {
        user: this.smtpUser,
        pass: this.smtpKey,
      },
    });
  }

  async sendVerificationEmail(input: SendVerificationEmailInput): Promise<{ messageId: string }> {
    const transporter = this.createTransporter();
    const subject = `${input.code} is your PUC Flow verification code`;
    const text = [
      `Hello ${input.ownerName},`,
      '',
      `Welcome to PUC Flow! Please verify your email address for "${input.businessName}" using the code below:`,
      '',
      `Verification Code: ${input.code}`,
      '',
      'If you did not create this PUC centre account, please ignore this email.',
      '',
      'Regards,',
      'PUC Flow Team',
    ].join('\n');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; color: #0f172a;">
        <h2 style="margin: 0 0 12px; color: #4f46e5;">Verify Your PUC Centre Email</h2>
        <p style="margin: 0 0 12px; font-size: 14px;">Hello <strong>${this.escapeHtml(input.ownerName)}</strong>,</p>
        <p style="margin: 0 0 18px; font-size: 14px; color: #475569;">
          Welcome to <strong>PUC Flow</strong>! Use this 6-digit verification code to verify your email for <strong>${this.escapeHtml(input.businessName)}</strong>:
        </p>
        <div style="background: #f8fafc; border: 1px dashed #6366f1; border-radius: 10px; padding: 16px; text-align: center; margin-bottom: 18px;">
          <span style="font-family: monospace; font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #4338ca;">${this.escapeHtml(input.code)}</span>
        </div>
        <p style="margin: 0; font-size: 12px; color: #64748b;">
          If you did not register on PUC Flow, you can safely ignore this message.
        </p>
      </div>
    `;

    try {
      const info = await transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: input.to,
        subject,
        text,
        html,
      });
      this.logger.log(`Sent Brevo verification email to ${input.to} (messageId=${info.messageId})`);
      return { messageId: info.messageId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'SMTP delivery failed';
      this.logger.error(`Failed to send Brevo verification email to ${input.to}: ${msg}`);
      throw new BadGatewayException(`Failed to send verification email: ${msg}`);
    }
  }

  async sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<{ messageId: string }> {
    const transporter = this.createTransporter();
    const subject = `${input.code} is your PUC Flow password reset code`;
    const text = [
      `Hello ${input.ownerName},`,
      '',
      'We received a request to reset your PUC Flow password.',
      '',
      `Password Reset Code: ${input.code}`,
      'This code is valid for 30 minutes.',
      '',
      'If you did not request a password reset, please ignore this email.',
      '',
      'Regards,',
      'PUC Flow Team',
    ].join('\n');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; color: #0f172a;">
        <h2 style="margin: 0 0 12px; color: #4f46e5;">Reset Your PUC Flow Password</h2>
        <p style="margin: 0 0 12px; font-size: 14px;">Hello <strong>${this.escapeHtml(input.ownerName)}</strong>,</p>
        <p style="margin: 0 0 18px; font-size: 14px; color: #475569;">
          Use the 6-digit reset code below to set a new password for your PUC Flow account. This code expires in <strong>30 minutes</strong>.
        </p>
        <div style="background: #f8fafc; border: 1px dashed #6366f1; border-radius: 10px; padding: 16px; text-align: center; margin-bottom: 18px;">
          <span style="font-family: monospace; font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #4338ca;">${this.escapeHtml(input.code)}</span>
        </div>
        <p style="margin: 0; font-size: 12px; color: #64748b;">
          If you did not request this password reset, your account remains safe and no changes were made.
        </p>
      </div>
    `;

    try {
      const info = await transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: input.to,
        subject,
        text,
        html,
      });
      this.logger.log(`Sent Brevo reset email to ${input.to} (messageId=${info.messageId})`);
      return { messageId: info.messageId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'SMTP delivery failed';
      this.logger.error(`Failed to send Brevo reset email to ${input.to}: ${msg}`);
      throw new BadGatewayException(`Failed to send password reset email: ${msg}`);
    }
  }

  private escapeHtml(str: string): string {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
