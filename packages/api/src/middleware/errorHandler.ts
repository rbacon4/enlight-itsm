import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
      statusCode: err.statusCode,
    });
    return;
  }

  // Zod validation failures → 400 with the first field message (not a 500).
  if (err instanceof ZodError) {
    const first = err.errors[0];
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: first?.message ?? 'Invalid request.',
      statusCode: 400,
    });
    return;
  }

  logger.error('Unhandled error', { err, path: req.path, method: req.method });

  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    statusCode: 500,
  });
}
