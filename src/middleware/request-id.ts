import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

/**
 * Request ID middleware.
 *
 * Assigns every incoming request a unique UUID (or forwards the
 * X-Request-Id header if provided by a reverse proxy / Railway).
 *
 * The ID is:
 *   - Attached to req.id for use in log statements
 *   - Echoed back in the X-Request-Id response header
 *   - Included in all error response bodies as { error, request_id }
 *     so users can quote it when reporting issues to Sentry/support.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}
