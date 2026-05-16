import { Response, NextFunction } from 'express';
import { verifyToken } from '../lib/jwt.js';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';
import { AuthRequest } from '../types/index.js';
import { UserRole } from '@prisma/client';
import { prisma } from '../db.js';

export async function tenantGuard(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = extractToken(req);
    if (!token) throw new UnauthorizedError('Missing authorization token');

    const decoded = verifyToken(token);
    
    if (!decoded.tenantId || !decoded.userId) {
      return res.status(401).json({ error: 'Invalid token: missing credentials' });
    }

    if (decoded.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!decoded.accountType) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (decoded.accountType === 'owner') {
      if (!decoded.userId) {
        return res.status(401).json({ error: 'Invalid token: missing user ID' });
      }
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { tenantId: true, tokenVersion: true, isActive: true },
      });

      if (!user || user.tenantId !== decoded.tenantId) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      if (!user.isActive) {
        return res.status(403).json({ error: 'Your account has been deactivated.' });
      }

      if (typeof decoded.tokenVersion !== 'number') {
        return res.status(401).json({ error: 'Invalid token' });
      }

      if (user.tokenVersion !== decoded.tokenVersion) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    }

    if (decoded.accountType === 'employee') {
      if (!decoded.userId) {
        return res.status(401).json({ error: 'Invalid token: missing user ID' });
      }
      const employee = await prisma.employee.findUnique({
        where: { id: decoded.userId },
        select: { tenantId: true, tokenVersion: true, isActive: true },
      });

      if (!employee || employee.tenantId !== decoded.tenantId) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      if (!employee.isActive) {
        return res.status(403).json({ error: 'Your account has been deactivated.' });
      }

      if (employee.tokenVersion !== decoded.tokenVersion) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    }

    req.user = {
      id: decoded.userId,
      email: '', // Not included in token
      tenantId: decoded.tenantId,
      role: decoded.role,
      accountType: decoded.accountType,
      roleId: decoded.roleId,
      isAdmin: decoded.isAdmin,
    };
    req.tenantId = decoded.tenantId;
    req.activeModules = decoded.active_modules;
    req.permissions = decoded.permissions || undefined;
    req.mustChangePassword = decoded.mustChangePassword || false;
    req.tokenVersion = decoded.tokenVersion;

    next();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return res.status(401).json({ error: error.message });
    }
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function moduleGuard(requiredModule: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.activeModules?.includes(requiredModule)) {
      return res.status(403).json({ error: 'Module not enabled for this tenant' });
    }
    next();
  };
}

export function mustChangePasswordGuard(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.mustChangePassword) {
    return res.status(403).json({ code: 'MUST_CHANGE_PASSWORD' });
  }
  next();
}

export function permissionGuard(
  moduleKey: string,
  action: 'canRead' | 'canCreate' | 'canUpdate' | 'canDelete'
) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.accountType === 'owner') {
      return next();
    }

    if (req.user?.accountType === 'employee') {
      const perm = req.permissions?.[moduleKey];
      if (perm && perm[action]) {
        return next();
      }
    }

    return res.status(403).json({
      code: 'PERMISSION_DENIED',
      module: moduleKey,
      action,
    });
  };
}

export function adminGuard(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.accountType === 'owner' || req.user?.isAdmin) {
    return next();
  }
  return res.status(403).json({ code: 'PERMISSION_DENIED' });
}

export function roleGuard(roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ForbiddenError('Insufficient permissions');
    }
    next();
  };
}

function extractToken(req: AuthRequest): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}
