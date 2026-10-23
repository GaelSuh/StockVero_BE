import { Response, NextFunction } from 'express';
import { verifyToken } from '../lib/jwt.js';
import { UnauthorizedError, ForbiddenError, isDatabaseUnreachable } from '../lib/errors.js';
import { AuthRequest } from '../types/index.js';
import { UserRole } from '@prisma/client';
import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';

/** last_seen_at is written at most this often per user. */
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Record that a tenant user was active, without slowing or failing the request.
 * The guard has already read last_seen_at, so a fresh value costs nothing; a stale one
 * fires one UPDATE that is not awaited. Raw SQL so the row's updated_at is not bumped
 * every five minutes, and the WHERE re-checks staleness so concurrent requests write once.
 */
function touchLastSeen(table: 'users' | 'employees', id: string, lastSeenAt: Date | null): void {
  const now = Date.now();
  if (lastSeenAt && now - lastSeenAt.getTime() < LAST_SEEN_INTERVAL_MS) return;
  const cutoff = new Date(now - LAST_SEEN_INTERVAL_MS);
  prisma
    .$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(table)} SET last_seen_at = ${new Date(now)}
      WHERE id = ${id} AND (last_seen_at IS NULL OR last_seen_at < ${cutoff})`)
    .catch((err) => console.warn(`[last-seen] ${table} ${id}: ${String(err?.message ?? err).replace(/\s+/g, ' ').trim()}`));
}

export async function tenantGuard(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = extractToken(req);
    if (!token) throw new UnauthorizedError('Missing authorization token');

    const decoded = verifyToken(token);
    
    if (!decoded.tenantId || !decoded.userId) {
      return res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token: missing credentials' });
    }

    if (decoded.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!decoded.accountType) {
      return res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token' });
    }

    if (decoded.accountType === 'owner') {
      if (!decoded.userId) {
        return res.status(401).json({ error: 'Invalid token: missing user ID' });
      }
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { tenantId: true, tokenVersion: true, isActive: true, lastSeenAt: true },
      });

      if (!user || user.tenantId !== decoded.tenantId) {
        return res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token' });
      }

      if (!user.isActive) {
        return res.status(403).json({ error: 'Your account has been deactivated.' });
      }

      if (typeof decoded.tokenVersion !== 'number') {
        return res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token' });
      }

      if (user.tokenVersion !== decoded.tokenVersion) {
        return res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token' });
      }

      touchLastSeen('users', decoded.userId, user.lastSeenAt);
    }

    if (decoded.accountType === 'employee') {
      if (!decoded.userId) {
        return res.status(401).json({ error: 'Invalid token: missing user ID' });
      }
      const employee = await prisma.employee.findUnique({
        where: { id: decoded.userId },
        select: { tenantId: true, tokenVersion: true, isActive: true, lastSeenAt: true },
      });

      if (!employee || employee.tenantId !== decoded.tenantId) {
        return res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token' });
      }

      if (!employee.isActive) {
        return res.status(403).json({ error: 'Your account has been deactivated.' });
      }

      if (typeof decoded.tokenVersion !== 'number' || employee.tokenVersion !== decoded.tokenVersion) {
        return res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token' });
      }

      touchLastSeen('employees', decoded.userId, employee.lastSeenAt);
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
      return res.status(401).json({ code: 'INVALID_TOKEN', error: error.message });
    }

    // A database that cannot be reached is NOT a bad token. This block used to
    // answer 401 INVALID_TOKEN for every exception, including the Prisma
    // lookups above — so the moment the database blipped, every request in
    // flight came back "your token is invalid" and the client dutifully signed
    // the user out and sent them to the login screen. The token was fine the
    // whole time; there was simply no database available to check its
    // tokenVersion against.
    //
    // 503 is both honest and load-bearing: the client only ends a session on
    // specific 401 codes, so a 5xx leaves the session alone and the user keeps
    // working — which for an offline-capable till means queued sales survive a
    // database outage instead of being stranded behind a login screen.
    if (isDatabaseUnreachable(error)) {
      console.error('[auth] database unreachable while verifying a token — returning 503, session kept');
      return res.status(503).json({
        code: 'SERVICE_UNAVAILABLE',
        error: 'The server is temporarily unable to verify your session. Please try again shortly.',
      });
    }

    res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token' });
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
    if (!req.user || !roles.includes(req.user.role!)) {
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
