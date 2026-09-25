import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const createCustomer: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const listCustomers: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getCustomer: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getCustomerInvoices: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * A customer's outstanding balance and the sales behind it — reuses
 * getCustomerCreditSales, the same aggregation the Credit Customers list and
 * the delete-dependency check already rely on, so this is one more reader of
 * that single source of truth, not a second computation of it.
 */
export declare const getCustomerCreditSalesController: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
/**
 * Real purchase history — replaces the old manual CustomerPurchase ledger on
 * the Purchases tab, which nobody ever filled in. This is line items from
 * actual completed sales, not a self-reported list.
 */
export declare const getCustomerPurchaseHistoryController: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateCustomer: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteCustomer: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const listCustomerPurchases: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const addCustomerPurchase: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteCustomerPurchase: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
