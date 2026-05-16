import jwt, { SignOptions } from 'jsonwebtoken';
import { AdminJWTPayload } from '../types/index.js';

if (!process.env.ADMIN_JWT_SECRET) {
  throw new Error('ADMIN_JWT_SECRET environment variable is required. It MUST be different from JWT_SECRET.');
}
const ADMIN_JWT_SECRET: string = process.env.ADMIN_JWT_SECRET;
const ADMIN_JWT_EXPIRES = (process.env.ADMIN_JWT_EXPIRES_IN || '8h') as SignOptions['expiresIn'];

export function generateAdminToken(payload: AdminJWTPayload): string {
  return jwt.sign(payload, ADMIN_JWT_SECRET, {
    expiresIn: ADMIN_JWT_EXPIRES,
    issuer: 'stockvero-admin',
  });
}

export function verifyAdminToken(token: string): AdminJWTPayload {
  return jwt.verify(token, ADMIN_JWT_SECRET) as AdminJWTPayload;
}

