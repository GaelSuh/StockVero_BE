import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare function createPriceList(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function listPriceLists(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function getPriceList(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function updatePriceList(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
/**
 * GET /:id/can-delete — the DependencyReport the shared DeleteDialog renders.
 * Always allows the delete; the dependencies are warnings about what the
 * customer on this list loses, not blockers.
 */
export declare function canDeletePriceList(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function deletePriceList(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function assignCustomerToPriceList(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function removeCustomerFromPriceList(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
