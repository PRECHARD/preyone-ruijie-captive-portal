import { useState } from 'react';
import { api, type Shift } from '../api';

export default function ShiftGate({
  onOpened,
  onError,
}: {
  onOpened: (shift: Shift) => void;
  onError: (message: string) => void;
}) {
  const [float, setFloat] = useState('0');
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const shift = await api.openShift(Number(float) || 0);
      onOpened(shift);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not open shift');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-card">
      <h2>Open your shift</h2>
      <p className="hint">Count and enter the cash in the drawer to start selling.</p>
      <label className="field-label">
        Opening float ($)
        <input
          type="number"
          min="0"
          step="0.01"
          value={float}
          autoFocus
          onChange={(e) => setFloat(e.target.value)}
        />
      </label>
      <button className="primary-btn" disabled={busy} onClick={open}>
        Open shift
      </button>
    </div>
  );
}
