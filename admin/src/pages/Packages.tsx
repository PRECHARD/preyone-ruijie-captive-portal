import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Modal from '../components/Modal';

export default function Packages() {
  const [pkgs, setPkgs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [msg, setMsg] = useState('');

  const [form, setForm] = useState({
    tierName: '', displayName: '', priceAmount: '', priceCurrency: 'USD',
    durationMin: '', dataLimitGb: '', isUncapped: false,
    bandwidthUp: '', bandwidthDown: '',
  });

  const fetch = useCallback(async () => {
    try { setPkgs(await api.get('/packages/manage')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const openNew = () => {
    setEditing(null);
    setForm({ tierName: '', displayName: '', priceAmount: '', priceCurrency: 'USD', durationMin: '', dataLimitGb: '', isUncapped: false, bandwidthUp: '', bandwidthDown: '' });
    setShowForm(true);
  };

  const openEdit = (p: any) => {
    setEditing(p);
    setForm({
      tierName: p.tier_name, displayName: p.display_name, priceAmount: String(p.price_amount || ''),
      priceCurrency: p.price_currency || 'USD', durationMin: String(p.duration_min || ''),
      dataLimitGb: String(p.data_limit_gb || ''), isUncapped: !!p.is_uncapped,
      bandwidthUp: String(p.bandwidth_mbps_up || ''), bandwidthDown: String(p.bandwidth_mbps_down || ''),
    });
    setShowForm(true);
  };

  const save = async () => {
    setMsg('');
    try {
      const body = {
        tierName: form.tierName, displayName: form.displayName,
        priceAmount: Number(form.priceAmount), priceCurrency: form.priceCurrency,
        durationMin: form.durationMin ? Number(form.durationMin) : undefined,
        dataLimitGb: form.dataLimitGb ? Number(form.dataLimitGb) : undefined,
        isUncapped: form.isUncapped, bandwidthUp: form.bandwidthUp ? Number(form.bandwidthUp) : undefined,
        bandwidthDown: form.bandwidthDown ? Number(form.bandwidthDown) : undefined,
      };
      if (editing) {
        await api.put(`/packages/${editing.id}`, body);
        setMsg('Package updated');
      } else {
        await api.post('/packages', body);
        setMsg('Package created');
      }
      setShowForm(false);
      fetch();
    } catch (e: any) { setMsg(e.message); }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this package?')) return;
    try { await api.del(`/packages/${id}`); fetch(); } catch (e: any) { setMsg(e.message); }
  };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Packages</h2>
          <p className="page-desc">{pkgs.length} service package(s)</p>
        </div>
        <button className="btn-primary" onClick={openNew}>New Package</button>
      </div>

      {msg && (
        <div className={`form-status ${msg.includes('created') || msg.includes('updated') ? 'form-status--success' : 'form-status--error'}`} style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {pkgs.length === 0 ? (
        <EmptyState icon="📦" title="No Packages" message="Create your first internet package." />
      ) : (
        <div className="card">
          <Table
            columns={[
              { key: 'tier_name', label: 'Tier' },
              { key: 'display_name', label: 'Display Name' },
              { key: 'price_amount', label: 'Price', width: '100px', render: (r: any) => `${Number(r.price_amount).toFixed(2)} ${r.price_currency || 'USD'}` },
              { key: 'duration_min', label: 'Duration', width: '90px', render: (r: any) => r.duration_min ? `${r.duration_min}m` : '—' },
              { key: 'bandwidth', label: 'Speed', width: '120px', render: (r: any) => r.bandwidth_mbps_up || r.bandwidth_mbps_down ? `${r.bandwidth_mbps_up || '?'}/${r.bandwidth_mbps_down || '?'} Mbps` : '—' },
              { key: 'data_limit_gb', label: 'Data', width: '80px', render: (r: any) => r.is_uncapped ? '∞' : r.data_limit_gb ? `${r.data_limit_gb} GB` : '—' },
              { key: 'actions', label: '', width: '100px', render: (r: any) => (
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn-sm" onClick={() => openEdit(r)}>Edit</button>
                  <button className="btn-sm btn-reject" onClick={() => remove(r.id)}>✕</button>
                </div>
              )},
            ]}
            data={pkgs}
          />
        </div>
      )}

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Package' : 'New Package'}>
        <div className="auth-form">
          <div className="auth-field"><label>Tier Name</label><input value={form.tierName} onChange={e => setForm({ ...form, tierName: e.target.value })} placeholder="e.g. PreBASIC" /></div>
          <div className="auth-field"><label>Display Name</label><input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} placeholder="e.g. Basic 1hr" /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8 }}>
            <div className="auth-field"><label>Price</label><input type="number" value={form.priceAmount} onChange={e => setForm({ ...form, priceAmount: e.target.value })} /></div>
            <div className="auth-field"><label>Currency</label><input value={form.priceCurrency} onChange={e => setForm({ ...form, priceCurrency: e.target.value })} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="auth-field"><label>Duration (min)</label><input type="number" value={form.durationMin} onChange={e => setForm({ ...form, durationMin: e.target.value })} /></div>
            <div className="auth-field"><label>Data Limit (GB)</label><input type="number" value={form.dataLimitGb} onChange={e => setForm({ ...form, dataLimitGb: e.target.value })} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="auth-field"><label>Upload (Mbps)</label><input type="number" value={form.bandwidthUp} onChange={e => setForm({ ...form, bandwidthUp: e.target.value })} /></div>
            <div className="auth-field"><label>Download (Mbps)</label><input type="number" value={form.bandwidthDown} onChange={e => setForm({ ...form, bandwidthDown: e.target.value })} /></div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)' }}>
            <input type="checkbox" checked={form.isUncapped} onChange={e => setForm({ ...form, isUncapped: e.target.checked })} />
            Uncapped (no data limit)
          </label>
          <button className="auth-btn" onClick={save}>{editing ? 'Update Package' : 'Create Package'}</button>
        </div>
      </Modal>
    </div>
  );
}
