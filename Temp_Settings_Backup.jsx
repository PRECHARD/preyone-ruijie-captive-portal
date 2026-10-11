import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Settings({ settings, notify, onSaved }) {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [taxRate, setTaxRate] = useState(settings.taxRate ?? 15.5);
  const [stock, setStock] = useState([]);
  const [newItem, setNewItem] = useState({ name: '', price: '' });

  useEffect(() => setForm(settings), [settings]);

  useEffect(() => {
    api.items.list().then(setStock).catch(() => {});
  }, []);

  const addStockItem = async () => {
    const name = newItem.name.trim();
    if (!name) return;
    try {
      await api.items.create({ name, price: Number(newItem.price) || 0 });
      setStock(await api.items.list());
      setNewItem({ name: '', price: '' });
      notify(`“${name}” added to stock`);
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  const removeStockItem = async (id) => {
    try {
      await api.items.remove(id);
      setStock((list) => list.filter((s) => s.id !== id));
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.settings.save(form);
      notify('Settings saved');
      onSaved(saved);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="card">
        <h2>Company details</h2>
        <p style={{ marginTop: -6, color: 'var(--muted)', fontSize: '.82rem' }}>
          These appear on every invoice and quotation header and footer.
        </p>
        <div className="grid-2">
          <label className="field">
            Company name
            <input value={form.companyName || ''} onChange={(e) => set({ companyName: e.target.value })} />
          </label>
          <label className="field">
            Tagline
            <input value={form.tagline || ''} onChange={(e) => set({ tagline: e.target.value })} />
          </label>
        </div>
        <label className="field">
          Address
          <textarea rows="2" value={form.address || ''} onChange={(e) => set({ address: e.target.value })} />
        </label>
        <div className="grid-3">
          <label className="field">
            Phone
            <input value={form.phone || ''} onChange={(e) => set({ phone: e.target.value })} />
          </label>
          <label className="field">
            Email
            <input value={form.email || ''} onChange={(e) => set({ email: e.target.value })} />
          </label>
          <label className="field">
            Website
            <input value={form.website || ''} onChange={(e) => set({ website: e.target.value })} />
          </label>
        </div>
        <div className="grid-2">
          <label className="field">
            Additional phone
            <input value={form.phone2 || ''} onChange={(e) => set({ phone2: e.target.value })} />
          </label>
          <span></span>
        </div>
        <label className="field">
          Default terms &amp; conditions
          <textarea rows="3" value={form.terms || ''} onChange={(e) => set({ terms: e.target.value })} />
        </label>
        <button className="btn primary" disabled={saving} onClick={save}>
          💾 Save settings
        </button>
      </div>

      <div className="card payments-editor">
        <h2>Item catalogue (stock)</h2>
        <p style={{ marginTop: -6, color: 'var(--muted)', fontSize: '.82rem' }}>
          Saved items appear as suggestions when filling invoices. New items typed on an invoice
          are added here automatically on save.
        </p>
        <div className="item-row" style={{ gridTemplateColumns: '1fr 110px 34px' }}>
          <input
            placeholder="Item name…"
            value={newItem.name}
            onChange={(e) => setNewItem((n) => ({ ...n, name: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && addStockItem()}
          />
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Price"
            value={newItem.price}
            onChange={(e) => setNewItem((n) => ({ ...n, price: e.target.value }))}
          />
          <span></span>
        </div>
        <button className="btn ghost small" onClick={addStockItem}>+ Add to stock</button>
        {stock.length > 0 && (
          <ul className="stock-list">
            {stock.map((s) => (
              <li key={s.id}>
                <span className="stock-name">{s.name}</span>
                <span className="stock-price">${Number(s.price || 0).toFixed(2)}</span>
                <button className="icon-btn" title="Remove item" onClick={() => removeStockItem(s.id)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
