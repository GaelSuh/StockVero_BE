import { Response } from 'express';
import { AdminRequest } from '../types/index.js';
export declare const getAdminDashboard: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
