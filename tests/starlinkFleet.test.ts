import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import {
  canAccessStarlinkKit,
  requireStarlinkRoles,
  scopeStarlinkKits,
  type StarlinkRole,
} from '../src/middleware/starlinkAuth';
import { buildMemberInviteEmail } from '../src/services/starlinkEmailTemplates';

const KIT_A = '11111111-1111-4111-8111-111111111111';
const KIT_B = '22222222-2222-4222-8222-222222222222';
const KIT_C = '33333333-3333-4333-8333-333333333333';
const kits = [{ id: KIT_A }, { id: KIT_B }, { id: KIT_C }];

/** Build the request shape that requireStarlinkAuth leaves behind. */
function principalReq(role: StarlinkRole, assigned: string[] = []): Request {
  return {
    starlinkRole: role,
    starlinkPrincipal: {
      kind: role === 'owner' ? 'owner' : 'member',
      id: 'member-1',
      role,
      ownerCustomerId: 'owner-1',
      memberId: role === 'owner' ? null : 'member-1',
      kitIds: role === 'owner' ? null : assigned,
    },
  } as unknown as Request;
}

function invoke(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Request
) {
  let status = 0;
  let nextCalled = false;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  middleware(req, res, () => { nextCalled = true; });
  return { status, nextCalled };
}

describe('Starlink fleet role scoping', () => {
  it('lets owner, admin and billing see every kit but confines a viewer to assigned kits', () => {
    expect(scopeStarlinkKits(principalReq('owner'), kits)).toHaveLength(3);
    expect(scopeStarlinkKits(principalReq('admin'), kits)).toHaveLength(3);
    expect(scopeStarlinkKits(principalReq('billing'), kits)).toHaveLength(3);
    expect(scopeStarlinkKits(principalReq('viewer', [KIT_B]), kits).map((k) => k.id)).toEqual([KIT_B]);
  });

  it('checks a single kit before telemetry or checkout access', () => {
    const viewer = principalReq('viewer', [KIT_B]);
    expect(canAccessStarlinkKit(viewer, KIT_B)).toBe(true);
    expect(canAccessStarlinkKit(viewer, KIT_A)).toBe(false);
    expect(canAccessStarlinkKit(principalReq('billing'), KIT_C)).toBe(true);
  });

  it('blocks viewers from owner-only and money routes without changing owner access', () => {
    const ownerOnly = requireStarlinkRoles('owner');
    expect(invoke(ownerOnly, principalReq('owner')).nextCalled).toBe(true);
    expect(invoke(ownerOnly, principalReq('viewer', [KIT_A]))).toMatchObject({ status: 403, nextCalled: false });

    const billing = requireStarlinkRoles('owner', 'admin', 'billing');
    expect(invoke(billing, principalReq('billing')).nextCalled).toBe(true);
    expect(invoke(billing, principalReq('viewer', [KIT_A])).status).toBe(403);
  });
});

describe('Starlink member invitation email', () => {
  it('renders a dark-theme invitation with role, sites and an accepting link', () => {
    const inviteUrl = 'https://starlink.preyone.com/starlink/auth?mode=member-invite&token=' + 'a'.repeat(64);
    const tpl = buildMemberInviteEmail({
      fullName: 'Tendai Moyo',
      email: 'accountant@example.com',
      ownerName: 'Prechard Muvirimi',
      role: 'billing',
      kitLabels: ['Harare North · KIT-123', 'Bulawayo Depot · KIT-456'],
      inviteUrl,
      expiresLabel: '4 December 2026',
    });

    expect(tpl.subject).toMatch(/invited to a Preyone Starlink fleet/i);
    expect(tpl.html).toContain('#0D0F18');
    expect(tpl.html).toContain('#00F0FF');
    expect(tpl.html).toContain('Billing / accountant');
    expect(tpl.html).toContain('Harare North · KIT-123');
    expect(tpl.html).toContain('Bulawayo Depot · KIT-456');
    expect(tpl.html).toContain(inviteUrl.replace(/&/g, '&amp;'));
    expect(tpl.text).toContain(inviteUrl);
    expect(tpl.text).toContain('Link expires: 4 December 2026');
  });

  it('escapes invitee-supplied fields and never names the gateway', () => {
    const tpl = buildMemberInviteEmail({
      fullName: '<script>alert(1)</script> Eve',
      email: 'eve@example.com',
      ownerName: 'Ann <b>Owner</b>',
      role: 'viewer',
      kitLabels: [],
      inviteUrl: 'https://starlink.preyone.com/starlink/auth?mode=member-invite',
      expiresLabel: 'soon',
    });

    expect(tpl.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(tpl.html).not.toContain('<script>alert(1)</script>');
    expect(tpl.html).not.toContain('<b>Owner</b>');
    expect(tpl.text).toContain('All fleet kits');
    expect(`${tpl.html} ${tpl.text}`.toLowerCase()).not.toContain('pesepay');
  });
});

describe('Starlink fleet additive integration surface', () => {
  const db = readFileSync(resolve(__dirname, '../src/db/starlink.ts'), 'utf8');
  const routes = readFileSync(resolve(__dirname, '../src/routes/starlink.ts'), 'utf8');
  const payments = readFileSync(resolve(__dirname, '../src/routes/payments.ts'), 'utf8');
  const fleetPanel = readFileSync(resolve(__dirname, '../admin/src/starlink/FleetPanel.tsx'), 'utf8');
  const telemetryPanel = readFileSync(resolve(__dirname, '../admin/src/starlink/TelemetryPanel.tsx'), 'utf8');
  const portal = readFileSync(resolve(__dirname, '../admin/src/starlink/StarlinkPortal.tsx'), 'utf8');

  it('keeps single-kit columns while adding fleet metadata and ledger tables', () => {
    for (const column of ['site_name', 'gps_lat', 'gps_lng', 'hardware_model', 'pending_status']) {
      expect(db).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const table of [
      'starlink_credit_transfers',
      'starlink_account_members',
      'starlink_kit_service_requests',
    ]) {
      expect(db).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(db).toMatch(/role\s+TEXT NOT NULL CHECK \(role IN \('admin', 'billing', 'viewer'\)\)/);
    expect(db).toContain('>= 12) return');
  });

  it('moves data with locked rows, a conditional debit and a unique FLEET event key', () => {
    expect(db).toContain('data_credit_gb >= $3');
    expect(db).toContain('FOR UPDATE');
    expect(db).toMatch(/event_key\s+TEXT NOT NULL UNIQUE/);
    expect(db).toContain("category: 'FLEET'");
    expect(db).toContain('starlink-fleet-transfer:');
    expect(db).toContain('starlink-service-state:');
    expect(routes).toContain('idempotencyKey');
    expect(routes).not.toContain("const keyTime = effectiveAt ? effectiveAt.toISOString() : 'now'");
    expect(routes).toContain('crypto.randomUUID()}');
  });

  it('clears scheduled state when a kit status is edited manually and validates coordinates', () => {
    expect(db).toContain('pending_status   = CASE WHEN $5::boolean THEN NULL ELSE pending_status END');
    expect(db).toContain('WHERE kit_id = $1 AND customer_id = $2 AND applied_at IS NULL');
    expect(db).toContain("axis === 'lat' ? 90 : 180");
  });

  it('supports invite resend, access edits and revocation with session invalidation', () => {
    expect(db).toContain('accepted_at = NULL');
    expect(db).toContain('password_hash = NULL');
    expect(db).toContain('export async function deleteStarlinkAccountMember');
    expect(routes).toContain("post('/members/:id/resend-invite'");
    expect(routes).toContain("patch('/members/:id'");
    expect(routes).toContain("delete('/members/:id'");
  });

  it('exposes the fleet, transfer, service-state and member endpoints with role gates', () => {
    for (const path of [
      "get('/fleet'",
      "post('/kits/transfer-data'",
      "post('/kits/:kitId/service-state'",
      "get('/members'",
      "post('/members/invite'",
      "post('/members/:id/resend-invite'",
      "patch('/members/:id'",
      "delete('/members/:id'",
      "post('/members/accept'",
    ]) {
      expect(routes).toContain(path);
    }
    expect(routes).toContain("requireStarlinkRoles('owner', 'admin', 'billing')");
    expect(routes).toContain("type: 'starlink-member'");
    expect(payments).toContain("requireStarlinkRoles('owner', 'admin', 'billing')");
  });

  it('shows the fleet overview only for multi-kit accounts and never bills a viewer', () => {
    expect(fleetPanel).toContain('allKits.length < 2');
    expect(fleetPanel).toContain('permissions.canBill');
    expect(fleetPanel).toContain('Consolidated PDF');
    expect(fleetPanel).toContain('slTransferData');
    expect(fleetPanel).toContain('slSetServiceState');
    expect(fleetPanel).toContain('slInviteMember');
    expect(fleetPanel).toContain('slPatchKit');
    expect(fleetPanel).toContain('slResendMemberInvite');
    expect(fleetPanel).toContain('slRemoveMember');
    expect(fleetPanel).toContain('idempotencyKey');
    expect(telemetryPanel).toContain('readOnly');
    expect(telemetryPanel).toContain('{!readOnly && (');
    expect(portal).toContain("readOnly={role === 'viewer' || role === 'billing'}");
    expect(portal).toContain("role !== 'viewer' && customer.emailVerified === false");
    expect(portal).toContain("role !== 'viewer' && !customer.planCode");
    expect(routes).toContain("get('/plan-applications', requireStarlinkAuth, requireStarlinkRoles('owner', 'admin', 'billing')");
  });
});
