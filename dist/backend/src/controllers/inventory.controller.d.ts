import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const createItem: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const listItems: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getItem: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateItem: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteItem: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createMovement: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare function checkAndNotifyLowStock(tenantId: string, productId: string, productName: string, currentStock: number, lowStockAt: number): Promise<void>;
