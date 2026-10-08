import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getStarlinkCustomerById, type StarlinkCustomer } from '../db/starlink';

const JWT_SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';

export interface StarlinkSession {
  id: string;
  type: 'starlink-customer';
}

declare global {
  namespace Express {
    interface Request {
      starlinkCustomer?: StarlinkCustomer;
    }
  }
}

/**
 * Verifies the portal's own HS256 customer token (type: starlink-customer).
 * Admin tokens and transit tokens are rejected by the type claim, so a stolen
 * staff JWT can never unlock a subscriber's wallet or invoices — and vice
 * versa. The customer row is re-read every request so a deleted or reset
 * account is cut off immediately.
 */
export async function requireStarlinkAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sign in to continue' });
    return;
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as StarlinkSession;
    if (decoded.type !== 'starlink-customer' || !decoded.id) {
      res.status(401).json({ error: 'Invalid session' });
      return;
    }
    const customer = await getStarlinkCustomerById(decoded.id);
    if (!customer) {
      res.status(401).json({ error: 'Account not found' });
      return;
    }
    req.starlinkCustomer = customer;
    next();
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Session expired. Please sign in again.' });
    } else {
      next(err);
    }
  }
}
