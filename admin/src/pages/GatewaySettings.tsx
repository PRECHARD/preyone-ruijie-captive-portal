import { useState, useEffect, useCallback } from 'react';
import { systemApi } from '../api/client';
import { FiSave, FiRadio } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface GatewaySettings {
  gateway_ip?: string;
  gateway_model?: string;
  gateway_port?: string;
  radius_host?: string;
  radius_auth_port?: string;
  radius_acct_port?: string;
  radius_secret?: string;
  ext_login_host?: string;
  ext_login_port?: string;
  auth_mode?: string;
  api_base_url?: string;
  api_secret?: string;
  email_service?: string;
  sms_provider?: string;
}

export default function GatewaySettings() {
  const [form, setForm] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await systemApi.get<GatewaySettings>('/gateway-settings');
      setForm((Object.entries(data) as [string, string][]).reduce<Record<string, string>>((acc, [k, v]) => {
        acc[k] = String(v);
        return acc;
      }, {}));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSavedMsg(''); setSaving(true);
    try {
      await systemApi.put('/gateway-settings', form);
      setSavedMsg('Gateway & RADIUS settings saved.');
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const fields: { key: keyof GatewaySettings; label: string; secret?: boolean }[] = [
    { key: 'gateway_ip', label: 'Gateway IP' },
    { key: 'gateway_model', label: 'Gateway Model' },
    { key: 'gateway_port', label: 'Gateway Web Port' },
    { key: 'auth_mode', label: 'Auth Mode (External Portal / Web Auth)' },
    { key: 'radius_host', label: 'RADIUS Host' },
    { key: 'radius_auth_port', label: 'RADIUS Auth Port' },
    { key: 'radius_acct_port', label: 'RADIUS Acct Port' },
    { key: 'radius_secret', label: 'RADIUS Shared Secret', secret: true },
    { key: 'ext_login_host', label: 'ext_login Host' },
    { key: 'ext_login_port', label: 'ext_login Port' },
    { key: 'api_base_url', label: 'Portal API Base URL' },
    { key: 'api_secret', label: 'Portal API Secret', secret: true },
    { key: 'email_service', label: 'Email Service' },
    { key: 'sms_provider', label: 'SMS Provider' },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Gateway & RADIUS Settings</h1>
          <p className="page-desc">External portal configuration for Ruijie EG105G-P and FreeRADIUS. Secrets are stored masked. Level 0 only.</p>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
      {savedMsg && <div className="auth-success" style={{ marginBottom: 12 }}>{savedMsg}</div>}

      <div className="card">
        {!loaded ? (
          <div className="table-empty">Loading settings…</div>
        ) : (
          <form onSubmit={save} style={{ padding: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
              {fields.map(f => (
                <div key={f.key} className="tx-field">
                  <label>{f.label}</label>
                  <input
                    type={f.secret ? 'password' : 'text'}
                    value={form[f.key] || ''}
                    onChange={e => setForm({ ...form, [f.key]: e.target.value })}
                    placeholder={f.secret ? '**** (masked; leave to keep)' : ''}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
              <button type="submit" className="btn-secondary" disabled={saving}>
                <FiSave /> Save Settings
              </button>
            </div>
            <div className="tx-muted" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <FiRadio color="var(--cyan)" /> After changing RADIUS settings, the gateway must be rebooted for changes to take effect.
            </div>
          </form>
        )}
      </div>
    </div>
  );
}