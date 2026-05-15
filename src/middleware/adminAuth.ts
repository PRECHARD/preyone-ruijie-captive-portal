import { Request, Response, NextFunction } from 'express';

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = typeof req.headers['x-admin-key'] === 'string' ? req.headers['x-admin-key'] : undefined;

  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
