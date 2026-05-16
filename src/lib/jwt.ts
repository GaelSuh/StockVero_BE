import jwt, { SignOptions } from 'jsonwebtoken';
import { JWTPayload } from '../types/index.js';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required.');
}
const JWT_SECRET: string = process.env.JWT_SECRET;
const JWT_EXPIRES = (process.env.JWT_EXPIRES_IN || '7d') as SignOptions['expiresIn'];

export function generateToken(payload: JWTPayload, expiresIn?: string): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: (expiresIn as SignOptions['expiresIn']) || JWT_EXPIRES,
    issuer: 'stockvero-api',
  });
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}

export function decodeToken(token: string): JWTPayload | null {
  try {
    return jwt.decode(token) as JWTPayload;
  } catch {
    return null;
  }
}
