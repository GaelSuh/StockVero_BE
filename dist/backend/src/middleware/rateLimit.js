import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
// Shared rate limiters. Login endpoints (brute-force risk) get the strict
// budget; every other endpoint — including the rest of the admin API, which
// used to share the login budget by accident — gets the generous one.
//
// The login budget is counted per email + IP, not per IP alone, so users who
// share a connection do not use up each other's attempts.
export const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // 100 attempts per credential per window
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}-${req.body?.email || 'unknown'}`,
    message: { error: 'Too many attempts. Please try again later.' },
});
export const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 200, // 200 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
});
