import { useEffect, useState } from 'react';
import jsPDF from 'jspdf';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../api/client';
import Modal from '../Modal';
import { drawVoucherCanvas } from '../../utils/voucherCard';
import { shareVoucherJpeg } from '../../utils/voucherShare';
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
  expired: 'EXPIRED',
};

const STATUS_BADGE: Record<ConsumptionStatus, string> = {
  idle: 'badge badge--idle',
  ok: 'badge badge--yes',
  low: 'badge badge--warn',
  critical: 'badge badge--crit',
  exhausted: 'badge badge--no',
  unlimited: 'badge badge--unl',
  disabled: 'badge badge--muted',
  expired: 'badge badge--expired',
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

function fmtDate(d?: string | number | null): string {
  if (d == null || d === '') return '—';
  try { return new Date(d).toLocaleString(); } catch { return String(d); }
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
  const [sharing, setSharing] = useState(false);

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
      `Valid until: ${fmtDate(v?.expires_at ?? row?.expiryTime)}`,
      'Connect: https://wifi.preyone.com',
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

  const printJpeg = async () => {
    if (!code) return;
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 450;
    try {
      await drawVoucherCanvas(c, sale ?? { code }, user?.fullName || 'Preyone UltraNet');
      const doc = new jsPDF('portrait', 'mm', 'a4');
      const imgData = c.toDataURL('image/jpeg', 0.95);
      const pw = 210, ph = 297, m = 10;
      const iw = pw - m * 2, ih = iw * 450 / 800;
      doc.addImage(imgData, 'JPEG', (pw - iw) / 2, (ph - ih) / 2, iw, ih);
      const url = URL.createObjectURL(doc.output('blob'));
      const w = window.open('', '_blank', 'width=900,height=600');
      if (!w) {
        URL.revokeObjectURL(url);
        setActionMsg('Pop-up blocked. Allow pop-ups, then try printing again.');
        return;
      }
      w.document.write(
        '<!doctype html><html><head><title>Preyone Voucher</title>' +
        '<style>html,body{margin:0;padding:0;height:100%;}embed{display:block;width:100%;height:100%;border:0;}</style>' +
        '</head><body><embed src="' + url + '" type="application/pdf" />' +
        '<script>window.addEventListener("load",function(){setTimeout(function(){window.focus();window.print();},500);});</scr' + 'ipt>' +
        '</body></html>'
      );
      w.document.close();
    } catch {
      setActionMsg('Could not render the voucher for printing.');
    }
  };

  /**
   * Share the voucher as a real JPEG attachment.
   *
   * Native share sheets (Android Chrome, iOS Safari, installed PWA) receive the
   * actual file, so WhatsApp opens with the card already attached. Desktop
   * browsers cannot share files, so we fall back to downloading the JPEG,
   * copying it to the clipboard and opening WhatsApp Web with the PIN filled in.
   */
  const shareWhatsApp = async () => {
    if (!code || sharing) return;
    setSharing(true);
    setActionMsg('Preparing the voucher image…');
    try {
      const data = sale
        ? {
            code: sale.code,
            package_tier: sale.package_tier,
            price_amount: sale.price_amount,
            duration_min: sale.duration_min,
            is_uncapped: sale.is_uncapped,
            data_limit_gb: sale.data_limit_gb,
            bandwidth_mbps_up: sale.bandwidth_mbps_up,
            bandwidth_mbps_down: sale.bandwidth_mbps_down,
            holder_name: holderName,
            expires_at: sale.expires_at,
            activated_at: sale.activated_at,
            created_at: sale.created_at,
          }
        : { code };
      const result = await shareVoucherJpeg({
        data,
        code,
        issuedByName: user?.fullName || 'Preyone UltraNet',
        text: `Voucher PIN: ${lc(code)}\n` + waText(),
      });
      setActionMsg(result.message);
    } catch {
      setActionMsg('Could not prepare the voucher image.');
    } finally {
      setSharing(false);
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
              <div className="vd-cell">
                <span className="vd-label">Expires</span>
                <span className="vd-value">{fmtDate(row.expiryTime ?? sale?.expires_at)}</span>
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
          <p className="vd-count">Copy the full voucher details, download the card, print it, or send it on WhatsApp.</p>
          <div className="vd-actions">
            <button type="button" className="btn-action btn-action--copy" onClick={copyDetails}>
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="13" height="15" rx="2" /><polyline points="2 5 2 18 15 18" /></svg>
              Copy All
            </button>
            <button type="button" className="btn-action btn-action--download" onClick={() => { void downloadJpeg(); }}>
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 3v12M5 10l5 5 5-5" /><path d="M3 16v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" /></svg>
              Download JPEG
            </button>
            <button type="button" className="btn-action btn-action--print" onClick={() => { void printJpeg(); }}>
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h12v12H4z" /><path d="M7 10h6M10 7v6" /></svg>
              Print
            </button>
            <button
              type="button"
              className="btn-action btn-action--wa"
              onClick={() => { void shareWhatsApp(); }}
              aria-label="Share voucher on WhatsApp"
              disabled={sharing}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" /></svg>
              <span className="vd-action-label">{sharing ? 'Preparing…' : 'WhatsApp'}</span>
            </button>
          </div>
          {actionMsg && <p className="vd-count" role="status">{actionMsg}</p>}
        </section>
      </div>
    </Modal>
  );
}
