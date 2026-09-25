import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const createVariant: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
/**
 * POST /categories/:categoryId/variants/generate
 *
 * Creates every combination of a multi-value attribute set in ONE transaction,
 * with ONE audit entry and ONE notification — the same shape updatePriceList
 * uses for a set of price rules. Looping the single-create endpoint from the
 * client would fire a dozen of each for one bulk action.
 *
 * Additive only. Combinations that already exist are skipped, and variants
 * that no longer match the submitted attribute set are LEFT ALONE — removing
 * them here would bypass the delete guard that stops a variant referenced by a
 * sale, a price rule or stock history from being destroyed. Regeneration is
 * not an exception to that rule; removal stays a deliberate deactivate.
 */
export declare const generateVariants: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
/**
 * POST /variants/:id/assign-units
 *
 * Attaches a set of existing units to one variant in a single transaction with
 * ONE audit entry. Looping the single-unit update endpoint would write one
 * audit row per unit for a single thing the person did once — the same reason
 * the matrix generator is a batch endpoint.
 *
 * Deliberately no notification: this feature's notification scope is variant
 * create/delete and price-rule changes, and backfilling attribution onto
 * existing stock is not a change anyone else needs pinged about.
 */
export declare const assignUnitsToVariant: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const listVariants: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const listAllVariantsForTenant: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getVariant: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateVariant: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const setVariantActive: (isActive: boolean) => (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * GET /variants/:id/can-delete
 *
 * Returns the DependencyReport shape the shared DeleteDialog component
 * expects, so a user sees exactly what is blocking a delete before they
 * confirm it. The DELETE below still re-checks — this endpoint is the
 * explanation, not the enforcement.
 */
export declare const canDeleteVariant: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteVariant: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
