import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../types/index.js';
export declare const fetchCategoryById: (tenantId: string, id: string) => any;
/**
 * Record a category-level stock event with before/after available counts.
 */
export declare const recordStockEvent: (opts: {
    tenantId: string;
    categoryId: string;
    categoryType?: string;
    unitSystemId?: string | null;
    eventType: string;
    delta: number;
    title: string;
    notes?: string | null;
    performedBy?: string | null;
}) => Promise<void>;
export declare const resolveIdentifierLabel: (identifierType: string | undefined, providedLabel: string | undefined) => string | null;
export declare const CategorySchema: z.ZodObject<{
    name: z.ZodString;
    abbreviation: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<{
        STOCK: "STOCK";
        INVENTORY: "INVENTORY";
    }>>;
    description: z.ZodOptional<z.ZodString>;
    supplier: z.ZodOptional<z.ZodString>;
    costPrice: z.ZodOptional<z.ZodCoercedNumber<unknown>>;
    sellingPrice: z.ZodOptional<z.ZodCoercedNumber<unknown>>;
    plannedQty: z.ZodOptional<z.ZodCoercedNumber<unknown>>;
    plannedDate: z.ZodOptional<z.ZodString>;
    reorderThreshold: z.ZodOptional<z.ZodCoercedNumber<unknown>>;
    identifierType: z.ZodOptional<z.ZodEnum<{
        SERIAL_NUMBER: "SERIAL_NUMBER";
        IMEI: "IMEI";
        BARCODE: "BARCODE";
        QR_CODE: "QR_CODE";
        ASSET_TAG: "ASSET_TAG";
        CUSTOM: "CUSTOM";
        NONE: "NONE";
    }>>;
    identifierLabel: z.ZodOptional<z.ZodString>;
    imageUrl: z.ZodUnion<[z.ZodOptional<z.ZodString>, z.ZodLiteral<"">]>;
    images: z.ZodOptional<z.ZodArray<z.ZodString>>;
    notes: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ProductItemCreateSchema: z.ZodObject<{
    categoryId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    identifierMode: z.ZodEnum<{
        manual: "manual";
        auto: "auto";
    }>;
    userIdentifier: z.ZodOptional<z.ZodString>;
    notes: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const listCategories: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getCategoryById: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createCategory: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateCategory: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteCategory: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const checkCategoryAvailability: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createProductItem: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createProductItems: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const restockRequest: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const listProductItems: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getProductItem: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateProductItem: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteProductItem: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const logMaintenance: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getMaintenanceLogs: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
