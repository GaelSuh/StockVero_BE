import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../lib/errors.js';
import { ZodError } from 'zod';
import { MulterError } from 'multer';

/**
 * Upload rejections are the caller's fault, not ours. Without this they reach
 * the generic branch below and surface as an opaque 500 — which is what a
 * phone-camera photo over the size cap used to return.
 */
const MULTER_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: 'That file is too large. Choose a smaller one.',
  LIMIT_FILE_COUNT: 'Too many files. Upload them one at a time.',
  LIMIT_UNEXPECTED_FILE: 'That file was sent under an unexpected field name.',
};

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

  if (error instanceof MulterError) {
    return res.status(400).json({
      error: MULTER_MESSAGES[error.code] || 'That file could not be accepted.',
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
