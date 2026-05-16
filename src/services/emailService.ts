import { Resend } from 'resend';
import nodemailer from 'nodemailer';

// ── Email provider: Resend in production, Gmail SMTP as fallback ──────────────

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const RESEND_FROM = process.env.RESEND_FROM || 'SolarFlow <noreply@resend.dev>';

const transporter = (!resend && process.env.EMAIL_HOST)
  ? nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT || 587),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    })
  : null;

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  // Prefer Resend (production), fall back to SMTP (development)
  if (resend) {
    try {
      const { data, error } = await resend.emails.send({
        from: RESEND_FROM,
        to,
        subject,
        html,
      });
      if (error) {
        console.error(`[email] Resend rejected email to ${to} (${subject}):`, JSON.stringify(error));
        return;
      }
      console.log(`[email] Sent to ${to}: ${subject} (id=${data?.id})`);
    } catch (error) {
      console.error(`[email] Resend failed to send to ${to}:`, error instanceof Error ? error.message : 'Unknown error');
    }
    return;
  }

  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to,
        subject,
        html,
      });
      console.log(`[email] Sent to ${to}: ${subject}`);
    } catch (error) {
      console.error(`[email] SMTP failed to send to ${to}:`, error instanceof Error ? error.message : error);
    }
    return;
  }

  console.warn(`[email] No email provider configured — skipping email to ${to}: ${subject}`);
}

