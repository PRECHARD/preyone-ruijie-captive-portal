import { pool } from '../db/pool';

export interface TransitAuditInput {
  companyId?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export async function transitAudit(input: TransitAuditInput) {
  try {
    await pool.query(
      `INSERT INTO transit_audit_log (company_id, user_id, device_id, action, entity, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.companyId || null,
        input.userId || null,
        input.deviceId || null,
        input.action,
        input.entity || '',
        input.entityId || '',
        (input.metadata && JSON.stringify(input.metadata)) || null,
      ]
    );
  } catch (err) {
    console.error('transitAudit failed (non-fatal):', err);
  }
}

export interface SecurityEventInput {
  companyId?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  event: string;
  detail?: string;
  ip?: string;
}

export async function transitSecurityEvent(input: SecurityEventInput) {
  try {
    await pool.query(
      `INSERT INTO transit_security_events (company_id, user_id, device_id, event, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.companyId || null,
        input.userId || null,
        input.deviceId || null,
        input.event,
        input.detail || '',
        input.ip || '',
      ]
    );
  } catch (err) {
    console.error('transitSecurityEvent failed (non-fatal):', err);
  }
}