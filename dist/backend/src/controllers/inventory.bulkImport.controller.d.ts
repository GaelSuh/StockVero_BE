import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
/**
 * Canonical form used for *comparison only* — trimmed, inner whitespace collapsed,
 * lowercased. "Soap", "soap " and "SOAP" all normalise to "soap", so they can never
 * become three separate categories. The display name keeps the user's own casing.
 */
export declare const normalizeCategoryName: (value: string) => string;
export declare const listProductCategories: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * Just the names of products already saved, so the import screen can flag a
 * clash while the user is still reviewing rather than at submit time. Kept
 * separate from the full list because it is polled for one field.
 */
export declare const listProductNames: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createProductCategory: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * Creates every product in one transaction — including any brand-new categories the
 * rows reference. Either the whole batch lands or nothing does; a half-imported
 * inventory is worse than no import at all.
 */
export declare const bulkImportProducts: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
