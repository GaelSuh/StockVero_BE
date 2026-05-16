import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare const listRoles: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getRole: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createRole: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateRole: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteRole: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
