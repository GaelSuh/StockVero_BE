import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/index.js';
import { UserRole } from '@prisma/client';
export declare function tenantGuard(req: AuthRequest, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
export declare function moduleGuard(requiredModule: string): (req: AuthRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
export declare function mustChangePasswordGuard(req: AuthRequest, res: Response, next: NextFunction): Response<any, Record<string, any>> | undefined;
export declare function permissionGuard(moduleKey: string, action: 'canRead' | 'canCreate' | 'canUpdate' | 'canDelete'): (req: AuthRequest, res: Response, next: NextFunction) => void | Response<any, Record<string, any>>;
export declare function adminGuard(req: AuthRequest, res: Response, next: NextFunction): void | Response<any, Record<string, any>>;
export declare function roleGuard(roles: UserRole[]): (req: AuthRequest, res: Response, next: NextFunction) => void;
