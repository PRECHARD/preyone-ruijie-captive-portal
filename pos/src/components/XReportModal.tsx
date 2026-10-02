import { useState } from 'react';
import { api, type MethodTotal, type Shift } from '../api';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

export default function XReportModal({
  shift,
  totals,
  onClose,
  onClosed,
  onError,
}: {
  shift: Shift;
  totals: MethodTotal[];
  onClose: () => void;
  onClosed: () => void;
  onError: (message: string) => void;
}) {
  const [stage, setStage] = useState<'view' | 'closing' | 'closed'>('view');
  const [counted, setCounted] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Shift | null>(null);

  const cashTotal = Number(totals.find((t) => t.method === 'cash')?.total || 0);
  const expectedCash = (Number(shift.opening_float) || 0) + cashTotal;

  const doClose = async () => {
    setBusy(true);
    try {
      const data = await api.closeShift(Number(counted) || 0);
      setResult(data.shift);
      setStage('closed');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not close shift');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={stage === 'view' ? onClose : undefined}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {stage === 'view' && (
          <>
            <h3 className="modal-title">X-Report · current shift</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.8rem' }}>
              Opened {new Date(shift.opened_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </div>

            <div className="x-report-row"><span>Opening float</span><strong>{money(shift.opening_float)}</strong></div>
            {totals.map((t) => (
              <div className="x-report-row" key={t.method}>
                <span className="receipt-muted">{t.method} ({t.count})</span>
                <span>{money(t.total)}</span>
              </div>
            ))}
            <hr className="r-rule" />
            <div className="x-report-row">
              <span><strong>Cash expected in drawer</strong></span>
              <strong>{money(expectedCash)}</strong>
            </div>

            <button className="primary-btn" onClick={() => setStage('closing')}>Close shift (Z)</button>
            <button className="secondary-btn" onClick={onClose}>Back to till</button>
          </>
        )}

        {stage === 'closing' && (
          <>
            <h3 className="modal-title">Cash-up</h3>
            <p className="hint">Count the drawer and enter the actual cash total.</p>
            <div className="x-report-row"><span>Expected</span><strong>{money(expectedCash)}</strong></div>
            <label className="field-label">
              Cash counted ($)
              <input
                type="number"
                min="0"
                step="0.01"
                value={counted}
                autoFocus
                onChange={(e) => setCounted(e.target.value)}
              />
            </label>
            <button className="primary-btn" disabled={busy || counted === ''} onClick={doClose}>
              {busy ? 'Closing…' : 'Confirm close'}
            </button>
            <button className="secondary-btn" onClick={() => setStage('view')}>Back</button>
          </>
        )}

        {stage === 'closed' && result && (
          <>
            <h3 className="modal-title">Shift closed ✓</h3>
            <div className="x-report-row"><span>Expected cash</span><strong>{money(result.expected_cash ?? 0)}</strong></div>
            <div className="x-report-row"><span>Counted cash</span><strong>{money(result.counted_cash ?? 0)}</strong></div>
            <hr className="r-rule" />
            <div
              className={`change-box ${Math.abs(result.variance ?? 0) > 0.005 ? 'due' : ''}`}
              style={{ margin: 0 }}
            >
              <span className="lbl">VARIANCE</span>
              <span className="amt">{money(result.variance ?? 0)}</span>
            </div>
            <button className="primary-btn" onClick={onClosed}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}
