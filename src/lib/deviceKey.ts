import crypto from 'node:crypto';

/**
 * Per-tenant key that unlocks the data a device keeps for offline work (queued
 * sales, customer contacts — see the FE's lib/offline/vault.ts). It is handed
 * only to a signed-in user of that tenant, and the device forgets it at sign-out,
 * so what the device holds stays encrypted until someone signs in again.
 *
 * Derived rather than stored, so there is nothing to migrate. Changing the secret
 * makes data still queued on devices unreadable: set DEVICE_KEY_SECRET once in
 * each environment and do not rotate it casually.
 */
const SECRET = process.env.DEVICE_KEY_SECRET || process.env.JWT_SECRET || '';

export function deviceKeyFor(tenantId: string): string {
  if (!SECRET) throw new Error('DEVICE_KEY_SECRET (or JWT_SECRET) is required.');
  return crypto.createHmac('sha256', SECRET).update(`stockvero-device-key:v1:${tenantId}`).digest('base64');
}
