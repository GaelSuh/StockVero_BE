import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const getMyProfile: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateMyProfile: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateMyPassword: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getMyPreferences: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateMyPreferences: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
