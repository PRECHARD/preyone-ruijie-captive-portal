(function () {
  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return pad(h) + ":" + pad(m) + ":" + pad(s);
  }

  function formatExpiry(minutes) {
    const expires = new Date(Date.now() + minutes * 60 * 1000);
    return expires.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    const params = new URLSearchParams(window.location.search);
    const voucher = params.get("voucher");
    const durationMin = parseInt(params.get("dur"), 10) || 60;
    const bwUp = parseInt(params.get("bwUp"), 10);
    const bwDown = parseInt(params.get("bwDown"), 10);
    const dataLimit = params.get("dataLimit");
    const uncapped = params.get("uncapped") === "true";

    const yearEl = document.getElementById("current-year");
    if (yearEl) {
      yearEl.textContent = new Date().getFullYear();
    }

    const voucherEl = document.getElementById("voucher-display");
    if (voucherEl && voucher) {
      voucherEl.textContent = "Voucher: " + voucher;
    }

    const speedEl = document.getElementById("detail-speed");
    if (speedEl) {
      if (bwUp > 0 || bwDown > 0) {
        speedEl.textContent = bwDown + " / " + bwUp + " Mbps";
      } else {
        speedEl.textContent = "As per package";
      }
    }

    const dataEl = document.getElementById("detail-data");
    if (dataEl) {
      if (uncapped) {
        dataEl.textContent = "Uncapped";
      } else if (dataLimit) {
        dataEl.textContent = dataLimit + " GB";
      } else {
        dataEl.textContent = "As per package";
      }
    }

    const expiresEl = document.getElementById("detail-expires");
    if (expiresEl) {
      expiresEl.textContent = formatExpiry(durationMin);
    }

    const timerEl = document.getElementById("timer-display");
    if (timerEl) {
      let remaining = durationMin * 60;
      timerEl.textContent = formatDuration(remaining);

      const interval = setInterval(function () {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(interval);
          timerEl.textContent = "00:00:00";
          return;
        }
        timerEl.textContent = formatDuration(remaining);
      }, 1000);
    }

    setTimeout(function () {
      window.top.location.href = "https://wifi.preyone.com/data";
    }, 5000);
  });
})();
