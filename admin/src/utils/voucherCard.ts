// Voucher card painter shared by the Vouchers page (create/bulk/detail flows)
// and the Consumption tab's detail modal. Extracted verbatim from Vouchers.tsx
// so both surfaces render byte-identical JPEG cards.

/** The subset of a voucher row the canvas reads. All optional so partial
 *  objects (create-flow previews, consumption-only rows) stay compatible. */
export interface VoucherCardData {
  code?: string | null;
  package_tier?: string | null;
  price_amount?: string | number | null;
  duration_min?: number | null;
  is_uncapped?: boolean | null;
  data_limit_gb?: number | null;
  bandwidth_mbps_up?: number | null;
  bandwidth_mbps_down?: number | null;
  holder_name?: string | null;
  expires_at?: string | null;
  activated_at?: string | null;
  created_at?: string | null;
}

export function voucherSerial(code: string) {
  const d = new Date();
  return (code || 'PREYONE').slice(0, 3).toUpperCase() + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '-' + String(Math.floor(Math.random() * 9000) + 1000);
}

export function fmtDurShort(m: number): string {
  if (!m) return '—';
  if (m >= 43200) { const vm = Math.round(m / 43200); return vm + ' Month' + (vm > 1 ? 's' : ''); }
  if (m >= 1440) { const vd = Math.round(m / 1440); return vd + ' Day' + (vd > 1 ? 's' : ''); }
  if (m >= 60) { const vh = Math.round(m / 60); return vh + ' Hour' + (vh > 1 ? 's' : ''); }
  return m + ' Min';
}

export function calcValidUntil(data: VoucherCardData): string {
  if (data.expires_at) return new Date(data.expires_at).toISOString().split('T')[0];
  const d = new Date();
  d.setMinutes(d.getMinutes() + (data.duration_min || 60));
  return d.toISOString().split('T')[0];
}

export const drawVoucherCanvas = async (c: HTMLCanvasElement, data: VoucherCardData, issuedByName: string) => {
  const code = (data.code || 'PREYONE-XXXX').toLowerCase();
  const tierText = data.package_tier || 'Custom';
  const priceText = data.price_amount ? '$' + parseFloat(String(data.price_amount)).toFixed(2) : '';
  const durShort = fmtDurShort(data.duration_min ?? 0);
  const validUntil = calcValidUntil(data);
  const dataVal = data.is_uncapped ? 'UNCAPPED DATA' : (data.data_limit_gb != null ? data.data_limit_gb + ' GB' : 'UNLIMITED');
  const bwVal = data.bandwidth_mbps_up ? data.bandwidth_mbps_up + ' Mbps' : '—';
  const serial = voucherSerial(code);

  const W = 800, H = 450;
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;

  // ── Cyberpunk border glow ──
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#050604'); bgGrad.addColorStop(0.46, '#020202'); bgGrad.addColorStop(1, '#050506');
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);

  // ── Cyberpunk radial glow spots ──
  [[50, 40, 300], [750, 50, 280], [30, 400, 260], [770, 380, 300]].forEach(function (g) {
    let rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]);
    rg.addColorStop(0, 'rgba(113,255,47,0.15)'); rg.addColorStop(0.4, 'rgba(113,255,47,0.15)'); rg.addColorStop(1, 'transparent');
    if (g[0] === 750) { rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]); rg.addColorStop(0, 'rgba(19,216,255,0.15)'); rg.addColorStop(0.4, 'rgba(19,216,255,0.15)'); rg.addColorStop(1, 'transparent'); }
    if (g[0] === 30) { rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]); rg.addColorStop(0, 'rgba(54,124,255,0.12)'); rg.addColorStop(0.4, 'rgba(54,124,255,0.12)'); rg.addColorStop(1, 'transparent'); }
    if (g[0] === 770) { rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]); rg.addColorStop(0, 'rgba(139,77,255,0.12)'); rg.addColorStop(0.4, 'rgba(139,77,255,0.12)'); rg.addColorStop(1, 'transparent'); }
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  });

  // ── Voucher logo image (under text, left-aligned) ──
  const logoImg = new Image();
  await new Promise(resolve => { logoImg.onload = resolve; logoImg.onerror = resolve; logoImg.src = '/images/preyone-techy-voucher.png'; });
  let iw = logoImg.naturalWidth, ih = logoImg.naturalHeight, maxH = 90;
  if (ih > maxH) { iw *= maxH / ih; ih = maxH; }
  ctx.drawImage(logoImg, -5, 21, iw, ih);

  // ── LEFT: Logo ──
  const logoG = ctx.createLinearGradient(115, 0, 221, 0);
  logoG.addColorStop(0, '#71ff2f'); logoG.addColorStop(0.5, '#13d8ff'); logoG.addColorStop(1, '#367cff');
  ctx.fillStyle = logoG; ctx.font = '700 30px Montserrat, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('PREYONE', 115, 51);

  // ── ULTRANET WIFI / VOUCHER ──
  const hGrad = ctx.createLinearGradient(115, 0, 341, 0);
  hGrad.addColorStop(0, '#71ff2f'); hGrad.addColorStop(0.5, '#13d8ff'); hGrad.addColorStop(1, '#367cff');
  ctx.fillStyle = hGrad; ctx.font = '900 22px Montserrat, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('ULTRANET WIFI', 115, 88);
  ctx.fillStyle = '#ffffff'; ctx.font = '900 36px Montserrat, sans-serif';
  ctx.shadowColor = 'rgba(255,255,255,0.15)'; ctx.shadowBlur = 12;
  ctx.fillText('VOUCHER', 115, 122); ctx.shadowBlur = 0;
  const nGrad = ctx.createLinearGradient(115, 0, 301, 0);
  nGrad.addColorStop(0, '#71ff2f'); nGrad.addColorStop(0.5, '#13d8ff'); nGrad.addColorStop(1, '#8b4dff');
  ctx.fillStyle = nGrad; ctx.beginPath(); ctx.roundRect(115, 132, 200, 3, 2); ctx.fill();

  // ── Holder (customer) name — printed between the header rule and the
  // spec columns when the sale captured one. Auto-skips otherwise, so
  // legacy vouchers render byte-identical to before.
  const holderName = String(data.holder_name || '').trim();
  if (holderName) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('ISSUED FOR', 115, 152);
    ctx.fillStyle = '#ffffff'; ctx.font = '700 14px Montserrat, sans-serif';
    let hn = holderName;
    while (ctx.measureText(hn).width > 232 && hn.length > 2) { hn = hn.slice(0, -1); }
    if (hn !== holderName) hn += '..';
    ctx.fillText(hn, 115, 170);
  }

  // ── RIGHT: Voucher Code Box ──
  const cpX = 370, cpY = 28, cpW = 400, codeBoxH = 84;
  const codeBoxY = cpY + 24;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(cpX, codeBoxY, cpW, codeBoxH, 12); ctx.fill();
  ctx.shadowColor = '#71ff2f'; ctx.shadowBlur = 22;
  ctx.strokeStyle = '#71ff2f'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(cpX - 2, codeBoxY - 2, cpW + 4, codeBoxH + 4, 14); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(54,124,255,0.45)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(cpX - 5, codeBoxY - 5, cpW + 10, codeBoxH + 10, 17); ctx.stroke();
  ctx.strokeStyle = 'rgba(139,77,255,0.35)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(cpX - 8, codeBoxY - 8, cpW + 16, codeBoxH + 16, 20); ctx.stroke();
  ctx.fillStyle = '#0f172a'; ctx.font = '600 10px Montserrat, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('ACCESS VOUCHER PIN', cpX + cpW / 2, codeBoxY + 14);
  ctx.fillStyle = '#0f172a';
  ctx.font = '800 42px Montserrat, sans-serif';
  ctx.textAlign = 'center';
  let cfSize = 42;
  while (ctx.measureText(code).width > cpW - 24 && cfSize > 22) { cfSize -= 2; ctx.font = cfSize + 'px Montserrat, sans-serif'; }
  ctx.shadowColor = 'rgba(15,23,42,0.1)'; ctx.shadowBlur = 3;
  ctx.fillText(code, cpX + cpW / 2, codeBoxY + codeBoxH / 2 + cfSize / 3 + 2);
  ctx.shadowBlur = 0;

  // ── Package Allocation with canvas-drawn icons ──
  const colY = 178, colW = 215;
  const cols = [
    { label: 'DATA ALLOWANCE', value: dataVal, x: 38, color: '#13d8ff' },
    { label: 'SPEED PROFILE', value: bwVal, x: 285, color: '#71ff2f' },
    { label: 'VALIDITY', value: durShort, x: 530, color: '#8b4dff' },
  ];
  cols.forEach(function (col) {
    ctx.fillStyle = col.color; ctx.beginPath(); ctx.roundRect(col.x, colY, colW, 2, 1); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(col.label, col.x, colY + 16);
    const ix = col.x + 14, iconCY = colY + 34;
    ctx.strokeStyle = col.color; ctx.lineWidth = 1.3;
    if (col.label === 'DATA ALLOWANCE') {
      ctx.beginPath(); ctx.ellipse(ix, iconCY - 4, 8, 3.5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.rect(ix - 8, iconCY - 4, 16, 8); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(ix, iconCY + 4, 8, 3.5, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (col.label === 'SPEED PROFILE') {
      ctx.beginPath(); ctx.arc(ix, iconCY, 10, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ix, iconCY); ctx.lineTo(ix + 7, iconCY - 5); ctx.stroke();
      ctx.beginPath(); ctx.arc(ix, iconCY, 1.5, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeRect(ix - 8, iconCY - 7, 16, 14);
      ctx.fillRect(ix - 8, iconCY - 7, 16, 5);
      ctx.beginPath();
      ctx.moveTo(ix - 4, iconCY - 2); ctx.lineTo(ix + 4, iconCY - 2);
      ctx.moveTo(ix - 4, iconCY + 1); ctx.lineTo(ix + 4, iconCY + 1);
      ctx.moveTo(ix - 3, iconCY - 7); ctx.lineTo(ix - 3, iconCY + 7);
      ctx.moveTo(ix + 3, iconCY - 7); ctx.lineTo(ix + 3, iconCY + 7);
      ctx.stroke();
    }
    let vt = col.value;
    ctx.fillStyle = '#ffffff'; ctx.font = '700 16px Montserrat, sans-serif'; ctx.textAlign = 'left';
    while (ctx.measureText(vt).width > colW - 44 && vt.length > 2) { vt = vt.slice(0, -1); }
    if (vt !== col.value) vt += '..';
    ctx.fillText(vt, col.x + 26, colY + 40);
  });

  // ── Instructions strip ──
  const iy = 248;
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(38, iy, 724, 32, 6); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '600 7px Montserrat, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('HOW TO CONNECT', 52, iy + 13);
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 9px Montserrat, sans-serif';
  ctx.fillText('1  Connect to "Preyone UltraNet Wi-Fi"', 52, iy + 26);
  ctx.fillText('2  Login screen appears automatically', 290, iy + 26);
  ctx.fillText('3  Enter your unique Voucher PIN', 530, iy + 26);

  // ── Info row ──
  const fy = 296;
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('Issued By', 38, fy);
  ctx.fillStyle = '#ffffff'; ctx.font = '600 13px Montserrat, sans-serif';
  let iv = issuedByName;
  while (ctx.measureText(iv).width > 140 && iv.length > 2) { iv = iv.slice(0, -1); }
  if (iv !== issuedByName) iv += '..';
  ctx.fillText(iv, 38, fy + 18);
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif';
  ctx.fillText('Location', 220, fy);
  ctx.fillStyle = '#ffffff'; ctx.font = '600 13px Montserrat, sans-serif';
  ctx.fillText('Chitungwiza', 220, fy + 18);
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif';
  ctx.fillText('Valid Until', 380, fy);
  ctx.fillStyle = '#ffffff'; ctx.font = '600 13px Montserrat, sans-serif';
  let vu = validUntil;
  while (ctx.measureText(vu).width > 140 && vu.length > 3) { vu = vu.slice(0, -1); }
  if (vu !== validUntil) vu += '..';
  ctx.fillText(vu, 380, fy + 18);
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif';
  ctx.fillText('PACKAGE', 560, fy);
  const pkgG = ctx.createLinearGradient(560, 0, 720, 0);
  pkgG.addColorStop(0, '#71ff2f'); pkgG.addColorStop(0.5, '#13d8ff'); pkgG.addColorStop(1, '#367cff');
  ctx.fillStyle = pkgG; ctx.font = '700 30px Montserrat, sans-serif';
  let ptSize = 30;
  while (ctx.measureText(tierText).width > 180 && ptSize > 12) { ptSize -= 1; ctx.font = '700 ' + ptSize + 'px Montserrat, sans-serif'; }
  ctx.fillText(tierText, 560, fy + 28);
  if (priceText) {
    ctx.shadowColor = 'rgba(255,255,255,0.8)'; ctx.shadowBlur = 22;
    ctx.fillStyle = '#ffffff'; ctx.font = '900 34px Montserrat, sans-serif';
    ctx.fillText(priceText, 560, fy + 58);
    ctx.shadowBlur = 0;
  }

  // ── Support + Starlink ──
  ctx.fillStyle = '#71ff2f'; ctx.font = '600 11px Montserrat, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('Support Helpdesk: +263 771 327 202', W / 2, 372);
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 9px Montserrat, sans-serif';
  ctx.fillText('⚡ Powered by Starlink Business Infrastructure', W / 2, 388);

  // ── Thank You ──
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(38, 400); ctx.lineTo(W - 38, 400); ctx.stroke();
  const tGrad = ctx.createLinearGradient(100, 0, 700, 0);
  tGrad.addColorStop(0, '#71ff2f'); tGrad.addColorStop(0.5, '#13d8ff'); tGrad.addColorStop(1, '#8b4dff');
  ctx.fillStyle = tGrad; ctx.font = '900 14px Montserrat, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('Thank you for choosing Preyone UltraNet WiFi.', W / 2, 426);
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 10px Montserrat, sans-serif';
  ctx.fillText('We appreciate your trust and support.', W / 2, 444);

  // ── Left-edge barcode strip ──
  const ribW = 22;
  const bwSeq = [3, 6, 2, 7, 4];
  ctx.fillStyle = 'rgba(15,23,42,0.55)';
  ctx.fillRect(0, 0, ribW, H);
  ctx.fillStyle = 'rgba(203,213,225,0.45)';
  let by = 10;
  for (let bi = 0; by < H - 14; bi++) {
    let bw = bwSeq[bi % 5];
    ctx.fillRect(0, by, ribW, bw * 3);
    by += bw * 3 + 3;
  }
  ctx.fillStyle = '#64748b';
  ctx.font = '600 10px Montserrat, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('SN: ' + serial, W - 14, H - 10);
};
