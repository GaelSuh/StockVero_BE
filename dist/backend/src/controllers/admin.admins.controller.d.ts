import { Response } from 'express';
import { AdminRequest } from '../types/index.js';
export declare const listSuperAdmins: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createSuperAdmin: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const changeSuperAdminPassword: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
