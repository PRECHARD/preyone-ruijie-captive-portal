import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import '../styles/transit.css';

const NAVY = '#14253A';
const INK = '#26323F';
const MUTED = '#6E7B8A';
const AMBER = '#CA9A2D';

const up = (v: string) => (v || '').trim().toUpperCase();

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const two = (n: number) => n.toString().padStart(2, '0');
const fmtDate = (d: Date) => `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const fmtTime = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

const paymentMethodLabel = (method: string) => {
  switch ((method || '').trim().toLowerCase()) {
    case 'cash': return 'CASH';
    case 'ecocash': return 'ECOCASH';
    default: {
      const v = (method || '').trim().toUpperCase().replace(/_/g, ' ');
      return v || 'CASH';
    }
  }
};

/** Normalizes a Zim short code to +263... exactly like the app's formatZimPhone. */
const formatZimPhone = (raw: string): string => {
  let v = (raw || '').trim();
  if (!v) return 'N/A';
  v = v.replace(/[^0-9+]/g, '');
  if (v.startsWith('+363')) v = '+263' + v.substring(4);
  if (/^07/.test(v) || /^08/.test(v)) v = '+263' + v.substring(1);
  else if (/^7/.test(v) || /^8/.test(v)) v = '+263' + v;
  return v;
};

const money = (cents: number) => (cents / 100).toFixed(2);

function routeParts(routeName: string): string[] {
  const parts = routeName
    .split(/\s*[-–—:]\s*/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
  if (parts.length > 1) return [parts[0], parts.slice(1).join(' - ')];
  return [routeName];
}

/** Same deterministic payload the app stamps into QR + CODE128. */
export function barcodeDataFor(d: { ticketType: string; receiptNo: string; tripNo: string; total: number }): string {
  const isLuggage = up(d.ticketType) === 'LUGGAGE TICKET';
  return isLuggage ? `LUG|${d.receiptNo}|${d.total}` : `${d.receiptNo}|${d.tripNo}|${d.total}`;
}

export interface PreviewItem { name: string; qty: number; total: number; }

export interface TicketPreviewData {
  companyName: string;
  slogan: string;
  ticketType: string;
  receiptNo: string;
  time: Date;
  busReg: string;
  tripNo: string;
  website: string;
  customerCare: string;
  companyAddress: string;
  routeCode: string;
  routeName: string;
  items: PreviewItem[];
  total: number;
  currency: string;
  driver: string;
  driverPhone: string;
  conductor1: string;
  conductor2: string;
  conductorPhone: string;
  seatNumber: string;
  customerName: string;
  customerMobile: string;
  paymentMethod: string;
  tendered: number;
  note: string;
}

function Barcode({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && value) {
      try {
        JsBarcode(el, value, { format: 'CODE128', height: 30, width: 2, displayValue: false, margin: 0, lineColor: NAVY, background: '#ffffff' });
      } catch {
        // barcode failure must never break the preview
      }
    }
  }, [value]);
  return <svg ref={ref} className="tx-card-preview-code" style={{ width: '100%' }} />;
}

function Qr({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState('');
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(value, { width: 300, margin: 0, errorCorrectionLevel: 'M', color: { dark: NAVY, light: '#ffffff' } })
      .then((url) => { if (active) setDataUrl(url); })
      .catch(() => {});
    return () => { active = false; };
  }, [value]);
  if (!dataUrl) return <div style={{ width: 132, height: 132 }} />;
  return <img src={dataUrl} alt="QR" style={{ width: 132, height: 132 }} />;
}

function IdentityTile({ label, value }: { label: string; value: string }) {
  const showValue = value !== '' && up(value) !== '#';
  return (
    <div className="tx-card-preview-tile">
      <div className="tx-card-preview-tile-label">{label}</div>
      <div className="tx-card-preview-tile-value">{showValue ? value : '—'}</div>
    </div>
  );
}

function FieldRow({ label, value, phone }: { label: string; value: string; phone?: string }) {
  const p = (phone || '').trim();
  return (
    <div className="tx-card-preview-field">
      <div className="tx-card-preview-label">{label}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="tx-card-preview-value">{value}</div>
        {p !== '' && (
          <div style={{ fontSize: 12, fontWeight: 500, color: MUTED, fontVariantNumeric: 'tabular-nums' }}>
            {formatZimPhone(p)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TicketPreviewCard({ data }: { data: TicketPreviewData }) {
  const company = up(data.companyName);
  const hasRoute = data.routeCode !== '' || data.routeName !== '';
  const hasSeat = data.seatNumber.trim() !== '';
  const hasStaff = data.driver !== '' || data.conductor1 !== '' || data.conductor2 !== '';
  const hasItems = data.items.length > 0;

  const address = up(data.companyAddress).trim();
  const care = formatZimPhone(data.customerCare);
  const website = data.website.trim() === '' ? 'www.preyone.com' : data.website.trim();
  const payload = barcodeDataFor(data);

  const tenderedCents = data.tendered > 0 ? data.tendered : data.total;
  const changeCents = tenderedCents - data.total;
  const pax = data.customerName.trim() === '' ? '-' : up(data.customerName.trim());

  const parts = routeParts(up(data.routeName));
  const hasFromTo = parts.length >= 2;

  return (
    <div className="tx-card-preview">
      <div className="tx-card-preview-strip" />
      <div className="tx-card-preview-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ textAlign: 'center', fontSize: 21, fontWeight: 800, color: NAVY, letterSpacing: 0.5, lineHeight: 1.2 }}>{company}</div>
        {((data.customerCare.trim() !== '' && care !== 'N/A') || address !== '') && (
          <div style={{ marginTop: 6 }}>
            {address !== '' && (
              <div style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 500, color: MUTED, lineHeight: 1.35 }}>{address}</div>
            )}
            {care !== 'N/A' && (
              <div style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 600, color: MUTED, lineHeight: 1.3 }}>CUSTOMER CARE&nbsp;&nbsp;{care}</div>
            )}
          </div>
        )}
        {data.slogan.trim() !== '' && (
          <div style={{ textAlign: 'center', fontSize: 12.5, fontWeight: 700, color: AMBER, letterSpacing: 0.6, marginTop: 3 }}>{up(data.slogan)}</div>
        )}
        <div style={{ height: 10 }} />
        <div className="tx-card-preview-pill">{up(data.ticketType)}</div>

        <div style={{ height: 16 }} />
        <div style={{ display: 'flex', gap: 12 }}>
          <IdentityTile label="BUS" value={up(data.busReg)} />
          <IdentityTile label="TKT" value={`#${up(data.receiptNo)}`} />
        </div>
        <div style={{ height: 10 }} />
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: MUTED }}>{fmtDate(data.time)}</span>
          <span style={{ padding: '0 10px', color: '#ece7de', fontSize: 4 }}>•</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(data.time)}</span>
        </div>

        {hasRoute && (
          <>
            <div style={{ height: 14 }} />
            {hasFromTo ? (
              <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 600, color: MUTED, letterSpacing: 2 }}>FROM</div>
                  <div style={{ textAlign: 'center', fontSize: 17, fontWeight: 800, color: NAVY, lineHeight: 1.25, marginTop: 4 }}>{parts[0]}</div>
                </div>
                <div style={{ padding: '0 8px', paddingTop: 22, color: AMBER, fontSize: 16, lineHeight: 1 }}>→</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 600, color: MUTED, letterSpacing: 2 }}>TO</div>
                  <div style={{ textAlign: 'center', fontSize: 17, fontWeight: 800, color: NAVY, lineHeight: 1.25, marginTop: 4 }}>{parts[1]}</div>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', fontSize: 16, fontWeight: 700, color: INK, lineHeight: 1.35 }}>{up(data.routeName)}</div>
            )}
            {data.routeCode.trim() !== '' && (
              <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: AMBER, letterSpacing: 1.5, marginTop: 2 }}>{up(data.routeCode)}</div>
            )}
          </>
        )}

        {hasSeat && (
          <>
            <div style={{ height: 16 }} />
            <div className="tx-card-preview-seat">
              <div style={{ textAlign: 'center', fontSize: 14, fontWeight: 800, color: NAVY }}>SEAT {up(data.seatNumber)}</div>
            </div>
          </>
        )}

        <div style={{ height: 14 }} />
        <hr className="tx-card-preview-hr" />
        <div style={{ height: 14 }} />

        {hasStaff && (
          <>
            {data.driver.trim() !== '' && <FieldRow label="DRIVER" value={up(data.driver)} phone={data.driverPhone} />}
            {data.conductor1.trim() !== '' && <FieldRow label="CONDUCTOR" value={up(data.conductor1)} phone={data.conductorPhone} />}
            {data.conductor2.trim() !== '' && <FieldRow label="CONDUCTOR" value={up(data.conductor2)} />}
            <div style={{ height: 14 }} />
          </>
        )}

        <FieldRow label="PASSENGER" value={pax} />
        {data.customerMobile.trim() !== '' && <FieldRow label="MOBILE" value={formatZimPhone(data.customerMobile)} />}

        <div style={{ height: 14 }} />
        <hr className="tx-card-preview-hr" />
        <div style={{ height: 14 }} />

        {hasItems && (
          <>
            {data.items.map((i, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0' }}>
                <span style={{ fontSize: 13.5, fontWeight: 500, color: INK, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {i.qty > 1 ? `${i.name}  ×${i.qty}` : i.name}
                </span>
                <span className="tx-card-preview-money">{i.qty > 1 ? `${i.qty} pcs   ${money(i.total)}` : money(i.total)}</span>
              </div>
            ))}
            <div style={{ height: 10 }} />
          </>
        )}

        <div className="tx-card-preview-total" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: NAVY, letterSpacing: 0.3 }}>TOTAL FARE</span>
          <span style={{ fontSize: 20, fontWeight: 800, color: NAVY, fontVariantNumeric: 'tabular-nums' }}>
            {money(data.total)}
            <span style={{ fontSize: 13, fontWeight: 800, color: MUTED, marginLeft: 2 }}>{up(data.currency.trim() === '' ? 'USD' : data.currency)}</span>
          </span>
        </div>

        <div style={{ height: 12 }} />
        <div className="tx-card-preview-row">
          <span style={{ fontSize: 12, fontWeight: 600, color: MUTED, letterSpacing: 0.4 }}>PAYMENT METHOD</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: INK }}>{paymentMethodLabel(data.paymentMethod)}</span>
        </div>
        <div className="tx-card-preview-row">
          <span style={{ fontSize: 12, fontWeight: 600, color: MUTED, letterSpacing: 0.4 }}>CASH TENDERED</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: INK, fontVariantNumeric: 'tabular-nums' }}>{money(tenderedCents)}</span>
        </div>
        <div className="tx-card-preview-row">
          <span style={{ fontSize: 12, fontWeight: 600, color: MUTED, letterSpacing: 0.4 }}>CHANGE</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: INK, fontVariantNumeric: 'tabular-nums' }}>{money(changeCents)}</span>
        </div>

        <div style={{ height: 12 }} />
        <div style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 400, color: MUTED, lineHeight: 1.45 }}>{data.note}</div>

        <div style={{ height: 12 }} />
        <hr className="tx-card-preview-hr" />
        <div style={{ height: 16 }} />

        <div style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 400, color: MUTED, letterSpacing: 0.4 }}>Powered by</div>
        <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 800, color: NAVY, letterSpacing: 1.2, marginTop: 2 }}>PREYONE TECHNOLOGIES</div>
        <div style={{ textAlign: 'center', fontSize: 11.5, fontWeight: 500, color: MUTED, marginTop: 2 }}>{website}</div>

        <div style={{ height: 14 }} />
        <div className="tx-card-preview-qr">
          <Qr value={payload} />
        </div>
        <Barcode value={payload} />
      </div>
    </div>
  );
}