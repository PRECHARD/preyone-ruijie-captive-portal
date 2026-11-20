import { useEffect, useRef, useState } from 'react';

export interface ConfirmInput {
  label: string;
  placeholder?: string;
  required?: boolean;
  initialValue?: string;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  /** Optional text field, e.g. a void reason or a new PIN. */
  input?: ConfirmInput;
  onConfirm: (value: string) => Promise<void> | void;
}

/**
 * Branded replacement for window.confirm/window.prompt. Uses the same dark
 * glass + purple gradient language as the rest of the invoicing workspace.
 */
export function ConfirmDialog({
  options,
  onClose,
}: {
  options: ConfirmOptions;
  onClose: () => void;
}) {
  const [value, setValue] = useState(options.input?.initialValue ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (options.input) {
      const timer = window.setTimeout(() => inputRef.current?.focus(), 40);
      return () => window.clearTimeout(timer);
    }
  }, [options.input]);

  const confirm = async () => {
    if (options.input?.required && !value.trim()) {
      setError(`${options.input.label} is required.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await options.onConfirm(value.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay confirm-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={`confirm-card${options.tone === 'danger' ? ' danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preyone-confirm-title"
      >
        <span className="confirm-orb" aria-hidden />
        <div className="confirm-kicker">Preyone secure action</div>
        <h2 id="preyone-confirm-title" className="confirm-title">
          {options.title}
        </h2>
        <p className="confirm-message">{options.message}</p>

        {options.input && (
          <label className="field confirm-field">
            <span>{options.input.label}</span>
            <input
              ref={inputRef}
              className="input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={options.input.placeholder}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void confirm();
                }
              }}
            />
          </label>
        )}

        {error && <div className="banner error">{error}</div>}

        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {options.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            className={`btn ${options.tone === 'danger' ? 'danger' : 'primary'}`}
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? 'Working…' : options.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
