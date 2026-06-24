import { createCanvas, registerFont, loadImage } from 'canvas';
import path from 'path';
import fs from 'fs';

interface VoucherData {
  code: string;
  packageTier: string;
  priceAmount: number;
  currency: string;
  durationMin: number;
  dataLimitGb: number | null;
  isUncapped: boolean;
  bandwidthDown: number;
  bandwidthUp: number;
  issuedBy: string;
  validUntil: string;
  durShort: string;
  dataText: string;
}

function voucherSerial(code: string) {
  const d = new Date();
  return code.slice(0, 3).toUpperCase() + d.getFullYear() +
    ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '-' +
    String(Math.floor(Math.random() * 9000) + 1000);
}

export async function drawVoucherPng(data: VoucherData): Promise<Buffer> {
  // Try to register Montserrat font if available locally
  try {
    const fontPath = path.join(__dirname, '..', '..', 'public', 'fonts', 'Montserrat-VariableFont_wght.ttf');
    if (fs.existsSync(fontPath)) {
      registerFont(fontPath, { family: 'Montserrat' });
    }
  } catch {
    // fall back to sans-serif
  }

  const W = 800, H = 450;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const code = data.code;
  const tierText = data.packageTier;
  const priceText = data.priceAmount ? '$' + data.priceAmount.toFixed(2) : '';
  const durShort = data.durShort;
  const validUntil = data.validUntil;
  const dataVal = data.isUncapped ? 'UNCAPPED DATA' : (data.dataLimitGb != null ? data.dataLimitGb + ' GB' : 'UNLIMITED');
  const bwVal = data.bandwidthDown ? data.bandwidthDown + ' Mbps' : '—';
  const serial = voucherSerial(code);
  const issuedByName = data.issuedBy;

  const font = 'Montserrat, sans-serif';

  // Background
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#050604'); bgGrad.addColorStop(0.46, '#020202'); bgGrad.addColorStop(1, '#050506');
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);

  // Glow spots
  const spots = [
    [50, 40, 300, 'rgba(113,255,47,0.15)'],
    [750, 50, 280, 'rgba(19,216,255,0.15)'],
    [30, 400, 260, 'rgba(54,124,255,0.12)'],
    [770, 380, 300, 'rgba(139,77,255,0.12)'],
  ];
  spots.forEach(([x, y, r, color]) => {
    const rg = ctx.createRadialGradient(x as number, y as number, 5, x as number, y as number, r as number);
    rg.addColorStop(0, color as string);
    rg.addColorStop(0.4, color as string);
    rg.addColorStop(1, 'transparent');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  });

  // Logo
  try {
    const logoPath = path.join(__dirname, '..', '..', 'public', 'images', 'preyone-techy-voucher.png');
    if (fs.existsSync(logoPath)) {
      const logoImg = await loadImage(logoPath);
      let iw = logoImg.naturalWidth || logoImg.width;
      let ih = logoImg.naturalHeight || logoImg.height;
      const maxH = 90;
      if (ih > maxH) { iw *= maxH / ih; ih = maxH; }
      ctx.drawImage(logoImg, -5, 21, iw, ih);
    }
  } catch {
    // continue without logo
  }

  const logoG = ctx.createLinearGradient(115, 0, 221, 0);
  logoG.addColorStop(0, '#71ff2f'); logoG.addColorStop(0.5, '#13d8ff'); logoG.addColorStop(1, '#367cff');
  ctx.fillStyle = logoG; ctx.font = '700 30px ' + font; ctx.textAlign = 'left';
  ctx.fillText('PREYONE', 115, 51);

  const hGrad = ctx.createLinearGradient(115, 0, 341, 0);
  hGrad.addColorStop(0, '#71ff2f'); hGrad.addColorStop(0.5, '#13d8ff'); hGrad.addColorStop(1, '#367cff');
  ctx.fillStyle = hGrad; ctx.font = '900 22px ' + font; ctx.textAlign = 'left';
  ctx.fillText('ULTRANET WIFI', 115, 88);
  ctx.fillStyle = '#ffffff'; ctx.font = '900 36px ' + font;
  ctx.shadowColor = 'rgba(255,255,255,0.15)'; ctx.shadowBlur = 12;
  ctx.fillText('VOUCHER', 115, 122); ctx.shadowBlur = 0;
  const nGrad = ctx.createLinearGradient(115, 0, 301, 0);
  nGrad.addColorStop(0, '#71ff2f'); nGrad.addColorStop(0.5, '#13d8ff'); nGrad.addColorStop(1, '#8b4dff');
  ctx.fillStyle = nGrad;
  roundRect(ctx, 115, 132, 200, 3, 2);
  ctx.fill();

  // Voucher code box
  const cpX = 370, cpY = 28, cpW = 400, codeBoxH = 84;
  const codeBoxY = cpY + 24;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, cpX, codeBoxY, cpW, codeBoxH, 12); ctx.fill();
  ctx.shadowColor = '#71ff2f'; ctx.shadowBlur = 22;
  ctx.strokeStyle = '#71ff2f'; ctx.lineWidth = 3;
  roundRect(ctx, cpX - 2, codeBoxY - 2, cpW + 4, codeBoxH + 4, 14); ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(54,124,255,0.45)'; ctx.lineWidth = 3;
  roundRect(ctx, cpX - 5, codeBoxY - 5, cpW + 10, codeBoxH + 10, 17); ctx.stroke();
  ctx.strokeStyle = 'rgba(139,77,255,0.35)'; ctx.lineWidth = 2;
  roundRect(ctx, cpX - 8, codeBoxY - 8, cpW + 16, codeBoxH + 16, 20); ctx.stroke();
  ctx.fillStyle = '#0f172a'; ctx.font = '600 10px ' + font; ctx.textAlign = 'center';
  ctx.fillText('ACCESS VOUCHER PIN', cpX + cpW / 2, codeBoxY + 14);
  ctx.fillStyle = '#0f172a';
  ctx.font = '42px "Bebas Neue", ' + font;
  ctx.textAlign = 'center';
  let cfSize = 42;
  while (ctx.measureText(code).width > cpW - 24 && cfSize > 22) { cfSize -= 2; ctx.font = cfSize + 'px "Bebas Neue", ' + font; }
  ctx.shadowColor = 'rgba(15,23,42,0.1)'; ctx.shadowBlur = 3;
  ctx.fillText(code, cpX + cpW / 2, codeBoxY + codeBoxH / 2 + cfSize / 3 + 2);
  ctx.shadowBlur = 0;

  // 3 info columns
  const colY = 178, colW = 215;
  const cols = [
    { label: 'DATA ALLOWANCE', value: dataVal, x: 38, color: '#13d8ff' },
    { label: 'SPEED PROFILE', value: bwVal, x: 285, color: '#71ff2f' },
    { label: 'VALIDITY', value: durShort, x: 530, color: '#8b4dff' },
  ];
  cols.forEach(col => {
    ctx.fillStyle = col.color; roundRect(ctx, col.x, colY, colW, 2, 1); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px ' + font; ctx.textAlign = 'left';
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
    ctx.fillStyle = '#ffffff'; ctx.font = '700 16px ' + font; ctx.textAlign = 'left';
    while (ctx.measureText(vt).width > colW - 44 && vt.length > 2) { vt = vt.slice(0, -1); }
    if (vt !== col.value) vt += '..';
    ctx.fillText(vt, col.x + 26, colY + 40);
  });

  // How to connect
  const iy = 248;
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  roundRect(ctx, 38, iy, 724, 32, 6); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '600 7px ' + font; ctx.textAlign = 'left';
  ctx.fillText('HOW TO CONNECT', 52, iy + 13);
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 9px ' + font;
  ctx.fillText('1  Connect to "Preyone UltraNet Wi-Fi"', 52, iy + 26);
  ctx.fillText('2  Login screen appears automatically', 290, iy + 26);
  ctx.fillText('3  Enter your unique Voucher PIN', 530, iy + 26);

  // Details
  const fy = 296;
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px ' + font; ctx.textAlign = 'left';
  ctx.fillText('Issued By', 38, fy);
  ctx.fillStyle = '#ffffff'; ctx.font = '600 13px ' + font;
  let iv = issuedByName;
  while (ctx.measureText(iv).width > 140 && iv.length > 2) { iv = iv.slice(0, -1); }
  if (iv !== issuedByName) iv += '..';
  ctx.fillText(iv, 38, fy + 18);
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px ' + font;
  ctx.fillText('Location', 220, fy);
  ctx.fillStyle = '#ffffff'; ctx.font = '600 13px ' + font;
  ctx.fillText('Chitungwiza', 220, fy + 18);
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px ' + font;
  ctx.fillText('Valid Until', 380, fy);
  ctx.fillStyle = '#ffffff'; ctx.font = '600 13px ' + font;
  let vu = validUntil;
  while (ctx.measureText(vu).width > 140 && vu.length > 3) { vu = vu.slice(0, -1); }
  if (vu !== validUntil) vu += '..';
  ctx.fillText(vu, 380, fy + 18);
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px ' + font;
  ctx.fillText('PACKAGE', 560, fy);
  const pkgG = ctx.createLinearGradient(560, 0, 720, 0);
  pkgG.addColorStop(0, '#71ff2f'); pkgG.addColorStop(0.5, '#13d8ff'); pkgG.addColorStop(1, '#367cff');
  ctx.fillStyle = pkgG; ctx.font = '700 30px ' + font;
  let ptSize = 30;
  while (ctx.measureText(tierText).width > 180 && ptSize > 12) { ptSize -= 1; ctx.font = '700 ' + ptSize + 'px ' + font; }
  ctx.fillText(tierText, 560, fy + 28);
  if (priceText) {
    ctx.shadowColor = 'rgba(255,255,255,0.8)'; ctx.shadowBlur = 22;
    ctx.fillStyle = '#ffffff'; ctx.font = '900 34px ' + font;
    ctx.fillText(priceText, 560, fy + 58);
    ctx.shadowBlur = 0;
  }

  ctx.fillStyle = '#71ff2f'; ctx.font = '600 11px ' + font; ctx.textAlign = 'center';
  ctx.fillText('Support Helpdesk: +263 771 327 202', W / 2, 372);
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 9px ' + font;
  ctx.fillText('⚡ Powered by Starlink Business Infrastructure', W / 2, 388);

  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(38, 400); ctx.lineTo(W - 38, 400); ctx.stroke();
  const tGrad = ctx.createLinearGradient(100, 0, 700, 0);
  tGrad.addColorStop(0, '#71ff2f'); tGrad.addColorStop(0.5, '#13d8ff'); tGrad.addColorStop(1, '#8b4dff');
  ctx.fillStyle = tGrad; ctx.font = '900 14px ' + font; ctx.textAlign = 'center';
  ctx.fillText('Thank you for choosing Preyone UltraNet WiFi.', W / 2, 426);
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 10px ' + font;
  ctx.fillText('We appreciate your trust and support.', W / 2, 444);

  // Ribbon
  const ribW = 22;
  const bwSeq = [3, 6, 2, 7, 4];
  ctx.fillStyle = 'rgba(15,23,42,0.55)';
  ctx.fillRect(0, 0, ribW, H);
  ctx.fillStyle = 'rgba(203,213,225,0.45)';
  let by = 10;
  for (let bi = 0; by < H - 14; bi++) {
    const bw = bwSeq[bi % 5];
    ctx.fillRect(0, by, ribW, bw * 3);
    by += bw * 3 + 3;
  }
  ctx.fillStyle = '#64748b';
  ctx.font = '600 10px ' + font;
  ctx.textAlign = 'right';
  ctx.fillText('SN: ' + serial, W - 14, H - 10);

  return canvas.toBuffer('image/png');
}

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
