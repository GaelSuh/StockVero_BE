import { Response } from 'express';
import { AdminRequest } from '../types/index.js';
export declare const adminLogin: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const adminMe: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const adminLogout: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
