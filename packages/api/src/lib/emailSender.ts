/**
 * Lightweight email sender.
 *
 * Uses nodemailer over SMTP. Configuration resolves in this order:
 *   1. Environment variables (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS)
 *   2. Per-org `emailSenderConfig` JSONB column (overrides host/port/user; still
 *      uses SMTP_PASS from the environment as the password because the org config
 *      does not currently store credentials — a future enhancement).
 *
 * If SMTP_HOST (or the org override) is absent, `sendEmail` throws so callers
 * can gracefully skip email alerts when email is not configured.
 */
import nodemailer from 'nodemailer';
import type { EmailSenderConfig } from '@enlight/shared';
import { logger } from './logger.js';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  /** Per-org email config; falls back to env vars when absent. */
  orgEmailConfig?: EmailSenderConfig | null;
}

export function isEmailConfigured(orgEmailConfig?: EmailSenderConfig | null): boolean {
  return Boolean(
    orgEmailConfig?.smtpHost || process.env['SMTP_HOST'],
  );
}

export async function sendEmail({ to, subject, html, orgEmailConfig }: SendEmailOptions): Promise<void> {
  const host = orgEmailConfig?.smtpHost ?? process.env['SMTP_HOST'];
  if (!host) throw new Error('Email not configured: SMTP_HOST is not set');

  const port = orgEmailConfig?.smtpPort ?? parseInt(process.env['SMTP_PORT'] ?? '587', 10);
  const user = orgEmailConfig?.smtpUser ?? process.env['SMTP_USER'];
  const pass = process.env['SMTP_PASS'];           // password always from env
  const fromName = process.env['EMAIL_FROM_NAME'] ?? 'Enlight Alerts';
  const fromAddr = process.env['EMAIL_FROM']      ?? 'alerts@example.com';
  const from = `${fromName} <${fromAddr}>`;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass: pass ?? '' } : undefined,
  });

  await transporter.sendMail({ from, to, subject, html });
  logger.debug('Email sent', { to, subject });
}
