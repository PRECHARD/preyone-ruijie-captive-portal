(function () {
  'use strict';

  var voucherCode = null;

  function voucherSerial(code) {
    var d = new Date();
    return (code || 'PREYONE').slice(0, 3).toUpperCase() + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '-' + String(Math.floor(Math.random() * 9000) + 1000);
  }

  function fmtDurShort(min) {
    if (!min) return '—';
    if (min < 60) return min + 'min';
    var h = Math.floor(min / 60);
    var m = min % 60;
    if (m === 0) return h + 'h';
    return h + 'h ' + m + 'min';
  }

  function calcValidUntil(data) {
    if (!data || !data.duration_min) return '—';
    var d = new Date(Date.now() + data.duration_min * 60000);
    return d.toLocaleDateString('en-ZW', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  window.drawVoucherCanvas = async function (c, data, issuedByName) {
    var code = data.code || 'PREYONE-XXXX';
    voucherCode = code;
    var tierText = data.package_tier || 'Custom';
    var priceText = data.price_amount ? '$' + parseFloat(data.price_amount).toFixed(2) : '';
    var durShort = fmtDurShort(data.duration_min);
    var validUntil = calcValidUntil(data);
    var dataVal = data.is_uncapped ? 'UNCAPPED DATA' : (data.data_limit_gb != null ? data.data_limit_gb + ' GB' : 'UNLIMITED');
    var bwVal = data.bandwidth_mbps_up ? data.bandwidth_mbps_up + ' Mbps' : '—';
    var serial = voucherSerial(code);

    var W = 800, H = 450;
    c.width = W;
    c.height = H;
    var ctx = c.getContext('2d');

    var bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, '#050604'); bgGrad.addColorStop(0.46, '#020202'); bgGrad.addColorStop(1, '#050506');
    ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);

    [[50, 40, 300], [750, 50, 280], [30, 400, 260], [770, 380, 300]].forEach(function (g) {
      var rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]);
      rg.addColorStop(0, 'rgba(113,255,47,0.15)'); rg.addColorStop(0.4, 'rgba(113,255,47,0.15)'); rg.addColorStop(1, 'transparent');
      if (g[0] === 750) { rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]); rg.addColorStop(0, 'rgba(19,216,255,0.15)'); rg.addColorStop(0.4, 'rgba(19,216,255,0.15)'); rg.addColorStop(1, 'transparent'); }
      if (g[0] === 30) { rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]); rg.addColorStop(0, 'rgba(54,124,255,0.12)'); rg.addColorStop(0.4, 'rgba(54,124,255,0.12)'); rg.addColorStop(1, 'transparent'); }
      if (g[0] === 770) { rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]); rg.addColorStop(0, 'rgba(139,77,255,0.12)'); rg.addColorStop(0.4, 'rgba(139,77,255,0.12)'); rg.addColorStop(1, 'transparent'); }
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    });

    var logoImg = new Image();
    await new Promise(function (resolve) { logoImg.onload = resolve; logoImg.onerror = resolve; logoImg.src = '/images/preyone-techy-voucher.png'; });
    var iw = logoImg.naturalWidth, ih = logoImg.naturalHeight, maxH = 90;
    if (ih > maxH) { iw *= maxH / ih; ih = maxH; }
    ctx.drawImage(logoImg, -5, 21, iw, ih);

    var logoG = ctx.createLinearGradient(115, 0, 221, 0);
    logoG.addColorStop(0, '#71ff2f'); logoG.addColorStop(0.5, '#13d8ff'); logoG.addColorStop(1, '#367cff');
    ctx.fillStyle = logoG; ctx.font = '700 30px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('PREYONE', 115, 51);

    var hGrad = ctx.createLinearGradient(115, 0, 341, 0);
    hGrad.addColorStop(0, '#71ff2f'); hGrad.addColorStop(0.5, '#13d8ff'); hGrad.addColorStop(1, '#367cff');
    ctx.fillStyle = hGrad; ctx.font = '900 22px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('ULTRANET WIFI', 115, 88);
    ctx.fillStyle = '#ffffff'; ctx.font = '900 36px Montserrat, sans-serif';
    ctx.shadowColor = 'rgba(255,255,255,0.15)'; ctx.shadowBlur = 12;
    ctx.fillText('VOUCHER', 115, 122); ctx.shadowBlur = 0;
    var nGrad = ctx.createLinearGradient(115, 0, 301, 0);
    nGrad.addColorStop(0, '#71ff2f'); nGrad.addColorStop(0.5, '#13d8ff'); nGrad.addColorStop(1, '#8b4dff');
    ctx.fillStyle = nGrad; ctx.beginPath(); ctx.roundRect(115, 132, 200, 3, 2); ctx.fill();

    var cpX = 370, cpY = 28, cpW = 400, codeBoxH = 84;
    var codeBoxY = cpY + 24;
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
    ctx.font = '42px "Bebas Neue", sans-serif';
    ctx.textAlign = 'center';
    var cfSize = 42;
    while (ctx.measureText(code).width > cpW - 24 && cfSize > 22) { cfSize -= 2; ctx.font = cfSize + 'px "Bebas Neue", sans-serif'; }
    ctx.shadowColor = 'rgba(15,23,42,0.1)'; ctx.shadowBlur = 3;
    ctx.fillText(code, cpX + cpW / 2, codeBoxY + codeBoxH / 2 + cfSize / 3 + 2);
    ctx.shadowBlur = 0;

    var colY = 178, colW = 215;
    var cols = [
      { label: 'DATA ALLOWANCE', value: dataVal, x: 38, color: '#13d8ff' },
      { label: 'SPEED PROFILE', value: bwVal, x: 285, color: '#71ff2f' },
      { label: 'VALIDITY', value: durShort, x: 530, color: '#8b4dff' },
    ];
    cols.forEach(function (col) {
      ctx.fillStyle = col.color; ctx.beginPath(); ctx.roundRect(col.x, colY, colW, 2, 1); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(col.label, col.x, colY + 16);
      var ix = col.x + 14, iconCY = colY + 34;
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
      var vt = col.value;
      ctx.fillStyle = '#ffffff'; ctx.font = '700 16px Montserrat, sans-serif'; ctx.textAlign = 'left';
      while (ctx.measureText(vt).width > colW - 44 && vt.length > 2) { vt = vt.slice(0, -1); }
      if (vt !== col.value) vt += '..';
      ctx.fillText(vt, col.x + 26, colY + 40);
    });

    var iy = 248;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(38, iy, 724, 32, 6); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '600 7px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('HOW TO CONNECT', 52, iy + 13);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 9px Montserrat, sans-serif';
    ctx.fillText('1  Connect to "Preyone UltraNet Wi-Fi"', 52, iy + 26);
    ctx.fillText('2  Login screen appears automatically', 290, iy + 26);
    ctx.fillText('3  Enter your unique Voucher PIN', 530, iy + 26);

    var fy = 296;
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Issued By', 38, fy);
    ctx.fillStyle = '#ffffff'; ctx.font = '600 13px Montserrat, sans-serif';
    var iv = issuedByName;
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
    var vu = validUntil;
    while (ctx.measureText(vu).width > 140 && vu.length > 3) { vu = vu.slice(0, -1); }
    if (vu !== validUntil) vu += '..';
    ctx.fillText(vu, 380, fy + 18);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif';
    ctx.fillText('PACKAGE', 560, fy);
    var pkgG = ctx.createLinearGradient(560, 0, 720, 0);
    pkgG.addColorStop(0, '#71ff2f'); pkgG.addColorStop(0.5, '#13d8ff'); pkgG.addColorStop(1, '#367cff');
    ctx.fillStyle = pkgG; ctx.font = '700 30px Montserrat, sans-serif';
    var ptSize = 30;
    while (ctx.measureText(tierText).width > 180 && ptSize > 12) { ptSize -= 1; ctx.font = '700 ' + ptSize + 'px Montserrat, sans-serif'; }
    ctx.fillText(tierText, 560, fy + 28);
    if (priceText) {
      ctx.shadowColor = 'rgba(255,255,255,0.8)'; ctx.shadowBlur = 22;
      ctx.fillStyle = '#ffffff'; ctx.font = '900 34px Montserrat, sans-serif';
      ctx.fillText(priceText, 560, fy + 58);
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = '#71ff2f'; ctx.font = '600 11px Montserrat, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Support Helpdesk: +263 771 327 202', W / 2, 372);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 9px Montserrat, sans-serif';
    ctx.fillText('⚡ Powered by Starlink Business Infrastructure', W / 2, 388);

    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(38, 400); ctx.lineTo(W - 38, 400); ctx.stroke();
    var tGrad = ctx.createLinearGradient(100, 0, 700, 0);
    tGrad.addColorStop(0, '#71ff2f'); tGrad.addColorStop(0.5, '#13d8ff'); tGrad.addColorStop(1, '#8b4dff');
    ctx.fillStyle = tGrad; ctx.font = '900 14px Montserrat, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Thank you for choosing Preyone UltraNet WiFi.', W / 2, 426);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 10px Montserrat, sans-serif';
    ctx.fillText('We appreciate your trust and support.', W / 2, 444);

    var ribW = 22;
    var bwSeq = [3, 6, 2, 7, 4];
    ctx.fillStyle = 'rgba(15,23,42,0.55)';
    ctx.fillRect(0, 0, ribW, H);
    ctx.fillStyle = 'rgba(203,213,225,0.45)';
    var by = 10;
    for (var bi = 0; by < H - 14; bi++) {
      var bw = bwSeq[bi % 5];
      ctx.fillRect(0, by, ribW, bw * 3);
      by += bw * 3 + 3;
    }
    ctx.fillStyle = '#64748b';
    ctx.font = '600 10px Montserrat, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('SN: ' + serial, W - 14, H - 10);
  };

  window.downloadVoucherPNG = async function (data) {
    var c = document.createElement('canvas');
    await window.drawVoucherCanvas(c, data, 'Preyone Enterprises');
    var link = document.createElement('a');
    link.download = 'preyone-voucher-' + data.code + '.png';
    link.href = c.toDataURL('image/png');
    link.click();
  };

  window.renderVoucherToContainer = async function (containerId, data) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var c = document.createElement('canvas');
    c.style.width = '100%';
    c.style.maxWidth = '800px';
    c.style.height = 'auto';
    c.style.borderRadius = '12px';
    await window.drawVoucherCanvas(c, data, 'Preyone Enterprises');
    container.innerHTML = '';
    container.appendChild(c);
  };
})();
