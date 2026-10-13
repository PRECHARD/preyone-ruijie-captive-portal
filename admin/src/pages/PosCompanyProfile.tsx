import { useState, useEffect, useCallback } from 'react';
import { api, currencyApi } from '../api/client';
import Spinner from '../components/Spinner';

const INIT = {
  name: '', tagline: '', address: '', email: '', supportPhone: '', website: '',
  logoPath: '', currency: 'USD', taxPct: '0', invoicePrefix: 'INV', quotePrefix: 'QT',
  receiptFooter: '', termsText: '',
};

export default function PosCompanyProfile() {
  const [form, setForm] = useState(INIT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [rates, setRates] = useState<any[]>([]);
  const [rateTarget, setRateTarget] = useState('ZWG');
  const [rateValue, setRateValue] = useState('');
  const [rateSaving, setRateSaving] = useState(false);
  const [rateMsg, setRateMsg] = useState('');

  const fetch = useCallback(async () => {
    try {
      const c: any = await api.get('/company');
      setForm({
        name: c.name || '', tagline: c.tagline || '', address: c.address || '',
        email: c.email || '', supportPhone: c.support_phone || '', website: c.website || '',
        logoPath: c.logo_path || '', currency: c.currency || 'USD',
        taxPct: c.tax_pct != null ? String(c.tax_pct) : '0',
        invoicePrefix: c.invoice_prefix || 'INV', quotePrefix: c.quote_prefix || 'QT',
        receiptFooter: c.receipt_footer || '', termsText: c.terms_text || '',
      });
    } catch { /* keep defaults */ }
    try {
      const r: any = await currencyApi.get('/rates');
      setRates(r.rates || []);
      const zg = (r.rates || []).find((x: any) => x.target_currency === 'ZWG');
      if (zg) { setRateTarget('ZWG'); setRateValue(String(zg.rate)); }
    } catch { /* keep defaults */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      await api.put('/company', {
        name: form.name, tagline: form.tagline, address: form.address, email: form.email,
        supportPhone: form.supportPhone, website: form.website, logoPath: form.logoPath,
        currency: form.currency, taxPct: Number(form.taxPct) || 0,
        invoicePrefix: form.invoicePrefix, quotePrefix: form.quotePrefix,
        receiptFooter: form.receiptFooter, termsText: form.termsText,
      });
      setMsg('Company profile saved. All desktops, web POS and APK tills will pick this up.');
      setTimeout(() => setMsg(''), 4000);
    } catch (e: any) { setMsg(e.message); }
    setSaving(false);
  };

  const saveRate = async () => {
    const rate = parseFloat(rateValue);
    if (!rateTarget.trim() || !Number.isFinite(rate) || rate <= 0) {
      setRateMsg('Enter a valid target currency and positive rate.');
      return;
    }
    setRateSaving(true); setRateMsg('');
    try {
      await currencyApi.post('/rates', { target_currency: rateTarget.trim().toUpperCase(), rate });
      setRateMsg(`USD → ${rateTarget.trim().toUpperCase()} rate set to ${rate}. Tills pick this up on next rate refresh.`);
      setTimeout(() => setRateMsg(''), 5000);
      const r: any = await currencyApi.get('/rates');
      setRates(r.rates || []);
    } catch (e: any) { setRateMsg(e.message); }
    setRateSaving(false);
  };

  if (loading) return <Spinner />;

  const set = (k: keyof typeof INIT) => (e: any) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Company Profile</h2>
          <p className="page-desc">Single source of truth for receipts, invoices and notifications across desktop, web POS and APK.</p>
        </div>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Profile'}</button>
      </div>

      {msg && (
        <div className="form-status form-status--success" style={{ marginBottom: 16 }}>{msg}</div>
      )}

      <div className="card">
        <div className="auth-form">
          <div className="auth-field">
            <label>Company Name</label>
            <input value={form.name} onChange={set('name')} placeholder="e.g. Preyone" />
          </div>
          <div className="auth-field">
            <label>Tagline</label>
            <input value={form.tagline} onChange={set('tagline')} placeholder="Short slogan shown on receipts" />
          </div>
          <div className="auth-field">
            <label>Address</label>
            <input value={form.address} onChange={set('address')} placeholder="Street, City, Country" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="auth-field">
              <label>Email</label>
              <input value={form.email} onChange={set('email')} placeholder="info@preyone.com" />
            </div>
            <div className="auth-field">
              <label>Website</label>
              <input value={form.website} onChange={set('website')} placeholder="https://preyone.com" />
            </div>
          </div>
          <div className="auth-field">
            <label>Customer Care / Support Line</label>
            <input value={form.supportPhone} onChange={set('supportPhone')} placeholder="+263 7X XXX XXXX" />
            <p className="text-sm text-muted" style={{ marginTop: 4 }}>
              This is the number printed on every till receipt and used in notifications — set it correctly here.
            </p>
          </div>
          <div className="auth-field">
            <label>Logo Path</label>
            <input value={form.logoPath} onChange={set('logoPath')} placeholder="/brand/Preyone.svg" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px', gap: 8 }}>
            <div className="auth-field">
              <label>Currency</label>
              <input value={form.currency} onChange={set('currency')} placeholder="USD" />
            </div>
            <div className="auth-field">
              <label>Tax % (VAT)</label>
              <input type="number" value={form.taxPct} onChange={set('taxPct')} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="auth-field">
              <label>Invoice Prefix</label>
              <input value={form.invoicePrefix} onChange={set('invoicePrefix')} placeholder="INV" />
            </div>
            <div className="auth-field">
              <label>Quote Prefix</label>
              <input value={form.quotePrefix} onChange={set('quotePrefix')} placeholder="QT" />
            </div>
          </div>
          <div className="auth-field">
            <label>Receipt Footer</label>
            <input value={form.receiptFooter} onChange={set('receiptFooter')} placeholder="Thank you for choosing Preyone" />
          </div>
          <div className="auth-field">
            <label>Terms &amp; Conditions</label>
            <textarea rows={3} value={form.termsText} onChange={set('termsText')} style={{ width: '100%', background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontFamily: 'inherit' }} placeholder="Optional terms shown on invoices / quotations" />
          </div>
          <button className="auth-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Company Profile'}</button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="auth-form">
          <div className="auth-field">
            <label style={{ fontWeight: 700, fontSize: 14 }}>Currency Exchange Rates</label>
            <p className="text-sm text-muted" style={{ marginTop: 0 }}>
              Set the USD → local currency rate used by the till for ZiG/local pricing display.
            </p>
          </div>
          {rates.length > 0 && (
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              {rates.map((r: any) => (
                <div key={r.target_currency} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                  <span>USD → {r.target_currency}</span>
                  <span style={{ fontWeight: 700 }}>{r.rate}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="auth-field">
              <label>Target Currency</label>
              <input value={rateTarget} onChange={e => setRateTarget(e.target.value)} placeholder="ZWG" />
            </div>
            <div className="auth-field">
              <label>Rate (1 USD = ?)</label>
              <input type="number" step="any" min="0" value={rateValue} onChange={e => setRateValue(e.target.value)} placeholder="e.g. 26.5" />
            </div>
          </div>
          {rateMsg && (
            <div className={rateMsg.includes('valid') ? 'form-status form-status--error' : 'form-status form-status--success'} style={{ marginBottom: 8 }}>{rateMsg}</div>
          )}
          <button className="auth-btn" onClick={saveRate} disabled={rateSaving}>{rateSaving ? 'Saving…' : 'Save Rate'}</button>
        </div>
      </div>
    </div>
  );
}