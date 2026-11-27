import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  getStarlinkCustomerById,
  getStarlinkAccountMemberById,
  type StarlinkCustomer,
  type StarlinkAccountMember,
  type StarlinkAccountMemberRole,
} from '../db/starlink';

const JWT_SECRET = process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production';

export type StarlinkRole = 'owner' | StarlinkAccountMemberRole;

export interface StarlinkOwnerSession {
  id: string;
  type: 'starlink-customer';
}

export interface StarlinkMemberSession {
  id: string;
  memberId: string;
  ownerCustomerId: string;
  role: StarlinkAccountMemberRole;
  type: 'starlink-member';
}

export type StarlinkSession = StarlinkOwnerSession | StarlinkMemberSession;

/** null kitIds means the whole fleet; a viewer's array is a hard scope. */
export interface StarlinkPrincipal {
  kind: 'owner' | 'member';
  id: string;
  role: StarlinkRole;
  ownerCustomerId: string;
  memberId: string | null;
  kitIds: string[] | null;
}

declare global {
  namespace Express {
    interface Request {
      starlinkCustomer?: StarlinkCustomer;
      starlinkMember?: StarlinkAccountMember;
      starlinkRole?: StarlinkRole;
      starlinkPrincipal?: StarlinkPrincipal;
    }
  }
}

/**
 * Verifies the portal's own HS256 tokens. The original owner token
 * (type: starlink-customer) is completely unchanged. Sub-account tokens use a
 * distinct type and are resolved back to the owner on every request, so every
 * existing handler that reads req.starlinkCustomer keeps its meaning and all
 * money still belongs to the owner customer row.
 */
export async function requireStarlinkAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sign in to continue' });
    return;
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as StarlinkSession;

    if (decoded?.type === 'starlink-customer') {
      if (!decoded.id) {
        res.status(401).json({ error: 'Invalid session' });
        return;
      }
      const customer = await getStarlinkCustomerById(decoded.id);
      if (!customer) {
        res.status(401).json({ error: 'Account not found' });
        return;
      }
      req.starlinkCustomer = customer;
      req.starlinkMember = undefined;
      req.starlinkRole = 'owner';
      req.starlinkPrincipal = {
        kind: 'owner', id: customer.id, role: 'owner', ownerCustomerId: customer.id,
        memberId: null, kitIds: null,
      };
      next();
      return;
    }

    if (decoded?.type === 'starlink-member') {
      const memberId = decoded.memberId || decoded.id;
      if (!memberId || !decoded.ownerCustomerId) {
        res.status(401).json({ error: 'Invalid session' });
        return;
      }
      const member = await getStarlinkAccountMemberById(memberId);
      if (!member || !member.accepted_at || member.owner_customer_id !== decoded.ownerCustomerId) {
        res.status(401).json({ error: 'Sub-account access is no longer active' });
        return;
      }
      const customer = await getStarlinkCustomerById(member.owner_customer_id);
      if (!customer) {
        res.status(401).json({ error: 'Account not found' });
        return;
      }
      req.starlinkCustomer = customer;
      req.starlinkMember = member;
      req.starlinkRole = member.role;
      req.starlinkPrincipal = {
        kind: 'member',
        id: member.id,
        role: member.role,
        ownerCustomerId: customer.id,
        memberId: member.id,
        kitIds: member.assigned_kit_ids,
      };
      next();
      return;
    }

    res.status(401).json({ error: 'Invalid session' });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Session expired. Please sign in again.' });
    } else {
      next(err);
    }
  }
}

/** Additive role gate for endpoints that move money, invite staff or edit kits. */
export function requireStarlinkRoles(...roles: StarlinkRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.starlinkRole ?? (req.starlinkCustomer ? 'owner' : undefined);
    if (!role || !roles.includes(role)) {
      res.status(403).json({ error: 'Your role cannot perform this action' });
      return;
    }
    next();
  };
}

/** Branch technicians see only their assigned kits; billing/admin see the fleet. */
export function canAccessStarlinkKit(req: Request, kitId: string): boolean {
  const role = req.starlinkRole ?? 'owner';
  if (role === 'owner' || role === 'admin' || role === 'billing') return true;
  return (req.starlinkPrincipal?.kitIds ?? []).includes(kitId);
}

export function scopeStarlinkKits<T extends { id: string }>(req: Request, kits: T[]): T[] {
  const role = req.starlinkRole ?? 'owner';
  if (role === 'owner' || role === 'admin' || role === 'billing') return kits;
  const ids = req.starlinkPrincipal?.kitIds ?? [];
  return kits.filter((kit) => ids.includes(kit.id));
}
