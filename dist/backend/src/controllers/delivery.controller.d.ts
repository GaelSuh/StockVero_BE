import { Response } from 'express';
import { AuthRequest } from '../types/index.js';
export declare function createDeliveryNote(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function listDeliveryNotes(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function getDeliveryNote(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function updateDeliveryNoteStatus(req: AuthRequest, res: Response): Promise<Response<any, Record<string, any>>>;
