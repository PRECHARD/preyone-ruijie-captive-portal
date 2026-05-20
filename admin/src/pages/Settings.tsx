import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import Modal from '../components/Modal';

export default function Settings() {
  const [tab, setTab] = useState('general');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const [settings, setSettings] = useState<Record<string, string>>({});
  const [branding, setBranding] = useState<any>(null);
  const [maintenance, setMaintenance] = useState<any>(null);
  const [retention, setRetention] = useState<any>(null);
  const [commissions, setCommissions] = useState<any[]>([]);

  const [maintMsg, setMaintMsg] = useState('');
  const [retMsg, setRetMsg] = useState('');
  const [brandMsg, setBrandMsg] = useState('');
  const [commMsg, setCommMsg] = useState('');
  const [showKill, setShowKill] = useState(false);

  const fetch = useCallback(async () => {
    try { setSettings(await api.get('/settings')); } catch { /* ignore */ }
    try { setBranding(await api.get('/branding')); } catch { /* ignore */ }
    try { setMaintenance(await api.get('/maintenance')); } catch { /* ignore */ }
    try { setRetention(await api.get('/retention')); } catch { /* ignore */ }
    try { setCommissions(await api.get('/commissions')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const updateSettings = async () => {
    try { await api.put('/settings', settings); setMsg('Settings updated'); } catch (e: any) { setMsg(e.message); }
  };

  const toggleMaintenance = async () => {
    try {
      await api.put('/maintenance', { enabled: !maintenance?.enabled, message: maintMsg || maintenance?.message });
      setMaintenance(await api.get('/maintenance'));
    } catch (e: any) { setMsg(e.message); }
  };

  const updateRetention = async () => {
    try {
      await api.put('/retention', {
        sessionDays: retention?.session_days ? Number(retention.session_days) : undefined,
        accessLogDays: retention?.access_log_days ? Number(retention.access_log_days) : undefined,
        auditLogDays: retention?.audit_log_days ? Number(retention.audit_log_days) : undefined,
      });
      setRetMsg('Retention policy updated');
    } catch (e: any) { setRetMsg(e.message); }
  };

  const updateBranding = async () => {
    try {
      if (branding) await api.put('/branding', branding);
      setBrandMsg('Branding updated');
    } catch (e: any) { setBrandMsg(e.message); }
  };

  const setCommission = async (staffId: string, pct: number) => {
    try { await api.put(`/commissions/${staffId}`, { commissionPct: pct }); setCommMsg('Commission updated'); fetch(); } catch (e: any) { setCommMsg(e.message); }
  };

  const killSwitch = async () => {
    try { setMsg(await (await api.post('/kill-sessions')).message || 'Sessions terminated'); setShowKill(false); } catch (e: any) { setMsg(e.message); }
  };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Settings</h2>
          <p className="page-desc">System configuration & management</p>
        </div>
        <button className="btn-secondary" style={{ borderColor: 'var(--red)', color: 'var(--red)' }} onClick={() => setShowKill(true)}>
          ⚠ Kill Switch
        </button>
      </div>

      <div className="auth-tabs" style={{ marginBottom: 16 }}>
        <button className={`auth-tab ${tab === 'general' ? 'active' : ''}`} onClick={() => setTab('general')}>General</button>
        <button className={`auth-tab ${tab === 'branding' ? 'active' : ''}`} onClick={() => setTab('branding')}>Branding</button>
        <button className={`auth-tab ${tab === 'maintenance' ? 'active' : ''}`} onClick={() => setTab('maintenance')}>Maintenance</button>
        <button className={`auth-tab ${tab === 'retention' ? 'active' : ''}`} onClick={() => setTab('retention')}>Retention</button>
        <button className={`auth-tab ${tab === 'commissions' ? 'active' : ''}`} onClick={() => setTab('commissions')}>Commissions</button>
      </div>

      {tab === 'general' && (
        <div className="card" style={{ padding: 20 }}>
          <div className="auth-form">
            {Object.entries(settings).map(([key, val]) => (
              <div key={key} className="auth-field">
                <label>{key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</label>
                <input value={val} onChange={e => setSettings({ ...settings, [key]: e.target.value })} />
              </div>
            ))}
            <button className="auth-btn" onClick={updateSettings}>Save Settings</button>
            {msg && <div className={`form-status ${msg.includes('updated') ? 'form-status--success' : 'form-status--error'}`}>{msg}</div>}
          </div>
        </div>
      )}

      {tab === 'branding' && branding && (
        <div className="card" style={{ padding: 20 }}>
          <div className="auth-form">
            {Object.entries(branding).filter(([k]) => typeof branding[k] === 'string').map(([key, val]) => (
              <div key={key} className="auth-field">
                <label>{key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</label>
                {key.toLowerCase().includes('color') || key.toLowerCase().includes('colour')
                  ? <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input type="color" value={String(val)} onChange={e => setBranding({ ...branding, [key]: e.target.value })} style={{ width: 50, height: 40, padding: 2, background: 'none', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }} />
                      <input value={String(val)} onChange={e => setBranding({ ...branding, [key]: e.target.value })} style={{ flex: 1 }} />
                    </div>
                  : <input value={String(val)} onChange={e => setBranding({ ...branding, [key]: e.target.value })} />
                }
              </div>
            ))}
            <button className="auth-btn" onClick={updateBranding}>Save Branding</button>
            {brandMsg && <div className={`form-status ${brandMsg.includes('updated') ? 'form-status--success' : 'form-status--error'}`}>{brandMsg}</div>}
          </div>
        </div>
      )}

      {tab === 'maintenance' && (
        <div className="card" style={{ padding: 20 }}>
          <div className="auth-form">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>Maintenance Mode:</span>
              <span style={{ color: maintenance?.enabled ? 'var(--green)' : 'var(--red)' }}>
                {maintenance?.enabled ? 'ON' : 'OFF'}
              </span>
              <button className="btn-sm" style={{ borderColor: maintenance?.enabled ? 'var(--red)' : 'var(--green)', color: maintenance?.enabled ? 'var(--red)' : 'var(--green)' }} onClick={toggleMaintenance}>
                {maintenance?.enabled ? 'Turn Off' : 'Turn On'}
              </button>
            </div>
            <div className="auth-field">
              <label>Maintenance Message</label>
              <input value={maintenance?.message || maintMsg} onChange={e => setMaintMsg(e.target.value)} placeholder="Message shown to users during maintenance" />
            </div>
          </div>
        </div>
      )}

      {tab === 'retention' && retention && (
        <div className="card" style={{ padding: 20 }}>
          <div className="auth-form">
            <div className="auth-field"><label>Session Retention (days)</label><input type="number" value={retention.session_days ?? ''} onChange={e => setRetention({ ...retention, session_days: e.target.value })} /></div>
            <div className="auth-field"><label>Access Log Retention (days)</label><input type="number" value={retention.access_log_days ?? ''} onChange={e => setRetention({ ...retention, access_log_days: e.target.value })} /></div>
            <div className="auth-field"><label>Audit Log Retention (days)</label><input type="number" value={retention.audit_log_days ?? ''} onChange={e => setRetention({ ...retention, audit_log_days: e.target.value })} /></div>
            <button className="auth-btn" onClick={updateRetention}>Save Retention Policy</button>
            {retMsg && <div className={`form-status ${retMsg.includes('updated') ? 'form-status--success' : 'form-status--error'}`}>{retMsg}</div>}
          </div>
        </div>
      )}

      {tab === 'commissions' && (
        <div className="card" style={{ padding: 20 }}>
          <div className="auth-form">
            {commissions.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>No staff commission records found.</p>
            ) : (
              commissions.map((c: any) => (
                <div key={c.id || c.staff_id} className="auth-field">
                  <label>{c.full_name || c.email} ({c.email})</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="number" min="0" max="100" defaultValue={c.commission_pct ?? ''} onBlur={e => setCommission(c.staff_id || c.id, Number(e.target.value))} placeholder="%" style={{ width: 100 }} />
                    <span style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>%</span>
                  </div>
                </div>
              ))
            )}
            {commMsg && <div className="form-status form-status--success">{commMsg}</div>}
          </div>
        </div>
      )}

      <Modal open={showKill} onClose={() => setShowKill(false)} title="⚠ Emergency Kill Switch" wide>
        <div style={{ textAlign: 'center', padding: '10px 0' }}>
          <p style={{ color: 'var(--red)', fontWeight: 700, fontSize: 16, marginBottom: 16 }}>
            This will force-disconnect ALL active sessions immediately.
          </p>
          <p style={{ color: 'var(--text-muted)', marginBottom: 20, fontSize: 13 }}>
            All users currently connected to the network will be disconnected and will need to re-authenticate.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button className="btn-secondary" onClick={() => setShowKill(false)}>Cancel</button>
            <button className="btn-primary" style={{ background: 'linear-gradient(135deg, var(--red), #ff6b6b)' }} onClick={killSwitch}>
              Yes, Kill All Sessions
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
