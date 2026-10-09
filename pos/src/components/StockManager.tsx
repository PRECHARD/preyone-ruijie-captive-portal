import { useEffect, useMemo, useState } from 'react';
import { api, type Product } from '../api';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

interface Draft {
  id?: string;
  name: string;
  sku: string;
  barcode: string;
  category: string;
  price: string;
  costPrice: string;
  stockQty: string;
  trackStock: boolean;
  lowStockThreshold: string;
}

const emptyDraft: Draft = {
  name: '', sku: '', barcode: '', category: '',
  price: '', costPrice: '', stockQty: '0', trackStock: true, lowStockThreshold: '3',
};

export default function StockManager({ onChanged }: { onChanged?: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adjusting, setAdjusting] = useState<{ p: Product; delta: string; reason: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.products().then(setProducts).catch(() => {});
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q)
    );
  }, [products, query]);

  const openEdit = (p: Product) =>
    setDraft({
      id: p.id,
      name: p.name,
      sku: p.sku || '',
      barcode: p.barcode || '',
      category: p.category || '',
      price: String(p.price),
      costPrice: String(p.cost_price),
      stockQty: String(p.stock_qty),
      trackStock: p.track_stock,
      lowStockThreshold: String(p.low_stock_threshold),
    });

  const saveDraft = async () => {
    if (!draft || !draft.name.trim()) {
      setError('Product name is required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (draft.id) {
        await api.updateProduct(draft.id, {
          name: draft.name.trim(),
          sku: draft.sku.trim() || null,
          barcode: draft.barcode.trim() || null,
          category: draft.category.trim() || null,
          price: Number(draft.price) || 0,
          costPrice: Number(draft.costPrice) || 0,
          stockQty: Number(draft.stockQty) || 0,
          trackStock: draft.trackStock,
          lowStockThreshold: Number(draft.lowStockThreshold) || 0,
        });
      } else {
        await api.createProduct({
          name: draft.name.trim(),
          sku: draft.sku,
          barcode: draft.barcode,
          category: draft.category,
          price: Number(draft.price) || 0,
          cost_price: Number(draft.costPrice) || 0,
          stock_qty: Number(draft.stockQty) || 0,
          track_stock: draft.trackStock,
          low_stock_threshold: Number(draft.lowStockThreshold) || 0,
        } as Product & { name: string });
      }
      setDraft(null);
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const applyAdjustment = async () => {
    if (!adjusting) return;
    const delta = Number(adjusting.delta);
    if (!delta) {
      setError('Enter a non-zero quantity');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.adjustStock(adjusting.p.id, delta, adjusting.reason || 'adjustment');
      setAdjusting(null);
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Adjustment failed');
    } finally {
      setBusy(false);
    }
  };

  const archive = async (p: Product) => {
    try {
      await api.archiveProduct(p.id);
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not archive');
    }
  };

  const field = (label: string, key: keyof Draft, opts: { type?: string; wide?: boolean } = {}) => (
    <label className="field-label" style={opts.wide ? { gridColumn: '1 / -1' } : undefined}>
      {label}
      <input
        type={opts.type || 'text'}
        value={String(draft![key])}
        onChange={(e) => setDraft({ ...draft!, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="catalogue">
      <div className="search-row">
        <input placeholder="Search products…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button style={{ padding: '0 1rem', whiteSpace: 'nowrap' }} onClick={() => setDraft({ ...emptyDraft })}>
          + Add product
        </button>
      </div>

      <table className="stock-table">
        <thead>
          <tr>
            <th>Product</th><th>SKU / Barcode</th><th>Category</th>
            <th style={{ textAlign: 'right' }}>Cost</th><th style={{ textAlign: 'right' }}>Price</th>
            <th style={{ textAlign: 'right' }}>Stock</th><th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => {
            const low = p.track_stock && Number(p.stock_qty) <= Number(p.low_stock_threshold);
            return (
              <tr key={p.id} className={p.active ? '' : 'archived'}>
                <td>{p.name}{!p.active && ' (archived)'}</td>
                <td>{p.sku || p.barcode || '—'}</td>
                <td>{p.category || '—'}</td>
                <td style={{ textAlign: 'right' }}>{money(Number(p.cost_price))}</td>
                <td style={{ textAlign: 'right' }}><strong>{money(Number(p.price))}</strong></td>
                <td style={{ textAlign: 'right' }}>
                  {!p.track_stock ? '—' : (
                    <span className={low ? 'stock-low' : ''}>
                      {Number(p.stock_qty)}
                    </span>
                  )}
                </td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <button className="qty-btn" title="Receive / adjust stock" onClick={() => setAdjusting({ p, delta: '', reason: '' })}>±</button>{' '}
                  <button className="qty-btn" title="Edit" onClick={() => openEdit(p)}>✎</button>{' '}
                  {p.active && <button className="qty-btn" title="Archive" onClick={() => archive(p)}>🗑</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {filtered.length === 0 && <div className="empty-note">No products yet — add your first one.</div>}

      {draft && (
        <div className="modal-backdrop" onClick={() => setDraft(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">{draft.id ? 'Edit product' : 'New product'}</h3>
            {error && <div className="err-msg">{error}</div>}
            <div className="form-grid">
              {field('Name *', 'name', { wide: true })}
              {field('SKU', 'sku')}
              {field('Barcode', 'barcode')}
              {field('Category', 'category', { wide: true })}
              {field('Selling price ($)', 'price', { type: 'number' })}
              {field('Cost price ($)', 'costPrice', { type: 'number' })}
              {field('Opening stock', 'stockQty', { type: 'number' })}
              {field('Low-stock alert at', 'lowStockThreshold', { type: 'number' })}
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '0.6rem 0', fontSize: '0.85rem' }}>
              <input
                type="checkbox"
                checked={draft.trackStock}
                onChange={(e) => setDraft({ ...draft, trackStock: e.target.checked })}
              />
              Track stock (untick for services like printing)
            </label>
            <button className="primary-btn" disabled={busy} onClick={saveDraft}>
              {busy ? 'Saving…' : 'Save product'}
            </button>
            <button className="secondary-btn" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      {adjusting && (
        <div className="modal-backdrop" onClick={() => setAdjusting(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Stock · {adjusting.p.name}</h3>
            {error && <div className="err-msg">{error}</div>}
            <p style={{ color: 'var(--muted)', fontSize: '0.82rem', margin: '0 0 0.6rem' }}>
              Current: {Number(adjusting.p.stock_qty)} in stock
            </p>
            <label className="field-label">
              Quantity (+ receive / − remove)
              <input type="number" step="1" value={adjusting.delta} autoFocus
                onChange={(e) => setAdjusting({ ...adjusting, delta: e.target.value })} />
            </label>
            <label className="field-label">
              Reason
              <input value={adjusting.reason} placeholder="e.g. delivery, count correction"
                onChange={(e) => setAdjusting({ ...adjusting, reason: e.target.value })} />
            </label>
            <button className="primary-btn" disabled={busy} onClick={applyAdjustment}>Apply adjustment</button>
            <button className="secondary-btn" onClick={() => setAdjusting(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
