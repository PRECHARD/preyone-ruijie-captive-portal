import { Request, Response, NextFunction } from 'express';

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
}

export function errorHandler(
  err: HttpError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Respect explicit status codes (413 payload too large, 422 validation, etc.)
  // so legitimate client errors are not reported as 500s that mislead monitors.
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error(err.stack);
  }
  res
    .status(status)
    .json(status >= 500 ? { error: 'Internal server error' } : { error: err.message || 'Request failed' });
}
