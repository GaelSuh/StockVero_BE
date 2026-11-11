import { Request } from 'express';
import { UserRole } from '@prisma/client';

export interface Permission {
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface JWTPayload {
  userId?: string;
  tenantId?: string;
  tenantSlug?: string;
  /** Active branch id, or 'all' for the owner's All branches view. Absent in tokens issued before branches: treated as the main / home branch. */
  branchId?: string;
  accountType?: 'owner' | 'employee';
  active_modules?: string[];
  role?: UserRole;
  roleId?: string;
  mustChangePassword?: boolean;
  tokenVersion?: number;
  permissions?: Record<string, Permission>;
  isAdmin?: boolean;
  userType?: 'OWNER' | 'EMPLOYEE';
  email?: string;
  purpose?: 'password_reset' | 'email_verification';
  iat?: number;
  exp?: number;
}

export interface AdminJWTPayload {
  adminId: string;
  role: 'SUPER_ADMIN';
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request<Record<string, string>> {
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
  /** The branch this request works in; null = All branches (read-only). Set by tenantGuard. */
  branchId?: string | null;
  activeModules?: string[];
  permissions?: Record<string, Permission>;
  mustChangePassword?: boolean;
  tokenVersion?: number;
  file?: Express.Multer.File;
}

export interface AdminRequest extends Request<Record<string, string>> {
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
