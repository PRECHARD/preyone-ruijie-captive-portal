(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('token');
  var mac = params.get('mac') || '—';
  var ip = params.get('ip') || '—';
  var bwUp = params.get('bwUp');
  var bwDown = params.get('bwDown');
  var dataLimit = params.get('dataLimit');
  var uncapped = params.get('uncapped');
  var dur = params.get('dur');
  var expiresRaw = params.get('expires');
  var voucher = params.get('voucher');
  var pkg = params.get('pkg');

  var endTime = expiresRaw ? new Date(expiresRaw).getTime() : null;
  var dataProgressSection = document.getElementById('maDataProgressSection');
  var usageBar = document.getElementById('maUsageBar');
  var usagePct = document.getElementById('maUsagePct');
  var maDataUsed = document.getElementById('maDataUsed');
  var maDataLimit = document.getElementById('maDataLimit');
  var maTimeLeft = document.getElementById('maTimeLeft');
  var maStatusText = document.getElementById('maStatusText');
  var maStatusBar = document.getElementById('maStatusBar');
  var maTopUpBtn = document.getElementById('maTopUpBtn');
  var maVoucher = document.getElementById('maVoucher');
  var maPackage = document.getElementById('maPackage');
  var pollTimer = null;

  document.getElementById('maYear').textContent = new Date().getFullYear();

  if (voucher) maVoucher.textContent = voucher;
  if (pkg) maPackage.textContent = pkg;

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes > 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes > 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
    return (bytes / 1024).toFixed(0) + ' KB';
  }

  function updateFromUrl() {
    if (bwUp && bwDown) {
      document.getElementById('maSpeed').textContent = bwUp + ' Mbps \u2191 / ' + bwDown + ' Mbps \u2193';
      document.getElementById('maBandwidth').textContent = bwUp + ' Mbps \u2191 / ' + bwDown + ' Mbps \u2193';
    }
    if (uncapped === 'true') {
      maDataLimit.textContent = 'Unlimited';
      usagePct.textContent = 'N/A';
      if (dataProgressSection) dataProgressSection.style.display = 'none';
    } else if (dataLimit) {
      maDataLimit.textContent = dataLimit + ' GB';
    }
    if (endTime) {
      document.getElementById('maExpires').textContent = new Date(endTime).toLocaleString([], { hour12: false, dateStyle: 'medium', timeStyle: 'medium' });
    }
    document.getElementById('maMac').textContent = mac;
    document.getElementById('maIp').textContent = ip;
    if (dur) {
      var mins = parseInt(dur);
      document.getElementById('maStarted').textContent = mins > 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm session' : mins + ' min session';
    }
  }

  function updateTimer() {
    if (!endTime) { maTimeLeft.textContent = '—'; return; }
    var diff = endTime - Date.now();
    if (diff <= 0) {
      maTimeLeft.textContent = 'Expired';
      maTimeLeft.style.color = '#ff6b6b';
      maStatusText.textContent = 'Session Expired';
      maStatusBar.className = 'ma-status ma-status--inactive';
      return;
    }
    var h = Math.floor(diff / 3600000);
    var m = Math.floor((diff % 3600000) / 60000);
    var s = Math.floor((diff % 60000) / 1000);
    maTimeLeft.textContent = (h > 0 ? h + 'h ' : '') + m + 'm ' + s + 's';
  }

  function updateUsageBar(bytesUsed, bytesTotal) {
    if (dataProgressSection) dataProgressSection.style.display = '';
    maDataUsed.textContent = formatBytes(bytesUsed);
    if (bytesTotal && bytesTotal > 0) {
      var pct = Math.min((bytesUsed / bytesTotal) * 100, 100);
      usagePct.textContent = pct.toFixed(1) + '%';
      usageBar.style.width = pct + '%';
      usageBar.className = 'bar-fill' + (pct < 50 ? ' low' : pct < 80 ? ' med' : ' high');
      usageBar.setAttribute('aria-valuenow', pct.toFixed(1));
      usageBar.setAttribute('aria-valuemin', '0');
      usageBar.setAttribute('aria-valuemax', '100');
    } else {
      usagePct.textContent = '—';
      usageBar.style.width = '0%';
    }
  }

  function loadFromApi() {
    if (!token) return;
    var url = '/api/auth/status?token=' + encodeURIComponent(token) + '&_cb=' + Date.now();
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.active) {
          maStatusText.textContent = 'Session Active';
          maStatusBar.className = 'ma-status ma-status--active';
          maStatusBar.setAttribute('role', 'status');
          maStatusBar.setAttribute('aria-live', 'polite');
          if (d.expiresAt) {
            endTime = new Date(d.expiresAt).getTime();
            updateTimer();
            if (pollTimer) clearInterval(pollTimer);
            setInterval(function () { updateTimer(); }, 1000);
          }
          if (d.bytesUsed != null) {
            updateUsageBar(d.bytesUsed, d.bytesTotal);
          }
          if (d.voucherCode && !voucher) {
            maVoucher.textContent = d.voucherCode;
          }
          if (d.packageTier && !pkg) {
            maPackage.textContent = d.packageTier;
          }
          if (d.isUncapped && dataProgressSection) {
            dataProgressSection.style.display = 'none';
          }
        } else {
          maStatusText.textContent = 'Session Expired or Not Found';
          maStatusBar.className = 'ma-status ma-status--inactive';
          maStatusBar.setAttribute('role', 'alert');
          if (maTopUpBtn) maTopUpBtn.classList.remove('ma-btn--disabled');
          maTimeLeft.textContent = 'Expired';
        }
      })
      .catch(function () {
        maStatusText.textContent = 'Could not verify session';
        maStatusBar.className = 'ma-status ma-status--inactive';
        maStatusBar.setAttribute('role', 'alert');
      });
  }

  updateFromUrl();
  loadFromApi();
  setInterval(function () { loadFromApi(); }, 30000);
})();
