import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const getAnalyticsOverview: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const exportAnalyticsPdf: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
