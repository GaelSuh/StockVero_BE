import { JWTPayload } from '../types/index.js';
export declare function generateToken(payload: JWTPayload, expiresIn?: string): string;
export declare function verifyToken(token: string): JWTPayload;
export declare function decodeToken(token: string): JWTPayload | null;
