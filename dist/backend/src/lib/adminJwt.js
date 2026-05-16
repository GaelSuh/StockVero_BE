import jwt from 'jsonwebtoken';
if (!process.env.ADMIN_JWT_SECRET) {
    throw new Error('ADMIN_JWT_SECRET environment variable is required. It MUST be different from JWT_SECRET.');
}
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const ADMIN_JWT_EXPIRES = (process.env.ADMIN_JWT_EXPIRES_IN || '8h');
export function generateAdminToken(payload) {
    return jwt.sign(payload, ADMIN_JWT_SECRET, {
        expiresIn: ADMIN_JWT_EXPIRES,
        issuer: 'stockvero-admin',
    });
}
export function verifyAdminToken(token) {
    return jwt.verify(token, ADMIN_JWT_SECRET);
}
