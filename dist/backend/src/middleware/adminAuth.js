import { verifyAdminToken } from '../lib/adminJwt.js';
import { isAdminTokenBlocked } from '../lib/adminTokenBlocklist.js';
import { prisma } from '../db.js';
export async function adminGuard(req, res, next) {
    try {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ error: 'Missing authorization token' });
        }
        if (isAdminTokenBlocked(token)) {
            return res.status(401).json({ error: 'Token has been revoked' });
        }
        const decoded = verifyAdminToken(token);
        if (decoded.role !== 'SUPER_ADMIN') {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const admin = await prisma.superAdmin.findUnique({
            where: { id: decoded.adminId },
            select: { id: true, email: true, firstName: true, lastName: true },
        });
        if (!admin) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        req.admin = admin;
        req.adminToken = token;
        next();
    }
    catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
function extractToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return null;
    }
    return authHeader.substring(7);
}
