import { Response } from 'express';
import { AdminRequest } from '../types/index.js';
export declare const listTenants: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createTenant: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getTenant: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateTenant: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const approveTenant: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const denyTenant: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateTenantStatus: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteTenant: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getTenantModules: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateTenantModules: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateTenantOwner: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const resetTenantOwnerPassword: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * GET /api/admin/v1/tenants/:id/verification-document
 *
 * Issues a short-lived signed URL for a tenant's signup identity document.
 *
 * This is the only way that object can be read. It lives in the private bucket,
 * so its path is not fetchable on its own, and the path is never sent to any
 * client — the URL is minted per request, for an authenticated admin, and
 * expires in ten minutes. Each issue is written to the audit log, because
 * looking at someone's ID card is an access worth recording.
 */
export declare const getTenantVerificationDocument: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
