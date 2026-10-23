import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const getTenantModules: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateMyTenant: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateMyTenantTheme: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateTenantModule: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * The business types on offer, with the modules each suggests.
 *
 * Served rather than duplicated as a constant in the client so the two cannot
 * drift: this file decides what may be stored, so it should also decide what is
 * offered.
 */
export declare const listIndustries: (_req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
