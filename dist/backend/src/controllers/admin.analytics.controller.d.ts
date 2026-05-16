import { Response } from 'express';
import { AdminRequest } from '../types/index.js';
export declare const getGrowthAnalytics: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getModuleAnalytics: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getPlanAnalytics: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getActivityAnalytics: (req: AdminRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
