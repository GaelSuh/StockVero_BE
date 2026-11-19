import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { sendEmail } from '../services/emailService.js';

// "Book an appointment" on the public landing page. Nothing is stored: the
// request is emailed to Digisol, with Reply going straight to the visitor.
const router = Router();

/** Where the requests go. Same default as the app's VITE_SUPPORT_EMAIL. */
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL?.trim() || 'tiwa.ndika@digisolgroup.net';

// Public and unauthenticated, and every call sends an email: keep it small.
const appointmentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

const optional = (max: number) => z.string().trim().max(max).optional();
const schema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: optional(40),
  company: optional(120),
  preferredDate: optional(80),
  message: optional(2000),
});

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * @openapi
 * /api/v1/appointments:
 *   post:
 *     summary: Book an appointment (public landing page); emailed to Digisol
 *     tags: [Public]
 *     security: []
 *     responses:
 *       200: { description: Request sent }
 *       400: { description: Invalid form }
 *       429: { description: Too many requests }
 *       503: { description: Email could not be sent }
 */
router.post('/', appointmentLimiter, async (req: Request, res: Response) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Please enter your name and a valid email address.' });
  }
  const d = parsed.data;
  const rows: [string, string | undefined][] = [
    ['Name', d.name],
    ['Email', d.email],
    ['Phone', d.phone],
    ['Company', d.company],
    ['Preferred date', d.preferredDate],
  ];
  const html = `
    <h2>New appointment request</h2>
    <table cellpadding="4">${rows
      .filter(([, v]) => v)
      .map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${escape(v!)}</td></tr>`)
      .join('')}</table>
    ${d.message ? `<p><strong>Message</strong></p><p style="white-space:pre-wrap">${escape(d.message)}</p>` : ''}
    <p style="color:#5b6475">Sent from the StockVero website. Reply to this email to answer ${escape(d.name)}.</p>`;

  const sent = await sendEmail({
    to: SUPPORT_EMAIL,
    subject: `Appointment request: ${d.name.replace(/[\r\n]+/g, ' ')}`,
    html,
    replyTo: d.email,
  });
  // Saying "sent" when it wasn't is how these requests got lost before.
  if (!sent) {
    return res.status(503).json({ success: false, message: 'Your request could not be sent. Please try again or contact us directly.' });
  }
  return res.json({ success: true, message: 'Request sent', data: { message: 'Request sent' } });
});

export default router;
