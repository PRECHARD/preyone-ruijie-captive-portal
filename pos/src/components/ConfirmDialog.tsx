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
  input?: ConfirmInput;
  onConfirm: (value: string) => Promise<void> | void;
}

/** Branded POS confirmation / prompt, replacing native confirm() and prompt(). */
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
      className="modal-backdrop confirm-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className={`modal-card confirm-card-pos${options.tone === 'danger' ? ' danger' : ''}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pos-confirm-title"
      >
        <span className="confirm-orb" aria-hidden />
        <div className="confirm-kicker">Preyone secure action</div>
        <h3 id="pos-confirm-title" className="modal-title confirm-title-pos">
          {options.title}
        </h3>
        <p className="confirm-message">{options.message}</p>

        {options.input && (
          <label className="field-label confirm-field">
            {options.input.label}
            <input
              ref={inputRef}
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

        {error && <div className="err-msg">{error}</div>}

        <div className="confirm-actions">
          <button className="secondary-btn" type="button" onClick={onClose} disabled={busy}>
            {options.cancelLabel || 'Cancel'}
          </button>
          <button
            className={options.tone === 'danger' ? 'primary-btn danger-btn' : 'primary-btn'}
            type="button"
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
