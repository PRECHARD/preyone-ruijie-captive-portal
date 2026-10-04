import { useState, useEffect, useCallback } from 'react';
import { systemApi } from '../api/client';
import Table from '../components/Table';
import Modal from '../components/Modal';
import { FiPlus, FiGlobe, FiSave, FiCheckCircle, FiXCircle } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  tagline: string;
  currency: string;
  status: string;
  company_code: string;
  contact_email: string;
  commission_rate: number | string;
  payment_gateway: string;
  gateway_merchant_id: string;
  created_at: string;
}

interface CompanyDetail extends CompanyRow {
  user_count: number;
  device_count: number;
  month_revenue_cents: number;
  min_app_version: string;
  offline_lease_days: number;
  default_receipt_prefix: string;
  address: string;
  email: string;
  website: string;
  customer_care: string;
}

const fmtMoney = (cents: number, currency: string) =>
  `${currency} ${((cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function Tenants() {
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showProvision, setShowProvision] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [savedMsg, setSavedMsg] = useState('');

  const [form, setForm] = useState({
    name: '', slug: '', company_code: '', contact_email: '', currency: 'USD',
    commission_rate: '0.0', adminUsername: '', adminPassword: '', adminName: '', adminEmail: '', adminPhone: '',
  });
  const [editForm, setEditForm] = useState({
    status: 'ACTIVE', commission_rate: '0.0', payment_gateway: 'pesepay',
    gateway_merchant_id: '', min_app_version: '', offline_lease_days: '7', contact_email: '',
  });

  const load = useCallback(async () => {
    try {
      const data = await systemApi.get<CompanyRow[]>('/companies');
      setRows(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (row: CompanyRow) => {
    try {
      const d = await systemApi.get<CompanyDetail>(`/companies/${row.id}`);
      setDetail(d);
      setEditForm({
        status: d.status,
        commission_rate: String(d.commission_rate ?? 0),
        payment_gateway: d.payment_gateway || 'pesepay',
        gateway_merchant_id: d.gateway_merchant_id || '',
        min_app_version: d.min_app_version || '',
        offline_lease_days: String(d.offline_lease_days ?? 7),
        contact_email: d.contact_email || '',
      });
    } catch (e: any) {
      setError(e.message);
    }
  };

  const provision = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSavedMsg('');
    if (!form.name.trim() || !form.slug.trim()) { setError('Company name and slug are required'); return; }
    setSaving(true);
    try {
      const payload: any = {
        name: form.name.trim(), slug: form.slug.trim(),
        company_code: form.company_code.trim(), currency: form.currency,
        commission_rate: Number(form.commission_rate) || 0,
      };
      if (form.contact_email.trim()) payload.contact_email = form.contact_email.trim();
      if (form.adminUsername.trim())
        payload.adminUsername = form.adminUsername.trim();
      if (form.adminEmail.trim())
        payload.adminEmail = form.adminEmail.trim();
      if (form.adminPassword)
        payload.adminPassword = form.adminPassword;
      if (form.adminName.trim()) payload.adminName = form.adminName.trim();
      if (form.adminPhone.trim()) payload.adminPhone = form.adminPhone.trim();
      const res = await systemApi.post<{ companyId?: string }>('/companies', payload);
      setSavedMsg(`Company "${form.name}" provisioned.`);
      setShowProvision(false);
      setForm({ name: '', slug: '', company_code: '', contact_email: '', currency: 'USD', commission_rate: '0.0', adminUsername: '', adminPassword: '', adminName: '', adminEmail: '', adminPhone: '' });
      load();
      // Hand the brand-new tenant to the Company Profile page.
      if (res?.companyId) {
        localStorage.setItem('tenant_target_company', res.companyId);
        window.dispatchEvent(new CustomEvent('app-navigate', { detail: 'company-profile' }));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveDetail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setSaving(true); setError(''); setSavedMsg('');
    try {
      await systemApi.put(`/companies/${detail.id}`, {
        status: editForm.status,
        commission_rate: Number(editForm.commission_rate) || 0,
        payment_gateway: editForm.payment_gateway,
        gateway_merchant_id: editForm.gateway_merchant_id.trim(),
        min_app_version: editForm.min_app_version.trim(),
        offline_lease_days: Number(editForm.offline_lease_days) || 7,
        contact_email: editForm.contact_email.trim(),
      });
      setSavedMsg('Company configuration saved.');
      load();
      if (detail) setDetail({ ...detail, status: editForm.status });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Tenant Companies</h1>
          <p className="page-desc">Provision transit operator companies, commission rates and payment gateway mappings. Level 0 only.</p>
        </div>
        <div className="page-header-extra">
          <button className="btn-primary" onClick={() => setShowProvision(true)}><FiPlus /> Provision Company</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
      {savedMsg && <div className="auth-success" style={{ marginBottom: 12 }}>{savedMsg}</div>}

      <div className="card">
        {loading ? (
          <div className="table-empty">Loading companies…</div>
        ) : (
          <Table<CompanyRow>
            columns={[
              { key: 'name', label: 'Company Name', render: r => (
                <span><FiGlobe style={{ color: 'var(--cyan)', marginRight: 6 }} />{r.name}</span>
              )},
              { key: 'company_code', label: 'Company Code' },
              { key: 'contact_email', label: 'Contact Email' },
              { key: 'currency', label: 'Currency' },
              { key: 'commission_rate', label: 'Commission %', render: r => <span className="tx-num">{Number(r.commission_rate)}%</span> },
              { key: 'payment_gateway', label: 'Gateway' },
              { key: 'status', label: 'Status', render: r => (
                <span className={'status-chip status-chip--' + (r.status === 'ACTIVE' ? 'active' : 'disabled')}>
                  {r.status === 'ACTIVE' ? <FiCheckCircle /> : <FiXCircle />} {r.status}
                </span>
              )},
              { key: 'created_at', label: 'Created', render: r => new Date(r.created_at).toLocaleDateString() },
            ]}
            data={rows}
            onRowClick={openDetail}
            emptyMessage="No companies provisioned yet."
          />
        )}
      </div>

      <Modal open={showProvision} onClose={() => setShowProvision(false)} title="Provision Transit Company" wide>
        <form onSubmit={provision}>
          <div className="tx-form-row">
            <div className="tx-field"><label>Company Name *</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Zim Shuttle Lines" required />
            </div>
            <div className="tx-field"><label>Slug *</label>
              <input value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') })} placeholder="zim-shuttle" required />
            </div>
          </div>
          <div className="tx-form-row">
            <div className="tx-field"><label>Company Code</label>
              <input value={form.company_code} onChange={e => setForm({ ...form, company_code: e.target.value.toUpperCase() })} placeholder="ZSL" />
            </div>
            <div className="tx-field"><label>Currency</label>
              <select value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })}>
                {['USD', 'ZWL', 'EUR', 'GBP', 'ZAR'].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="tx-form-row">
            <div className="tx-field"><label>Contact Email</label>
              <input type="email" value={form.contact_email} onChange={e => setForm({ ...form, contact_email: e.target.value })} placeholder="ops@zimshuttle.co.zw" />
            </div>
            <div className="tx-field"><label>Commission Rate (%)</label>
              <input type="number" step="0.5" min="0" max="100" value={form.commission_rate} onChange={e => setForm({ ...form, commission_rate: e.target.value })} />
            </div>
          </div>
          <div className="tx-section-title" style={{ marginTop: 8 }}>Seed Company Admin (optional)</div>
          <div className="tx-form-row">
            <div className="tx-field"><label>App Super Admin Username</label>
              <input value={form.adminUsername} onChange={e => setForm({ ...form, adminUsername: e.target.value })} placeholder="company-admin-1 (mobile app login)" />
            </div>
            <div className="tx-field"><label>Full Name</label>
              <input value={form.adminName} onChange={e => setForm({ ...form, adminName: e.target.value })} placeholder="Ops Manager" />
            </div>
          </div>
          <div className="tx-form-row">
            <div className="tx-field"><label>Web Admin Email</label>
              <input type="email" value={form.adminEmail} onChange={e => setForm({ ...form, adminEmail: e.target.value })} placeholder="ops@mupota.co.zw" />
            </div>
            <div className="tx-field"><label>Phone (optional)</label>
              <input value={form.adminPhone} onChange={e => setForm({ ...form, adminPhone: e.target.value })} placeholder="+263 …" />
            </div>
          </div>
          <div className="tx-form-row tx-form-row--1">
            <div className="tx-field"><label>Initial Password</label>
              <input value={form.adminPassword} onChange={e => setForm({ ...form, adminPassword: e.target.value })} placeholder="Leave blank to skip seeding" />
            </div>
          </div>
          <div className="tx-muted" style={{ marginTop: 6 }}>
            Username seeds the mobile-app Super Admin; Email seeds a web-portal admin for the company. Both use the Initial Password (web-portal policy: 10+ chars, an uppercase letter and a number).
          </div>
          {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn-secondary" disabled={saving}><FiSave /> Provision</button>
          </div>
        </form>
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.name} wide>
        {detail && (
          <form onSubmit={saveDetail}>
            <div className="tx-form-row">
              <div className="tx-field"><label>Status</label>
                <select value={editForm.status} onChange={e => setEditForm({ ...editForm, status: e.target.value })}>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="SUSPENDED">SUSPENDED</option>
                  <option value="DISABLED">DISABLED</option>
                </select>
              </div>
              <div className="tx-field"><label>Commission Rate (%)</label>
                <input type="number" step="0.5" min="0" max="100" value={editForm.commission_rate} onChange={e => setEditForm({ ...editForm, commission_rate: e.target.value })} />
              </div>
            </div>
            <div className="tx-form-row">
              <div className="tx-field"><label>Payment Gateway</label>
                <select value={editForm.payment_gateway} onChange={e => setEditForm({ ...editForm, payment_gateway: e.target.value })}>
                  {['pesepay', 'innbucks', 'ecocash', 'other'].map(g => <option key={g} value={g}>{g.toUpperCase()}</option>)}
                </select>
              </div>
              <div className="tx-field"><label>Gateway Merchant ID</label>
                <input value={editForm.gateway_merchant_id} onChange={e => setEditForm({ ...editForm, gateway_merchant_id: e.target.value })} placeholder="mch_xxxx" />
              </div>
            </div>
            <div className="tx-form-row">
              <div className="tx-field"><label>Min App Version</label>
                <input value={editForm.min_app_version} onChange={e => setEditForm({ ...editForm, min_app_version: e.target.value })} placeholder="2.4.0" />
              </div>
              <div className="tx-field"><label>Offline Lease (days)</label>
                <input type="number" min="1" max="60" value={editForm.offline_lease_days} onChange={e => setEditForm({ ...editForm, offline_lease_days: e.target.value })} />
              </div>
            </div>
            <div className="tx-form-row tx-form-row--1">
              <div className="tx-field"><label>Contact Email</label>
                <input type="email" value={editForm.contact_email} onChange={e => setEditForm({ ...editForm, contact_email: e.target.value })} />
              </div>
            </div>
            <div className="stats-grid stats-grid--compact" style={{ marginBottom: 14 }}>
              <div className="stat-card"><span className="stat-label">Staff</span><span className="stat-number">{detail.user_count}</span></div>
              <div className="stat-card"><span className="stat-label">Devices</span><span className="stat-number">{detail.device_count}</span></div>
              <div className="stat-card"><span className="stat-label">Month Revenue</span><span className="stat-number" style={{ color: 'var(--green)' }}>{fmtMoney(detail.month_revenue_cents, detail.currency)}</span></div>
            </div>
            {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="btn-secondary" disabled={saving}><FiSave /> Save Configuration</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}