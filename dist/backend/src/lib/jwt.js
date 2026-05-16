import jwt from 'jsonwebtoken';
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required.');
}
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = (process.env.JWT_EXPIRES_IN || '7d');
export function generateToken(payload, expiresIn) {
    return jwt.sign(payload, JWT_SECRET, {
        expiresIn: expiresIn || JWT_EXPIRES,
        issuer: 'stockvero-api',
    });
}
export function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}
export function decodeToken(token) {
    try {
        return jwt.decode(token);
    }
    catch {
        return null;
    }
}
