import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const getStats: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
