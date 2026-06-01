export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  notFound: (entity: string) =>
    new AppError(404, 'NOT_FOUND', `${entity} not found`),
  unauthorized: () =>
    new AppError(401, 'UNAUTHORIZED', 'Authentication required'),
  forbidden: () =>
    new AppError(403, 'FORBIDDEN', 'Insufficient permissions'),
  badRequest: (message: string) =>
    new AppError(400, 'BAD_REQUEST', message),
  conflict: (message: string) =>
    new AppError(409, 'CONFLICT', message),
  internal: (message = 'Internal server error') =>
    new AppError(500, 'INTERNAL_ERROR', message),
};
