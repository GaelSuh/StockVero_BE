import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare function createReturn(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function listReturns(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function getReturn(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
/**
 * Headline figures and trends for the returns page.
 *
 * Everything is derived on request rather than stored: returns are low-volume
 * next to sales, and a stored rollup would need invalidating on every refund.
 */
export declare function getReturnsAnalytics(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
