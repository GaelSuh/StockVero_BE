import { ApiError } from '../lib/errors.js';
import { ZodError } from 'zod';
export function errorHandler(error, req, res, next) {
    console.error('[ERROR]', error.name, error.message);
    if (error instanceof ApiError) {
        return res.status(error.statusCode).json({
            error: error.message,
            code: error.code,
        });
    }
    if (error instanceof ZodError) {
        return res.status(400).json({
            error: 'Validation failed',
            details: error.errors,
        });
    }
    res.status(500).json({
        error: 'Internal server error',
    });
}
