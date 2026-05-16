import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const getTenantModules: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateMyTenant: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateMyTenantTheme: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateTenantModule: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
