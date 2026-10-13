import { useState, useEffect, useCallback } from 'react';
import { systemApi } from '../api/client';
import { showToast } from '../utils/toast';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';

interface PermissionRow { code: string; description: string | null }

/**
 * Level-0 (system.developer) platform settings — wires the previously
 * backend-only endpoints: GET/PUT /feature-flags, GET/PUT /payment-keys,
 * GET /permissions, GET /users/:id/permissions.
 */
export default function PlatformSettings() {
  const [loading, setLoading] = useState(true);

  // Feature flags
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [newFlagName, setNewFlagName] = useState('');
  const [flagsSaving, setFlagsSaving] = useState(false);

  // Payment keys (values arrive masked; only newly-typed values are sent)
  const [payKeys, setPayKeys] = useState<Record<string, string>>({});
  const [payDrafts, setPayDrafts] = useState<Record<string, string>>({});
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [paySaving, setPaySaving] = useState(false);

  // Permission catalog
  const [perms, setPerms] = useState<PermissionRow[]>([]);

  // Per-user permission lookup
  const [lookupId, setLookupId] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupResult, setLookupResult] = useState<{ role: string; permissions: string[] } | null>(null);
  const [lookupError, setLookupError] = useState('');

  const load = useCallback(async () => {
    try {
      const [f, p, catalog] = await Promise.all([
        systemApi.get<Record<string, boolean>>('/feature-flags').catch(() => ({})),
        systemApi.get<Record<string, string>>('/payment-keys').catch(() => ({})),
        systemApi.get<PermissionRow[]>('/permissions').catch(() => [] as PermissionRow[]),
      ]);
      // Flags may contain non-boolean values — coerce for the toggles.
      const boolFlags: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(f || {})) boolFlags[k] = !!v;
      setFlags(boolFlags);
      setPayKeys(p || {});
      setPerms(catalog || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveFlags = async () => {
    setFlagsSaving(true);
    try {
      await systemApi.put('/feature-flags', flags);
      showToast({ title: 'Feature Flags Saved', message: `${Object.keys(flags).length} flag(s) stored`, type: 'success' });
    } catch (e: any) {
      showToast({ title: 'Failed', message: e.message || 'Could not save flags', type: 'error' });
    } finally {
      setFlagsSaving(false);
    }
  };

  const savePayKeys = async () => {
    // Only send keys the operator actually typed into — the backend merges,
    // so masked values on screen are never written back over live secrets.
    const changed: Record<string, string> = {};
    for (const [k, v] of Object.entries(payDrafts)) {
      if (v && v.trim()) changed[k] = v.trim();
    }
    if (newKeyName.trim() && newKeyValue.trim()) {
      changed[newKeyName.trim()] = newKeyValue.trim();
    }
    if (Object.keys(changed).length === 0) {
      showToast({ title: 'Nothing to save', message: 'Type a new value into at least one key first', type: 'error' });
      return;
    }
    setPaySaving(true);
    try {
      await systemApi.put('/payment-keys', changed);
      showToast({ title: 'Payment Keys Saved', message: `Updated: ${Object.keys(changed).join(', ')}`, type: 'success' });
      setPayDrafts({});
      setNewKeyName('');
      setNewKeyValue('');
      await load();
    } catch (e: any) {
      showToast({ title: 'Failed', message: e.message || 'Could not save keys', type: 'error' });
    } finally {
      setPaySaving(false);
    }
  };

  const lookupUser = async () => {
    const id = lookupId.trim();
    if (!id) return;
    setLookupBusy(true);
    setLookupError('');
    setLookupResult(null);
    try {
      const data = await systemApi.get<{ role: string; permissions: string[] }>(`/users/${encodeURIComponent(id)}/permissions`);
      setLookupResult(data);
    } catch (e: any) {
      setLookupError(e.message || 'Lookup failed');
    } finally {
      setLookupBusy(false);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Platform Settings</h1>
        <p className="page-desc">Feature flags, payment gateway keys and the permission catalog (system administrators only).</p>
      </div>

      {/* ── Feature flags ── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 className="card-title">Feature flags</h2>
        <p className="page-desc" style={{ marginBottom: '1rem' }}>
          Toggle platform-wide features. Values persist in the settings table and are read by the API at runtime.
        </p>
        {Object.keys(flags).length === 0 ? (
          <EmptyState title="No flags yet" message="Add a feature flag below to get started." />
        ) : (
          <div style={{ display: 'grid', gap: '0.6rem', marginBottom: '1rem' }}>
            {Object.entries(flags).map(([k, v]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={v}
                  onChange={(e) => setFlags(prev => ({ ...prev, [k]: e.target.checked }))}
                />
                <code>{k}</code>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{v ? 'enabled' : 'disabled'}</span>
              </label>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.8rem' }}>
          <input
            placeholder="new_flag_name"
            value={newFlagName}
            onChange={(e) => setNewFlagName(e.target.value.replace(/[^a-zA-Z0-9_.-]/g, ''))}
            style={{ flex: 1 }}
          />
          <button
            className="btn-secondary"
            disabled={!newFlagName.trim() || newFlagName in flags}
            onClick={() => { setFlags(prev => ({ ...prev, [newFlagName.trim()]: false })); setNewFlagName(''); }}
          >
            Add flag
          </button>
        </div>
        <button className="btn-primary" disabled={flagsSaving} onClick={saveFlags}>
          {flagsSaving ? 'Saving…' : 'Save feature flags'}
        </button>
      </div>

      {/* ── Payment keys ── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 className="card-title">Payment gateway keys</h2>
        <p className="page-desc" style={{ marginBottom: '1rem' }}>
          Stored values are masked. Type a new value into a field to rotate that key — blank fields are left untouched.
        </p>
        {Object.keys(payKeys).length === 0 ? (
          <EmptyState title="No payment keys" message="Queue a key below to store the first gateway secret." />
        ) : (
          <div style={{ display: 'grid', gap: '0.7rem', marginBottom: '1rem' }}>
            {Object.entries(payKeys).map(([k, masked]) => (
              <div key={k} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '0.5rem', alignItems: 'center' }}>
                <code>{k}</code>
                <input
                  type="password"
                  placeholder={masked}
                  value={payDrafts[k] || ''}
                  onChange={(e) => setPayDrafts(prev => ({ ...prev, [k]: e.target.value }))}
                  autoComplete="new-password"
                />
                <span style={{ fontSize: '0.78rem', color: payDrafts[k] ? 'var(--purple-glow)' : 'var(--text-muted)' }}>
                  {payDrafts[k] ? 'will update' : 'unchanged'}
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '0.5rem', marginBottom: '0.8rem' }}>
          <input placeholder="NEW_KEY_NAME" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value.toUpperCase())} />
          <input
            type="password"
            placeholder="secret value"
            value={newKeyValue}
            onChange={(e) => setNewKeyValue(e.target.value)}
            autoComplete="new-password"
          />
          <button
            className="btn-secondary"
            disabled={!newKeyName.trim() || !newKeyValue.trim()}
            onClick={() => { setPayDrafts(prev => ({ ...prev, [newKeyName.trim()]: newKeyValue.trim() })); setNewKeyName(''); setNewKeyValue(''); }}
          >
            Queue key
          </button>
        </div>
        <button className="btn-primary" disabled={paySaving} onClick={savePayKeys}>
          {paySaving ? 'Saving…' : 'Save payment keys'}
        </button>
      </div>

      {/* ── Permission catalog ── */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 className="card-title">Permission catalog</h2>
        {perms.length === 0 ? (
          <EmptyState title="No catalog" message="The permissions table is empty or unavailable." />
        ) : (
          <table className="data-table">
            <thead><tr><th>Code</th><th>Description</th></tr></thead>
            <tbody>
              {perms.map((p) => (
                <tr key={p.code}>
                  <td><code>{p.code}</code></td>
                  <td>{p.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Per-user permission lookup ── */}
      <div className="card">
        <h2 className="card-title">User permission lookup</h2>
        <p className="page-desc" style={{ marginBottom: '0.8rem' }}>
          Paste an admin user ID to see the role and effective permissions the API grants them.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.8rem' }}>
          <input
            placeholder="admin user UUID"
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn-secondary" disabled={lookupBusy || !lookupId.trim()} onClick={lookupUser}>
            {lookupBusy ? 'Looking up…' : 'Look up'}
          </button>
        </div>
        {lookupError && <p style={{ color: 'var(--danger, #ef4444)' }}>{lookupError}</p>}
        {lookupResult && (
          <div>
            <p><strong>Role:</strong> {lookupResult.role}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {lookupResult.permissions.length === 0
                ? <span style={{ color: 'var(--text-muted)' }}>No permissions granted.</span>
                : lookupResult.permissions.map((p) => (
                    <span key={p} className="badge" style={{ background: 'rgba(168,85,247,0.15)', padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.8rem' }}>
                      {p}
                    </span>
                  ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
