import { useState, useEffect, useCallback } from 'react';
import { transitApi, systemApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { FiSave, FiRefreshCw, FiImage, FiAlertOctagon, FiCheckCircle } from 'react-icons/fi';
import TicketPreviewCard from '../components/TicketPreviewCard';
import '../styles/pages.css';
import '../styles/transit.css';

interface CompanyProfileT {
  id: string;
  name: string;
  tagline: string;
  regNo: string;
  taxId: string;
  phone: string;
  email: string;
  address: string;
  website: string;
  customerCare: string;
  contactEmail: string;
  currency: string;
  logoUrl: string;
  receiptHeader: string;
  receiptFooter: string;
}

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  status: string;
}

const empty: CompanyProfileT = {
  id: '',
  name: '',
  tagline: '',
  regNo: '',
  taxId: '',
  phone: '',
  email: '',
  address: '',
  website: '',
  customerCare: '',
  contactEmail: '',
  currency: 'USD',
  logoUrl: '',
  receiptHeader: '',
  receiptFooter: '',
};

// Same Zim Short Code normalization the field app stores: local 07x/08x and
// bare 7x/8x expand to +263..., a stray +363 prefix is corrected to +263, and
// anything already +263 is left untouched.
const toZimPhone = (value: string) => {
  const v = (value || '').replace(/[^0-9+]/g, '');
  if (!v) return '';
  if (v.startsWith('+363')) return '+263' + v.slice(4);
  if (/^0[78]/.test(v)) return '+263' + v.slice(1);
  if (/^[78]/.test(v)) return '+263' + v;
  return v;
};

// CODE128 mirror of the escape-printed barcode — rendered inside the card.

export default function CompanyProfile() {
  const { user } = useAuth();
  const isPlatform = !user?.companyId;
  const [company, setCompany] = useState<CompanyProfileT>(empty);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [selectedCompany, setSelectedCompany] = useState(user?.companyId ?? '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!isPlatform) return;
    systemApi.get<CompanyRow[]>('/companies')
      .then(setCompanies)
      .catch(() => {});
    // Post-provision redirect from Tenants: jump straight to the new tenant.
    const target = localStorage.getItem('tenant_target_company');
    if (target) {
      localStorage.removeItem('tenant_target_company');
      setSelectedCompany(target);
    }
  }, [isPlatform]);

  const locked = isPlatform && !selectedCompany;

  const load = useCallback(async () => {
    try {
      setError('');
      setLoading(true);
      if (isPlatform && !selectedCompany) {
        setCompany(empty);
        return;
      }
      const params = isPlatform && selectedCompany
        ? `?companyId=${encodeURIComponent(selectedCompany)}`
        : '';
      const data = await transitApi.get<{ company: CompanyProfileT }>(`/company${params}`);
      const company = data.company ?? ({} as CompanyProfileT);
      // Normalize on load so a legacy/stray +363 value never records or shows raw.
      setCompany({ ...empty, ...company, customerCare: toZimPhone(company.customerCare) });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [isPlatform, selectedCompany]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (saved) {
      const t = setTimeout(() => setSaved(false), 2500);
      return () => clearTimeout(t);
    }
  }, [saved]);

  const set = (key: keyof CompanyProfileT, value: string) =>
    setCompany(prev => ({ ...prev, [key]: value }));

  const save = async () => {
    if (!company.name.trim()) {
      setError('Company name is required.');
      return;
    }
    if (locked) {
      setError('Select a tenant company before saving its profile.');
      return;
    }
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const body: any = {
        name: company.name, tagline: company.tagline, regNo: company.regNo, taxId: company.taxId,
        phone: company.phone, email: company.email, address: company.address, website: company.website,
        customerCare: toZimPhone(company.customerCare), contactEmail: company.contactEmail,
        currency: company.currency, logoUrl: company.logoUrl,
        receiptHeader: company.receiptHeader, receiptFooter: company.receiptFooter,
      };
      if (isPlatform && selectedCompany) body.companyId = selectedCompany;
      const data = await transitApi.put<{ company: CompanyProfileT }>('/company', body);
      setCompany({ ...empty, ...data.company });
      setSaved(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const inputDisabled = loading || locked;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Company Profile & Branding</h1>
          <p className="page-desc">
            Legal details, contact info, and the logo + receipt text that print on every ticket
            issued by the field app.
          </p>
        </div>
        <div className="tx-actions">
          <button className="btn-secondary" onClick={load}><FiRefreshCw /> Reload</button>
          <button className="btn-primary" onClick={save} disabled={saving || loading || locked}>
            <FiSave /> {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {locked && (
        <div className="tx-banner" style={{ marginBottom: 12 }}>
          <FiAlertOctagon style={{ verticalAlign: 'middle', marginRight: 8 }} />
          Level 0 — select a tenant company to view and edit its profile.
        </div>
      )}

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
      {saved && <div className="auth-success" style={{ marginBottom: 12 }}><FiCheckCircle style={{ verticalAlign: 'middle' }} /> Company profile saved.</div>}

      {isPlatform && (
        <div className="card" style={{ marginBottom: 14, padding: 16 }}>
          <div className="tx-field" style={{ marginBottom: 0 }}>
            <label><FiImage style={{ verticalAlign: 'middle', marginRight: 6, color: 'var(--cyan)' }} />Tenant Company {companies.length > 0 && '(Level 0 — cross-company)'}</label>
            <select
              value={selectedCompany}
              onChange={e => { setSelectedCompany(e.target.value); setCompany(empty); }}
            >
              <option value="">Select a tenant company…</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>)}
            </select>
            {!selectedCompany && (
              <div className="tx-muted" style={{ marginTop: 6 }}>Choose a company to load its profile. Level 0 admins are not bound to a single tenant.</div>
            )}
          </div>
        </div>
      )}

      <div className="company-profile-grid">
        <div className="card">
          {loading ? (
            <div className="table-empty">Loading profile…</div>
          ) : (
            <>
              <div className="tx-section-title">Company Details</div>
              <div className="tx-form-row">
                <div className="tx-field">
                  <label>Company Name</label>
                  <input value={company.name} disabled={inputDisabled} onChange={e => set('name', e.target.value)} placeholder="Preyone Transit" />
                </div>
                <div className="tx-field">
                  <label>Tagline</label>
                  <input value={company.tagline} disabled={inputDisabled} onChange={e => set('tagline', e.target.value)} placeholder="Famba Nyore Nyore" />
                </div>
              </div>
              <div className="tx-form-row">
                <div className="tx-field">
                  <label>Registration No</label>
                  <input value={company.regNo} disabled={inputDisabled} onChange={e => set('regNo', e.target.value)} placeholder="e.g. 1234/2020" />
                </div>
                <div className="tx-field">
                  <label>Tax ID</label>
                  <input value={company.taxId} disabled={inputDisabled} onChange={e => set('taxId', e.target.value)} placeholder="e.g. TAX-00012345" />
                </div>
              </div>
              <div className="tx-form-row">
                <div className="tx-field">
                  <label>Phone</label>
                  <input value={company.phone} disabled={inputDisabled} onChange={e => set('phone', e.target.value)} placeholder="+263 …" />
                </div>
                <div className="tx-field">
                  <label>Email</label>
                  <input value={company.email} disabled={inputDisabled} onChange={e => set('email', e.target.value)} placeholder="info@preyone.com" />
                </div>
              </div>
              <div className="tx-form-row">
                <div className="tx-field">
                  <label>Address</label>
                  <input value={company.address} disabled={inputDisabled} onChange={e => set('address', e.target.value)} placeholder="Physical address" />
                </div>
                <div className="tx-field">
                  <label>Website</label>
                  <input value={company.website} disabled={inputDisabled} onChange={e => set('website', e.target.value)} placeholder="https://…" />
                </div>
              </div>
              <div className="tx-form-row">
                <div className="tx-field">
                  <label>Customer Care</label>
                  <input value={company.customerCare} disabled={inputDisabled} onChange={e => set('customerCare', e.target.value)} placeholder="Support number" />
                </div>
                <div className="tx-field">
                  <label>Currency</label>
                  <select value={company.currency} disabled={inputDisabled} onChange={e => set('currency', e.target.value)}>
                    {['USD', 'ZWL', 'ZAR', 'BWP', 'GBP', 'EUR'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              <div className="tx-section-title" style={{ marginTop: 22 }}>Receipt Branding</div>
              <div className="tx-form-row tx-form-row--1">
                <div className="tx-field">
                  <label><FiImage style={{ verticalAlign: 'middle' }} /> Logo URL</label>
                  <input
                    value={company.logoUrl}
                    disabled={inputDisabled}
                    onChange={e => set('logoUrl', e.target.value)}
                    placeholder="https://cdn.example.com/logo.png"
                  />
                  {company.logoUrl && (
                    <div style={{ marginTop: 8 }}>
                      <img src={company.logoUrl} alt="logo preview" style={{ maxHeight: 40, maxWidth: 200 }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    </div>
                  )}
                </div>
              </div>
              <div className="tx-form-row">
                <div className="tx-field">
                  <label>Receipt Header (printed above items)</label>
                  <textarea
                    rows={4}
                    value={company.receiptHeader}
                    disabled={inputDisabled}
                    onChange={e => set('receiptHeader', e.target.value)}
                    placeholder="Line 1&#10;Line 2"
                  />
                </div>
                <div className="tx-field">
                  <label>Receipt Footer (printed after total)</label>
                  <textarea
                    rows={4}
                    value={company.receiptFooter}
                    disabled={inputDisabled}
                    onChange={e => set('receiptFooter', e.target.value)}
                    placeholder="Thank you for riding with us&#10;Call 0770 000 000"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="tx-section-title">Live Ticket Preview</div>
          <p className="tx-muted" style={{ marginBottom: 14 }}>
            1:1 mirror of the app's live ticket preview — updates live as you type, with the
            exact branding that prints on every 58mm ticket from the field app.
          </p>
          <TicketPreviewCard
            data={{
              companyName: company.name || 'COMPANY NAME',
              slogan: company.tagline,
              ticketType: 'BUS TICKET',
              receiptNo: 'AGJ000001',
              time: new Date(),
              busReg: 'AFR 1234',
              tripNo: 'T-86',
              website: company.website,
              customerCare: company.customerCare,
              companyAddress: company.address,
              routeCode: '500',
              routeName: 'HARARE - BULAWAYO',
              items: [
                { name: 'ADULT', qty: 1, total: 500 },
                { name: 'STUDENT', qty: 2, total: 1200 },
              ],
              total: 1700,
              currency: company.currency,
              driver: 'J. MUPOTA',
              driverPhone: '',
              conductor1: 'P. NKOMO',
              conductor2: '',
              conductorPhone: '0772123456',
              seatNumber: '12',
              customerName: '',
              customerMobile: '',
              paymentMethod: 'cash',
              tendered: 1700,
              note: 'Please keep your ticket safe. Ticket is valid for the stated journey and date only. Thank You!',
            }}
          />
          {!loading && !company.id && !locked && (
            <div className="tx-muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
              <FiAlertOctagon /> This account has no company context — profile is read-only until bound.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}