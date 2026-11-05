import { Resend } from 'resend';
import nodemailer from 'nodemailer';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM ?? '';

/** The customer app's address (FRONTEND_URL), for links in emails. Unset: emails go out without a link. */
const FRONTEND_URL = process.env.FRONTEND_URL?.trim().replace(/\/+$/, '');
if (!FRONTEND_URL) console.warn('[email] FRONTEND_URL is not set: emails will be sent without links.');
export const appLink = (path: string) => (FRONTEND_URL ? `${FRONTEND_URL}${path}` : undefined);

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const transporter = process.env.EMAIL_HOST
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
}): Promise<boolean> {
  let sent = false;

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
      } else {
        console.log(`[email] Resend sent to ${to}: ${subject} (id=${data?.id})`);
        sent = true;
      }
    } catch (error) {
      console.error(`[email] Resend failed to send to ${to}:`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  if (!sent && transporter) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to,
        subject,
        html,
      });
      console.log(`[email] SMTP sent to ${to}: ${subject}`);
      sent = true;
    } catch (error) {
      console.error(`[email] SMTP failed to send to ${to}:`, error instanceof Error ? error.message : error);
    }
  }

  if (!sent) {
    console.warn(`[email] No email provider configured — skipping email to ${to}: ${subject}`);
  }

  return sent;
}

