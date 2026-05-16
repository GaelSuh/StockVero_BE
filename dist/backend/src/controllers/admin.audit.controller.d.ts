import { Response } from 'express';
import { AdminRequest } from '../types/index.js';
export declare const getTenantAuditLog: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getPlatformAuditLog: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
