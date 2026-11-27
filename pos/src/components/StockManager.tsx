import { useEffect, useMemo, useState } from 'react';
import { api, type Product } from '../api';
import { productVisual } from '../productVisuals';
import { ConfirmDialog, type ConfirmOptions } from './ConfirmDialog';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

interface Draft {
  id?: string;
  name: string;
  description: string;
  sku: string;
  barcode: string;
  category: string;
  price: string;
  costPrice: string;
  stockQty: string;
  trackStock: boolean;
  lowStockThreshold: string;
  imageUrl: string;
}

const emptyDraft: Draft = {
  name: '', description: '', sku: '', barcode: '', category: '',
  price: '', costPrice: '', stockQty: '0', trackStock: true, lowStockThreshold: '3',
  imageUrl: '',
};

/** Downscale a photo in the browser before it ever reaches the server. */
function readProductPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      reject(new Error('Use a PNG, JPEG or WebP photo.'));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error('Keep the photo under 8 MB.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that photo.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a valid image.'));
      img.onload = () => {
        const max = 640;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not process that photo.'));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/webp', 0.86));
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

export default function StockManager({ onChanged }: { onChanged?: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [showLowOnly, setShowLowOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adjusting, setAdjusting] = useState<{ p: Product; delta: string; reason: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);

  const load = () => {
    api.products(showArchived).then(setProducts).catch(() => {});
  };
  useEffect(load, [showArchived]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (showLowOnly && !(p.track_stock && Number(p.stock_qty) <= Number(p.low_stock_threshold))) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q)
      );
    });
  }, [products, query, showLowOnly]);

  const openEdit = (p: Product) =>
    setDraft({
      id: p.id,
      name: p.name,
      description: p.description || '',
      sku: p.sku || '',
      barcode: p.barcode || '',
      category: p.category || '',
      price: String(p.price),
      costPrice: String(p.cost_price),
      stockQty: String(p.stock_qty),
      trackStock: p.track_stock,
      lowStockThreshold: String(p.low_stock_threshold),
      imageUrl: p.image_url || '',
    });

  const uploadPhoto = async (file: File) => {
    setError('');
    setImageBusy(true);
    try {
      const dataUrl = await readProductPhoto(file);
      const uploaded = await api.uploadProductImage(dataUrl);
      setDraft((d) => (d ? { ...d, imageUrl: uploaded.imageUrl } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload that photo');
    } finally {
      setImageBusy(false);
    }
  };

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
          description: draft.description.trim() || null,
          sku: draft.sku.trim() || null,
          barcode: draft.barcode.trim() || null,
          category: draft.category.trim() || null,
          price: Number(draft.price) || 0,
          costPrice: Number(draft.costPrice) || 0,
          stockQty: Number(draft.stockQty) || 0,
          trackStock: draft.trackStock,
          lowStockThreshold: Number(draft.lowStockThreshold) || 0,
          imageUrl: draft.imageUrl || null,
        });
      } else {
        await api.createProduct({
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          sku: draft.sku,
          barcode: draft.barcode,
          category: draft.category,
          price: Number(draft.price) || 0,
          cost_price: Number(draft.costPrice) || 0,
          stock_qty: Number(draft.stockQty) || 0,
          track_stock: draft.trackStock,
          low_stock_threshold: Number(draft.lowStockThreshold) || 0,
          image_url: draft.imageUrl || null,
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

  const archive = (p: Product) => {
    setConfirm({
      title: 'Archive this product?',
      message: `${p.name} will be hidden from the till and stock picker. Its sales history stays intact and you can restore it later.`,
      confirmLabel: 'Archive product',
      tone: 'danger',
      onConfirm: async () => {
        await api.archiveProduct(p.id);
        load();
        onChanged?.();
      },
    });
  };

  const restore = async (p: Product) => {
    try {
      await api.updateProduct(p.id, { active: true });
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restore');
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

  const draftVisual = draft ? productVisual(draft) : null;

  return (
    <div className="catalogue">
      <div className="search-row">
        <input placeholder="Search products…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button
          type="button"
          className={`secondary-btn ${showLowOnly ? 'is-on' : ''}`}
          style={{ whiteSpace: 'nowrap' }}
          onClick={() => setShowLowOnly((v) => !v)}
        >
          {showLowOnly ? 'Low stock only' : 'Low stock'}
        </button>
        <button
          className="secondary-btn"
          style={{ whiteSpace: 'nowrap' }}
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
        <button style={{ padding: '0 1rem', whiteSpace: 'nowrap' }} onClick={() => setDraft({ ...emptyDraft })}>
          + Add product
        </button>
      </div>

      <div className="stock-table-wrap">
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
                <td>
                  {p.name}{!p.active && ' (archived)'}
                  {p.description && <span className="product-desc">{p.description}</span>}
                </td>
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
                  {p.active ? (
                    <button className="qty-btn" title="Archive" onClick={() => archive(p)}>🗑</button>
                  ) : (
                    <button className="qty-btn" title="Restore" onClick={() => restore(p)}>↺</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {filtered.length === 0 && <div className="empty-note">No products yet — add your first one.</div>}

      {draft && (
        <div className="modal-backdrop" onClick={() => setDraft(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">{draft.id ? 'Edit product' : 'New product'}</h3>
            {error && <div className="err-msg">{error}</div>}
            <div className="form-grid">
              {field('Name *', 'name', { wide: true })}
              <label className="field-label" style={{ gridColumn: '1 / -1' }}>
                Description
                <textarea
                  rows={Math.min(8, Math.max(3, draft.description.split(/\r?\n/).length + 1))}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder={'One detail per line — e.g.\n5 m heavy duty cable\n16 A rated\n2-year warranty'}
                />
              </label>

              <div className="product-photo-field">
                <div className={`product-photo-preview p-tone-${draftVisual?.tone || 'slate'}`}>
                  {draft.imageUrl ? (
                    <img src={draft.imageUrl} alt="" />
                  ) : (
                    <span className="p-glyph" aria-hidden>
                      {draftVisual?.emoji}
                    </span>
                  )}
                  {!draft.imageUrl && (
                    <span className="auto-icon-badge">Auto-matched: {draftVisual?.label}</span>
                  )}
                </div>
                <div className="product-photo-copy">
                  <strong>Product photo</strong>
                  <p>
                    Add a real photo for the till. Leave it blank and Preyone draws the
                    matching icon ({draftVisual?.label || 'Product'}) from the product name.
                  </p>
                  <div className="product-photo-actions">
                    <label className="secondary-btn" style={{ cursor: imageBusy ? 'progress' : 'pointer' }}>
                      {imageBusy ? 'Uploading…' : draft.imageUrl ? 'Replace photo' : 'Upload photo'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        hidden
                        disabled={imageBusy}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadPhoto(file);
                          event.target.value = '';
                        }}
                      />
                    </label>
                    {draft.imageUrl && (
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => setDraft({ ...draft, imageUrl: '' })}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>

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

      {confirm && <ConfirmDialog options={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
