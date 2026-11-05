/**
 * Startup check of the environment. Imported by server.ts straight after
 * dotenv, before anything reads process.env.
 *
 * Production refuses to start with a setting missing, so a bad deploy fails at
 * once with the names to fix, not later when a client uploads a photo or waits
 * for an email. Development only warns. Every variable is described in
 * ENVIRONMENT.md.
 */
const required = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ADMIN_JWT_SECRET',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'SUPABASE_PRIVATE_BUCKET',
  'CORS_ORIGINS',
  'FRONTEND_URL',
];

const missing = required.filter((name) => !process.env[name]?.trim());

// Email needs one complete provider: Resend, or SMTP.
const resend = ['RESEND_API_KEY', 'RESEND_FROM'];
const smtp = ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_FROM'];
const complete = (names: string[]) => names.every((name) => process.env[name]?.trim());
if (!complete(resend) && !complete(smtp)) {
  missing.push(`${resend.join(' + ')}, or ${smtp.join(' + ')}`);
}

if (missing.length > 0) {
  const message = `Missing environment variables:\n  - ${missing.join('\n  - ')}\nSee ENVIRONMENT.md.`;
  if (process.env.NODE_ENV === 'production') throw new Error(message);
  console.warn(`[env] ${message}`);
}
