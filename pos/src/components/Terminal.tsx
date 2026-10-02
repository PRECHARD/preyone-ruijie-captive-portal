import { useEffect, useMemo, useState } from 'react';
import { api, type Product, type StaffUser, type CheckoutResult, type CompanyProfile } from '../api';
import CheckoutModal from './CheckoutModal';
import ReceiptModal from './ReceiptModal';

interface Props {
  user: StaffUser;
  notify: (msg: string, kind?: 'ok' | 'error') => void;
  onApiError: (e: unknown) => boolean;
  onShiftChanged: () => Promise<void>;
}

type DocType = 'sale' | 'invoice' | 'quotation';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

export default function Terminal({ user, notify, onApiError, onShiftChanged }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartLineState[]>([]);
  const [docType, setDocType] = useState<DocType>('sale');
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [discountPct, setDiscountPct] = useState('0');
  const [taxPct, setTaxPct] = useState('15.5');
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [receipt, setReceipt] = useState<CheckoutResult | null>(null);
  const [company, setCompany] = useState<CompanyProfile | null>(null);

  interface CartLineState {
    productId: string | null;
    description: string;
    price: number;
    qty: number;
  }

  useEffect(() => {
    api.products()
      .then(setProducts)
      .catch((e) => { if (!onApiError(e)) notify('Could not load products', 'error'); });
  }, [notify, onApiError]);

  useEffect(() => {
    api.company()
      .then(setCompany)
      .catch(() => { /* receipts fall back to defaults */ });
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.sku || '').toLowerCase().includes(q) ||
        (p.barcode || '').includes(q)
    );
  }, [products, query]);

  const addToCart = (p: Product) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.productId === p.id);
      if (i >= 0) {
        const copy = [...c];
        copy[i] = { ...copy[i], qty: copy[i].qty + 1 };
        return copy;
      }
      return [...c, { productId: p.id, description: p.name, price: Number(p.price), qty: 1 }];
    });
  };

  // Scanner support: Enter in search adds exact barcode/SKU match instantly
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const q = query.trim().toLowerCase();
    if (!q) return;
    const exact = products.find(
      (p) => (p.barcode || '').toLowerCase() === q || (p.sku || '').toLowerCase() === q
    );
    if (exact) {
      addToCart(exact);
      setQuery('');
    }
  };

  const bumpQty = (idx: number, delta: number) => {
    setCart((c) =>
      c
        .map((l, i) => (i === idx ? { ...l, qty: Math.max(0, l.qty + delta) } : l))
        .filter((l) => l.qty > 0)
    );
  };

  const removeLine = (idx: number) => setCart((c) => c.filter((_, i) => i !== idx));

  const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0);
  const disc = (subtotal * (Number(discountPct) || 0)) / 100;
  const taxPctNum = Number(taxPct) || 0;
  const total = Math.round((subtotal - disc) * 100) / 100;
  const vatIncluded = total > 0 ? Math.round((total * taxPctNum * 100) / (100 + taxPctNum)) / 100 : 0;

  const needsCustomer = docType !== 'sale';
  const canCharge = cart.length > 0 && total >= 0;

  const completeSale = async (payments: Array<{ amount: number; method: string; reference?: string }>, customerNameInput?: string) => {
    const effectiveCustName = customerNameInput || custName.trim();
    try {
      const result = await api.checkout({
        docType,
        channel: 'till',
        customer: effectiveCustName ? { name: effectiveCustName, phone: custPhone.trim() } : undefined,
        items: cart.map((l) => ({
          productId: l.productId,
          description: l.description,
          price: l.price,
          qty: l.qty,
        })),
        payments,
        discountPct: Number(discountPct) || 0,
        taxPct: Number(taxPct) || 0,
      });
      setCheckoutOpen(false);
      setReceipt({
        ...result,
        payments,
        customer_name: effectiveCustName || undefined,
        customer_phone: custPhone.trim() || undefined,
      });
      setCart([]);
      setCustName('');
      setCustPhone('');
      setDiscountPct('0');
      setTaxPct('15.5');
      notify(`${result.doc_number} completed`);
      await onShiftChanged();
    } catch (e) {
      if (!onApiError(e)) notify(e instanceof Error ? e.message : 'Sale failed', 'error');
    }
  };

  return (
    <div className="main-split">
      <section className="catalogue">
        <div className="search-row">
          <input
            placeholder="Scan barcode or search products…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <button onClick={() => setQuery('')} title="Clear" style={{ padding: '0 1rem' }}>✕</button>
        </div>
        {filtered.length === 0 ? (
          <div className="empty-note">No products match. Add stock in the admin console.</div>
        ) : (
          <div className="product-grid">
            {filtered.map((p) => {
              const low = p.track_stock && Number(p.stock_qty) <= Number(p.low_stock_threshold);
              return (
                <button className="product-card" key={p.id} onClick={() => addToCart(p)}>
                  <span className="p-name">{p.name}</span>
                  <span className="p-price">{money(Number(p.price))}</span>
                  <span className={`p-stock ${low ? 'low' : ''}`}>
                    {p.track_stock ? `${Number(p.stock_qty)} in stock` : 'service'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <aside className="cart-pane">
        <div className="cart-head">
          <span>CURRENT SALE</span>
          <button className="remove-btn" onClick={() => setCart([])} title="Clear sale">🗑</button>
        </div>

        <div className="cart-lines">
          {cart.length === 0 ? (
            <div className="empty-note">Tap a product to start</div>
          ) : (
            cart.map((l, idx) => (
              <div className="cart-line" key={`${l.productId}-${idx}`}>
                <div>
                  <div className="cl-name">{l.description}</div>
                  <div className="cl-price">{money(l.price)} each</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button className="qty-btn" onClick={() => bumpQty(idx, -1)}>−</button>
                  <span className="qty-val">{l.qty}</span>
                  <button className="qty-btn" onClick={() => bumpQty(idx, 1)}>+</button>
                </div>
                <span className="cl-total">{money(l.price * l.qty)}</span>
                <button className="remove-btn" onClick={() => removeLine(idx)}>✕</button>
              </div>
            ))
          )}
        </div>

        <div className="cart-foot">
          <div className="doc-type-row">
            {(['sale', 'invoice', 'quotation'] as DocType[]).map((t) => (
              <button key={t} className={docType === t ? 'on' : ''} onClick={() => setDocType(t)}>
                {t === 'sale' ? 'Quick Sale' : t === 'invoice' ? 'Invoice' : 'Quotation'}
              </button>
            ))}
          </div>

          <div className="customer-fields">
            <input placeholder="Customer name (optional)" value={custName} onChange={(e) => setCustName(e.target.value)} />
            {needsCustomer && <input placeholder="Phone (optional)" value={custPhone} onChange={(e) => setCustPhone(e.target.value)} />}
          </div>

          <div className="mini-inputs">
            <label>
              DISCOUNT %
              <input type="number" min="0" max="100" value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
            </label>
            <label>
              TAX %
              <input type="number" min="0" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} />
            </label>
          </div>

          <div className="tot-row"><span>Subtotal</span><span>{money(subtotal)}</span></div>
          {(Number(discountPct) || 0) > 0 && <div className="tot-row"><span>Discount</span><span>−{money(disc)}</span></div>}
          {taxPctNum > 0 && <div className="tot-row"><span>VAT {taxPctNum}% (INCL.)</span><span>{money(vatIncluded)}</span></div>}
          <div className="tot-row grand"><span>Total</span><span>{money(total)}</span></div>

          <button className="charge-btn" disabled={!canCharge} onClick={() => setCheckoutOpen(true)}>
            CHARGE {money(total)}
          </button>
        </div>
      </aside>

      {checkoutOpen && (
        <CheckoutModal
          total={total}
          cashierName={user.fullName}
          onCancel={() => setCheckoutOpen(false)}
          onComplete={completeSale}
        />
      )}

      {receipt && (
        <ReceiptModal
          result={receipt}
          cashierName={user.fullName}
          company={{
            name: company?.name || 'Preyone enterprise',
            phone: company?.support_phone || '+263 77 132 7202',
            website: company?.website || 'www.preyone.com',
            email: company?.email || 'info@preyone.com',
          }}
          onDone={() => setReceipt(null)}
        />
      )}
    </div>
  );
}
