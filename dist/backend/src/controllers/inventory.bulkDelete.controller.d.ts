import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
/**
 * Dry run for the bulk-delete dialog: which of the selected products can go, and
 * for the rest, exactly what is holding each one back.
 */
export declare const bulkCheckCategories: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * Deletes the selected products that have nothing depending on them, and reports
 * back the ones it refused to touch. Anything with sales, price-list rules,
 * customer purchase history, open purchase invoices, project usage or serialised
 * units is left exactly as it was.
 */
export declare const bulkDeleteCategories: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
