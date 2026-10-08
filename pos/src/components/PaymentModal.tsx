import { useState } from 'react';
import { api, type PosDocument } from '../api';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

// Same verified Pesepay rails the till offers (see CheckoutModal).
const METHODS = [
  { key: 'cash', label: 'Cash' },
  { key: 'ecocash', label: 'EcoCash' },
  { key: 'innbucks', label: 'InnBucks' },
  { key: 'paygo', label: 'PayGo' },
  { key: 'omari', label: 'Omari' },
  { key: 'card', label: 'Card' },
  { key: 'bank', label: 'Bank' },
  { key: 'pesepay', label: 'Pesepay' },
  { key: 'other', label: 'Other' },
];

export default function PaymentModal({
  doc,
  onCancel,
  onSaved,
}: {
  doc: PosDocument;
  onCancel: () => void;
  onSaved: (updated: PosDocument & { balanceDue?: number }) => void;
}) {
  const balance = Math.max(Number(doc.total) - Number(doc.amount_paid), 0);
  const [amount, setAmount] = useState(String(balance.toFixed(2)));
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const value = Number(amount) || 0;
  const canSubmit = !busy && value > 0;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const updated = await api.recordPayment(doc.id, {
        amount: Math.round(value * 100) / 100,
        method,
        reference: reference.trim() || undefined,
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment could not be recorded');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Record payment</h3>
        <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.6rem' }}>
          {doc.doc_type === 'quotation' ? 'Quotation' : 'Invoice'} {doc.doc_number}
        </div>

        <div className="pay-total-line">
          <span className="lbl">BALANCE DUE</span>
          <span className="amt">{money(balance)}</span>
        </div>

        <div className="method-tabs">
          {METHODS.map((m) => (
            <button key={m.key} className={method === m.key ? 'on' : ''} onClick={() => setMethod(m.key)}>
              {m.label}
            </button>
          ))}
        </div>

        <label className="field-label">
          {method === 'cash' ? 'Cash tendered ($)' : `Amount ($)`}
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            autoFocus
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        {method !== 'cash' && (
          <label className="field-label">
            Reference / approval code
            <input
              value={reference}
              placeholder="e.g. 8H3K2M"
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
        )}

        {error && (
          <div style={{ color: 'var(--danger, #c0392b)', fontSize: '0.8rem', margin: '0.4rem 0' }}>
            {error}
          </div>
        )}

        <button className="primary-btn" disabled={!canSubmit} onClick={submit}>
          {busy ? 'Recording…' : `Record ${money(value)} payment`}
        </button>
        <button className="secondary-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
