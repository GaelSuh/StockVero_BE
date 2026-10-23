import { verifyToken } from '../lib/jwt.js';
import { UnauthorizedError, ForbiddenError, isDatabaseUnreachable } from '../lib/errors.js';
import { prisma } from '../db.js';
export async function tenantGuard(req, res, next) {
    try {
        const token = extractToken(req);
        if (!token)
            throw new UnauthorizedError('Missing authorization token');
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
                select: { tenantId: true, tokenVersion: true, isActive: true },
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
                return res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token' });
            }
            if (!employee.isActive) {
                return res.status(403).json({ error: 'Your account has been deactivated.' });
            }
            if (typeof decoded.tokenVersion !== 'number' || employee.tokenVersion !== decoded.tokenVersion) {
                return res.status(401).json({ code: 'INVALID_TOKEN', error: 'Invalid token' });
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
    }
    catch (error) {
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
export function moduleGuard(requiredModule) {
    return (req, res, next) => {
        if (!req.activeModules?.includes(requiredModule)) {
            return res.status(403).json({ error: 'Module not enabled for this tenant' });
        }
        next();
    };
}
export function mustChangePasswordGuard(req, res, next) {
    if (req.mustChangePassword) {
        return res.status(403).json({ code: 'MUST_CHANGE_PASSWORD' });
    }
    next();
}
export function permissionGuard(moduleKey, action) {
    return (req, res, next) => {
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
export function adminGuard(req, res, next) {
    if (req.user?.accountType === 'owner' || req.user?.isAdmin) {
        return next();
    }
    return res.status(403).json({ code: 'PERMISSION_DENIED' });
}
export function roleGuard(roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            throw new ForbiddenError('Insufficient permissions');
        }
        next();
    };
}
function extractToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return null;
    }
    return authHeader.substring(7);
}
