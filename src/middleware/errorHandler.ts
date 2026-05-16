import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../lib/errors.js';
import { ZodError } from 'zod';

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
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
      details: error.issues,
    });
  }

  res.status(500).json({
    error: 'Internal server error',
  });
}
