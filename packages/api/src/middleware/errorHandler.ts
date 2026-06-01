import { Request, Response, NextFunction } from 'express';
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

  logger.error('Unhandled error', { err, path: req.path, method: req.method });

  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    statusCode: 500,
  });
}
