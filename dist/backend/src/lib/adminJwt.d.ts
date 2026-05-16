import { AdminJWTPayload } from '../types/index.js';
export declare function generateAdminToken(payload: AdminJWTPayload): string;
export declare function verifyAdminToken(token: string): AdminJWTPayload;
