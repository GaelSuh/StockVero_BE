import { Request } from 'express';
import { UserRole } from '@prisma/client';
export interface Permission {
    canRead: boolean;
    canCreate: boolean;
    canUpdate: boolean;
    canDelete: boolean;
}
export interface JWTPayload {
    userId: string;
    tenantId?: string;
    tenantSlug?: string;
    accountType?: 'owner' | 'employee';
    active_modules?: string[];
    role?: UserRole;
    roleId?: string;
    mustChangePassword?: boolean;
    tokenVersion?: number;
    permissions?: Record<string, Permission>;
    isAdmin?: boolean;
    userType?: 'OWNER' | 'EMPLOYEE';
    purpose?: 'password_reset';
    iat?: number;
    exp?: number;
}
export interface AdminJWTPayload {
    adminId: string;
    role: 'SUPER_ADMIN';
    iat?: number;
    exp?: number;
}
export interface AuthRequest extends Request {
    user?: {
        id: string;
        email: string;
        tenantId: string;
        role?: UserRole;
        accountType: 'owner' | 'employee';
        roleId?: string;
        isAdmin?: boolean;
    };
    tenantId?: string;
    activeModules?: string[];
    permissions?: Record<string, Permission>;
    mustChangePassword?: boolean;
    tokenVersion?: number;
    file?: Express.Multer.File;
}
export interface AdminRequest extends Request {
    admin?: {
        id: string;
        email: string;
        firstName: string;
        lastName: string;
    };
    adminToken?: string;
}
export interface PaginationQuery {
    page?: number;
    limit?: number;
}
export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}
