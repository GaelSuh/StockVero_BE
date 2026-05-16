import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const uploadFile: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteFile: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
