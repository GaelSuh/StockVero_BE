import { Response, NextFunction } from 'express';
import { AdminRequest } from '../types/index.js';
export declare function adminGuard(req: AdminRequest, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
