import { useEffect, useState } from 'react';
import { api } from '../api';

const STATUSES = ['received', 'diagnosed', 'in_progress', 'ready', 'delivered', 'cancelled'];

export default function RepairIntake({ notify }: { notify: (m: string, k?: 'ok' | 'error') => void }) {
  const [repairs, setRepairs] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [form, setForm] = useState({ deviceType: '', brand: '', model: '', serialNumber: '', issueDescription: '', estimatedCost: '', customerId: '' });

  const load = async () => {
    try { setRepairs(await api.repairs(statusFilter || undefined)); } catch (e) { console.error(e); }
  };
  useEffect(() => { load(); }, [statusFilter]);

  const create = async () => {
    if (!form.issueDescription.trim()) { notify('Issue description required', 'error'); return; }
    try {
      await api.createRepair({
        deviceType: form.deviceType || undefined,
        brand: form.brand || undefined,
        model: form.model || undefined,
        serialNumber: form.serialNumber || undefined,
        issueDescription: form.issueDescription,
        estimatedCost: form.estimatedCost ? Number(form.estimatedCost) : 0,
        customerId: form.customerId || undefined,
      });
      setForm({ deviceType: '', brand: '', model: '', serialNumber: '', issueDescription: '', estimatedCost: '', customerId: '' });
      await load();
      notify('Repair ticket created');
    } catch (e) { notify(e instanceof Error ? e.message : 'Create failed', 'error'); }
  };

  const updateStatus = async (id: string, status: string) => {
    try { await api.updateRepairStatus(id, status); await load(); }
    catch (e) { notify(e instanceof Error ? e.message : 'Update failed', 'error'); }
  };

  const convert = async (id: string) => {
    try { await api.convertRepair(id); await load(); notify('Converted to invoice'); }
    catch (e) { notify(e instanceof Error ? e.message : 'Convert failed', 'error'); }
  };

  return (
    <div className="panel">
      <h2>Repair Intake</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
        <input placeholder="Device type" value={form.deviceType} onChange={(e) => setForm({ ...form, deviceType: e.target.value })} />
        <input placeholder="Brand" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
        <input placeholder="Model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        <input placeholder="Serial/IMEI" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
        <input placeholder="Estimated cost" type="number" value={form.estimatedCost} onChange={(e) => setForm({ ...form, estimatedCost: e.target.value })} />
        <input placeholder="Customer ID (optional)" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} />
      </div>
      <textarea placeholder="Issue description" value={form.issueDescription} onChange={(e) => setForm({ ...form, issueDescription: e.target.value })} style={{ width: '100%', minHeight: 60, marginBottom: 8 }} />
      <button className="primary-btn" onClick={create}>Create repair ticket</button>

      <div style={{ marginTop: 12 }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <table style={{ width: '100%', marginTop: 12, borderCollapse: 'collapse' }}>
        <thead><tr><th>Device</th><th>Issue</th><th>Status</th><th>Est.</th><th>Actions</th></tr></thead>
        <tbody>
          {repairs.map((r) => (
            <tr key={r.id}>
              <td>{[r.brand, r.model, r.serial_number].filter(Boolean).join(' ') || r.device_type || '—'}</td>
              <td>{r.issue_description}</td>
              <td>{r.status}</td>
              <td>{r.estimated_cost}</td>
              <td style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <select value={r.status} onChange={(e) => updateStatus(r.id, e.target.value)}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {!r.invoice_document_id && (
                  <button className="secondary-btn" onClick={() => convert(r.id)}>Convert to invoice</button>
                )}
                {r.invoice_document_id && <span style={{ fontSize: '0.75rem' }}>INV: {r.invoice_document_id.slice(0, 8)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
