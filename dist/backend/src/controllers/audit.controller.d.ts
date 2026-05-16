import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const listAuditLogs: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getAuditSummary: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getAuditActions: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
