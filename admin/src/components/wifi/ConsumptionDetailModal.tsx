import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../api/client';
import Modal from '../Modal';
import { drawVoucherCanvas } from '../../utils/voucherCard';
import type { ConsumptionStatus, VoucherConsumptionRow } from '../../types/wifi';
import './voucherConsumption.css';

/** Same badge vocabulary as the Consumption table + Vouchers detail sheet. */
const STATUS_LABEL: Record<ConsumptionStatus, string> = {
  idle: 'IDLE',
  ok: 'OK',
  low: 'LOW 80%',
  critical: 'CRIT 95%',
  exhausted: 'DRAINED',
  unlimited: 'UNLIMITED',
  disabled: 'DISABLED',
};

const STATUS_BADGE: Record<ConsumptionStatus, string> = {
  idle: 'badge badge--idle',
  ok: 'badge badge--yes',
  low: 'badge badge--warn',
  critical: 'badge badge--crit',
  exhausted: 'badge badge--no',
  unlimited: 'badge badge--unl',
  disabled: 'badge badge--muted',
};

/** Local sales row from GET /api/admin/vouchers (subset the modal renders). */
interface VoucherSaleDetail {
  id: string;
  code: string;
  price_amount: string;
  duration_min: number;
  bandwidth_mbps_up: number;
  bandwidth_mbps_down: number;
  data_limit_gb: number | null;
  is_uncapped: boolean;
  max_uses: number;
  used_count: number;
  expires_at: string;
  created_at: string;
  package_tier: string | null;
  status?: string | null;
  first_redeemed_at?: string | null;
  activated_at?: string | null;
  max_devices?: number | null;
  effective_max_devices?: number | null;
  device_count?: number;
  devices?: Array<{
    mac_address: string;
    label: string | null;
    is_active: boolean;
    bound_at: string | null;
    last_seen_at: string | null;
    unbound_at: string | null;
  }> | null;
  phone?: string | null;
  mac_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  alias?: string | null;
  redemption_name?: string | null;
  redemption_mac?: string | null;
  redemption_at?: string | null;
  traffic_used_bytes?: number;
  traffic_total_bytes?: number | null;
  holder_name?: string | null;
}

const lc = (s?: string | null) => (s || '').toLowerCase();

function fmtDur(m: number): string {
  if (!m) return '—';
  if (m >= 43200) return Math.round(m / 43200) + 'mo';
  if (m >= 1440) return Math.round(m / 1440) + 'd';
  if (m >= 60) return Math.round(m / 60) + 'h';
  return m + 'min';
}

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  try { return new Date(d).toLocaleString(); } catch { return d; }
}

function fmtMB(mb: number | null): string {
  if (mb == null) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtWhen(at: string | Date | null): string {
  if (!at) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const statusTone = (status?: string | null) =>
  status === 'Active' ? 'yes'
    : status === 'Disabled' ? 'no'
      : status === 'Unused' ? 'idle'
        : 'muted';

const gb = (b?: number | null) => (b == null ? null : (b / (1024 ** 3)).toFixed(2) + ' GB');

interface Props {
  code: string | null;
  row?: VoucherConsumptionRow | null;
  onClose: () => void;
}

/**
 * Consumption-tab PIN click target: the consumption stats from the roster
 * joined with the local sales row (same GET /vouchers?search= the Vouchers
 * page list uses) in the Vouchers detail-sheet layout, plus card download
 * via the shared voucherCard canvas painter.
 */
export default function ConsumptionDetailModal({ code, row, onClose }: Props) {
  const { user } = useAuth();
  const [sale, setSale] = useState<VoucherSaleDetail | null | undefined>(undefined);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    // No synchronous setState here (react-hooks/set-state-in-effect): the
    // modal remounts per open, so `sale` already starts as `undefined`.
    api.get<{ vouchers?: VoucherSaleDetail[] }>(`/vouchers?search=${encodeURIComponent(code)}&pageSize=5`)
      .then((res) => {
        const list = Array.isArray(res?.vouchers) ? res.vouchers : [];
        setSale(list.find((v) => lc(v.code) === lc(code)) ?? null);
        setActionMsg(null);
      })
      .catch(() => {
        setSale(null);
      });
  }, [code]);

  const copyPin = () => {
    if (!code) return;
    try { navigator.clipboard?.writeText(code); } catch { /* clipboard denied */ }
    setActionMsg('PIN copied.');
  };

  const waText = () => {
    const v = sale;
    return [
      '*Preyone Voucher*',
      '',
      `Code: ${lc(code)}`,
      `Package: ${v?.package_tier || row?.packageName || 'Standard'}`,
      `Price: ${v?.price_amount ? '$' + parseFloat(v.price_amount).toFixed(2) : '—'}`,
      `Duration: ${v ? fmtDur(v.duration_min) : '—'}`,
      `Speed: ${v ? `${v.bandwidth_mbps_up}/${v.bandwidth_mbps_down} Mbps` : '—'}`,
      `Data: ${v ? (v.is_uncapped ? 'Unlimited' : (v.data_limit_gb ?? 'Unlimited') + ' GB') : '—'}`,
      `Valid until: ${fmtDate(v?.expires_at)}`,
      '',
      '_Thank you for choosing Preyone_',
    ].join('\n');
  };

  const copyDetails = () => {
    try { navigator.clipboard?.writeText(waText()); } catch { /* clipboard denied */ }
    setActionMsg('Details copied.');
  };

  const downloadJpeg = async () => {
    if (!code) return;
    const c = document.createElement('canvas');
    try {
      await drawVoucherCanvas(c, sale ?? { code }, user?.fullName || 'Preyone UltraNet');
      const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/jpeg', 0.95));
      if (!blob) { setActionMsg('Could not render the voucher card.'); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `voucher-${lc(code)}.jpeg`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      setActionMsg(`Downloaded voucher-${lc(code)}.jpeg`);
    } catch {
      setActionMsg('Could not render the voucher card.');
    }
  };

  const holderName = sale
    ? ([sale.first_name, sale.last_name].filter(Boolean).join(' ') || sale.alias || sale.redemption_name || sale.holder_name || null)
    : null;
  const redemptionMac = sale?.redemption_mac || sale?.mac_address || null;
  const redemptionAt = sale?.redemption_at || sale?.first_redeemed_at || null;
  const trafficUsed = gb(sale?.traffic_used_bytes);
  const trafficTotal = gb(sale?.traffic_total_bytes);
  const maxDevices = sale?.effective_max_devices ?? sale?.max_devices ?? null;

  return (
    <Modal open={!!code} onClose={onClose} title={code ? `Voucher ${lc(code)}` : 'Voucher'} wide>
      <div className="voucher-detail">
        <div className="vd-head">
          <div className="vd-code" onClick={copyPin} title="Click to copy">{lc(code)}</div>
          <span className="vd-badges">
            {row && <span className={STATUS_BADGE[row.status]}>{STATUS_LABEL[row.status]}</span>}
            {row?.onlineNow
              ? <span className="badge badge--live"><span className="live-dot" />Online</span>
              : sale && (sale.device_count ?? 0) > 0
                ? <span className="badge badge--live"><span className="live-dot" />In use</span>
                : null}
            {sale && <span className={`badge badge--${statusTone(sale.status)}`}>{sale.status || 'Unknown'}</span>}
          </span>
        </div>

        {row && (
          <section className="vd-section">
            <h4 className="vd-section-title">Consumption</h4>
            <div className="un-consume__bar" aria-hidden="true">
              <div
                className={`un-consume__fill un-consume__fill--${row.status}`}
                style={{ width: `${row.pct == null ? 100 : Math.min(row.pct, 100)}%` }}
              />
              {row.pct != null && (
                <>
                  <span className="un-consume__tick" style={{ left: '80%' }} data-label="80" />
                  <span className="un-consume__tick" style={{ left: '95%' }} data-label="95" />
                </>
              )}
            </div>
            <div className="vd-grid">
              <div className="vd-cell">
                <span className="vd-label">Used / Bundle</span>
                <span className="vd-value">
                  {row.totalMB == null || row.totalMB <= 0
                    ? <>{fmtMB(row.usedMB)} / <span className="un-consume__unl">Unlimited</span></>
                    : <>{fmtMB(row.usedMB)} / {fmtMB(row.totalMB)}</>}
                </span>
              </div>
              <div className="vd-cell">
                <span className="vd-label">Consumed</span>
                <span className="vd-value">{row.pct == null ? '∞' : `${Math.round(row.pct * 10) / 10}%`}</span>
              </div>
              <div className="vd-cell">
                <span className="vd-label">Alerts 80 / 95</span>
                <span className="vd-value">{row.alertsSent.t80} / {row.alertsSent.t95}</span>
              </div>
              <div className="vd-cell">
                <span className="vd-label">Last alert</span>
                <span className="vd-value">{fmtWhen(row.lastAlertAt)}</span>
              </div>
              {row.packageName && (
                <div className="vd-cell">
                  <span className="vd-label">Package</span>
                  <span className="vd-value">{row.packageName}</span>
                </div>
              )}
            </div>
          </section>
        )}

        {sale === undefined && <p className="muted">Loading voucher record…</p>}
        {sale === null && (
          <p className="muted">
            Ruijie stock — no local sales record found for this PIN. Consumption stats above are live;
            the downloadable card uses the PIN and package from the roster.
          </p>
        )}

        {sale && (
          <>
            <div className="vd-grid">
              <div className="vd-cell"><span className="vd-label">Price</span><span className="vd-value">{sale.price_amount ? '$' + parseFloat(sale.price_amount).toFixed(2) : '—'}</span></div>
              <div className="vd-cell"><span className="vd-label">Duration</span><span className="vd-value">{fmtDur(sale.duration_min)}</span></div>
              <div className="vd-cell"><span className="vd-label">Bandwidth</span><span className="vd-value">{sale.bandwidth_mbps_up}/{sale.bandwidth_mbps_down} Mbps</span></div>
              <div className="vd-cell"><span className="vd-label">Data</span><span className="vd-value">{sale.is_uncapped ? 'Unlimited' : (sale.data_limit_gb ?? 'Unlimited') + ' GB'}</span></div>
              <div className="vd-cell"><span className="vd-label">Uses</span><span className="vd-value">{sale.used_count}/{sale.max_uses}</span></div>
              <div className="vd-cell"><span className="vd-label">Devices</span><span className="vd-value">{(sale.device_count ?? 0)}/{maxDevices ?? '—'}</span></div>
              <div className="vd-cell"><span className="vd-label">Package</span><span className="vd-value">{sale.package_tier || '—'}</span></div>
              <div className="vd-cell"><span className="vd-label">Created</span><span className="vd-value">{fmtDate(sale.created_at)}</span></div>
              <div className="vd-cell"><span className="vd-label">Activated</span><span className="vd-value">{fmtDate(sale.activated_at)}</span></div>
              <div className="vd-cell"><span className="vd-label">First redeemed</span><span className="vd-value">{fmtDate(sale.first_redeemed_at)}</span></div>
              <div className="vd-cell"><span className="vd-label">Expires</span><span className="vd-value">{fmtDate(sale.expires_at)}</span></div>
            </div>

            {(holderName || sale.phone || redemptionMac || redemptionAt || trafficUsed) && (
              <section className="vd-section">
                <h4 className="vd-section-title">Redemption</h4>
                <div className="vd-grid">
                  <div className="vd-cell"><span className="vd-label">Holder</span><span className="vd-value">{holderName || '—'}</span></div>
                  <div className="vd-cell"><span className="vd-label">Phone</span><span className="vd-value">{sale.phone || '—'}</span></div>
                  <div className="vd-cell"><span className="vd-label">MAC</span><span className="vd-value vd-mono">{redemptionMac || '—'}</span></div>
                  <div className="vd-cell"><span className="vd-label">Redeemed on</span><span className="vd-value">{fmtDate(redemptionAt)}</span></div>
                  <div className="vd-cell"><span className="vd-label">Traffic</span><span className="vd-value">{trafficUsed ? `${trafficUsed}${trafficTotal ? ' / ' + trafficTotal : ''}` : '—'}</span></div>
                </div>
              </section>
            )}

            {(sale.devices?.length ?? 0) > 0 && (
              <section className="vd-section">
                <h4 className="vd-section-title">Device bindings</h4>
                <p className="vd-count">{sale.device_count ?? sale.devices?.length} of {maxDevices ?? '—'} device slot{(maxDevices ?? 2) === 1 ? '' : 's'} in use</p>
                <ul className="vd-macs">
                  {sale.devices!.map((d) => (
                    <li key={d.mac_address}>
                      <span className="vd-mono">{d.mac_address}</span>
                      {d.label ? ` · ${d.label}` : ''}
                      {d.bound_at ? ` · bound ${fmtDate(d.bound_at)}` : ''}
                      {d.last_seen_at ? ` · last seen ${fmtDate(d.last_seen_at)}` : ''}
                      {!d.is_active ? ' · released' : ''}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <section className="vd-section">
          <h4 className="vd-section-title">Share &amp; Notify</h4>
          <p className="vd-count">Copy the PIN, share the details, or download the voucher card as an image.</p>
          <div className="vd-actions">
            <button type="button" className="btn-sm" onClick={copyPin}>Copy PIN</button>
            <button type="button" className="btn-sm" onClick={copyDetails}>Copy Details</button>
            <button type="button" className="btn-action btn-action--download" onClick={() => { void downloadJpeg(); }}>
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 3v12M5 10l5 5 5-5" /><path d="M3 16v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" /></svg>
              Download JPEG
            </button>
          </div>
          {actionMsg && <p className="vd-count" role="status">{actionMsg}</p>}
        </section>
      </div>
    </Modal>
  );
}
