import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { posApi, money } from '../api/pos';
import { showToast } from '../utils/toast';
import Table from '../components/Table';
import Badge from '../components/Badge';
import Modal from '../components/Modal';

interface Draft {
  id?: string;
  name: string; sku: string; barcode: string; category: string;
  price: string; costPrice: string; stockQty: string;
  trackStock: boolean; lowStockThreshold: string;
}

const emptyDraft: Draft = {
  name: '', sku: '', barcode: '', category: '',
  price: '', costPrice: '', stockQty: '0', trackStock: true, lowStockThreshold: '3',
};

const inputStyle = { padding: '8px 10px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, width: '100%', boxSizing: 'border-box' } as const;

export default function PosInventory() {
  const { user } = useAuth();
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adjusting, setAdjusting] = useState<{ p: any; delta: string; reason: string } | null>(null);
  const canManage = user?.role === 'Manager' || user?.role === 'CEO';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProducts(await posApi.get('/products?includeInactive=1'));
    } catch (e: any) {
      showToast({ title: 'Load failed', message: e.message, type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveDraft = async () => {
    if (!draft) return;
    try {
      const body = {
        name: draft.name.trim(),
        sku: draft.sku.trim() || null,
        barcode: draft.barcode.trim() || null,
        category: draft.category.trim() || null,
        price: Number(draft.price) || 0,
        costPrice: Number(draft.costPrice) || 0,
        stockQty: Number(draft.stockQty) || 0,
        trackStock: draft.trackStock,
        lowStockThreshold: Number(draft.lowStockThreshold) || 0,
      };
      if (!body.name) throw new Error('Product name is required');
      if (draft.id) await posApi.put(`/products/${draft.id}`, body);
      else await posApi.post('/products', body);
      showToast({ title: 'Saved', message: `${body.name} saved`, type: 'success' });
      setDraft(null);
      load();
    } catch (e: any) {
      showToast({ title: 'Save failed', message: e.message, type: 'error' });
    }
  };

  const applyAdjustment = async () => {
    if (!adjusting) return;
    const delta = Number(adjusting.delta);
    if (!delta) { showToast({ title: 'Enter a non-zero quantity', message: '', type: 'warning' }); return; }
    try {
      await posApi.post(`/products/${adjusting.p.id}/stock`, { delta, reason: adjusting.reason || 'adjustment' });
      showToast({ title: 'Stock adjusted', message: `${adjusting.p.name}: ${delta > 0 ? '+' : ''}${delta}`, type: 'success' });
      setAdjusting(null);
      load();
    } catch (e: any) {
      showToast({ title: 'Adjustment failed', message: e.message, type: 'error' });
    }
  };

  const archive = async (p: any) => {
    if (!window.confirm(`Archive ${p.name}? It will disappear from the till but keep its history.`)) return;
    try {
      await posApi.del(`/products/${p.id}`);
      showToast({ title: 'Archived', message: p.name, type: 'success' });
      load();
    } catch (e: any) {
      showToast({ title: 'Archive failed', message: e.message, type: 'error' });
    }
  };

  const filtered = products.filter(p =>
    !q.trim() ||
    p.name.toLowerCase().includes(q.toLowerCase()) ||
    (p.sku || '').toLowerCase().includes(q.toLowerCase()) ||
    (p.category || '').toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">POS Inventory</h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Products sold at the till — prices, cost and stock levels</p>
        </div>
        {canManage && (
          <button onClick={() => setDraft({ ...emptyDraft })} style={{ background: 'var(--primary, #36116a)', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontWeight: 600, cursor: 'pointer' }}>
            + Add product
          </button>
        )}
      </div>

      <input placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} style={{ ...inputStyle, maxWidth: 320, marginBottom: 16 }} />

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : (
        <Table
          data={filtered}
          emptyMessage="No products yet"
          columns={[
            { key: 'name', label: 'PRODUCT', render: r => (<span>{r.name} {!r.active && <Badge variant="inactive">archived</Badge>}</span>) },
            { key: 'sku', label: 'SKU / BARCODE', render: r => r.sku || r.barcode || '—' },
            { key: 'category', label: 'CATEGORY' },
            { key: 'cost_price', label: 'COST', render: r => money(r.cost_price) },
            { key: 'price', label: 'PRICE', render: r => <strong>{money(r.price)}</strong> },
            { key: 'stock_qty', label: 'STOCK', render: r => !r.track_stock ? <span style={{ color: 'var(--text-muted)' }}>service</span> : (
              <span style={{ color: Number(r.stock_qty) <= Number(r.low_stock_threshold) ? 'var(--orange)' : undefined, fontWeight: Number(r.stock_qty) <= Number(r.low_stock_threshold) ? 700 : 400 }}>
                {Number(r.stock_qty)}
              </span>
            ) },
            ...(canManage ? [{
              key: '_actions', label: '',
              render: (r: any) => (
                <span style={{ whiteSpace: 'nowrap' }}>
                  <button onClick={() => setAdjusting({ p: r, delta: '', reason: '' })} title="Adjust stock" style={{ marginRight: 6, cursor: 'pointer', background: 'rgba(255,255,255,0.06)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px' }}>±</button>
                  <button onClick={() => setDraft({ id: r.id, name: r.name, sku: r.sku || '', barcode: r.barcode || '', category: r.category || '', price: String(r.price), costPrice: String(r.cost_price), stockQty: String(r.stock_qty), trackStock: r.track_stock, lowStockThreshold: String(r.low_stock_threshold) })} title="Edit" style={{ marginRight: 6, cursor: 'pointer', background: 'rgba(255,255,255,0.06)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px' }}>✎</button>
                  {r.active && (
                    <button onClick={() => archive(r)} title="Archive" style={{ cursor: 'pointer', background: 'rgba(255,23,68,0.12)', color: 'var(--red)', border: 'none', borderRadius: 6, padding: '4px 8px' }}>🗑</button>
                  )}
                </span>
              ),
            }] : []),
          ]}
        />
      )}

      <Modal open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? 'Edit product' : 'New product'}>
        {draft && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label style={{ gridColumn: '1 / -1', fontSize: '0.72rem', color: 'var(--text-muted)' }}>NAME *
                <input style={inputStyle} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>SKU<input style={inputStyle} value={draft.sku} onChange={e => setDraft({ ...draft, sku: e.target.value })} /></label>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>BARCODE<input style={inputStyle} value={draft.barcode} onChange={e => setDraft({ ...draft, barcode: e.target.value })} /></label>
              <label style={{ gridColumn: '1 / -1', fontSize: '0.72rem', color: 'var(--text-muted)' }}>CATEGORY<input style={inputStyle} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value })} /></label>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>SELLING PRICE ($)<input type="number" step="0.01" style={inputStyle} value={draft.price} onChange={e => setDraft({ ...draft, price: e.target.value })} /></label>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>COST PRICE ($)<input type="number" step="0.01" style={inputStyle} value={draft.costPrice} onChange={e => setDraft({ ...draft, costPrice: e.target.value })} /></label>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{draft.id ? 'STOCK QTY' : 'OPENING STOCK'}<input type="number" style={inputStyle} value={draft.stockQty} onChange={e => setDraft({ ...draft, stockQty: e.target.value })} /></label>
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>LOW-STOCK ALERT AT<input type="number" style={inputStyle} value={draft.lowStockThreshold} onChange={e => setDraft({ ...draft, lowStockThreshold: e.target.value })} /></label>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '14px 0', fontSize: '0.85rem', color: 'var(--text)' }}>
              <input type="checkbox" checked={draft.trackStock} onChange={e => setDraft({ ...draft, trackStock: e.target.checked })} />
              Track stock (untick for services like printing)
            </label>
            <button onClick={saveDraft} style={{ width: '100%', background: 'var(--primary, #36116a)', color: '#fff', border: 'none', borderRadius: 8, padding: '11px', fontWeight: 600, cursor: 'pointer' }}>
              Save product
            </button>
          </>
        )}
      </Modal>

      <Modal open={!!adjusting} onClose={() => setAdjusting(null)} title={`Stock · ${adjusting?.p.name || ''}`}>
        {adjusting && (
          <>
            <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>Currently {Number(adjusting.p.stock_qty)} in stock.</p>
            <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>QUANTITY (+ receive / − remove)
              <input type="number" step="1" style={inputStyle} value={adjusting.delta} onChange={e => setAdjusting({ ...adjusting, delta: e.target.value })} />
            </label>
            <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'block', margin: '12px 0' }}>REASON
              <input placeholder="delivery, count correction…" style={inputStyle} value={adjusting.reason} onChange={e => setAdjusting({ ...adjusting, reason: e.target.value })} />
            </label>
            <button onClick={applyAdjustment} style={{ width: '100%', background: 'var(--primary, #36116a)', color: '#fff', border: 'none', borderRadius: 8, padding: '11px', fontWeight: 600, cursor: 'pointer' }}>
              Apply adjustment
            </button>
          </>
        )}
      </Modal>
    </div>
  );
}
