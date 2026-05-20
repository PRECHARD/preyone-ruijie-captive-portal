(function () {
  'use strict';
  
  // --- PACKAGE PURCHASE FLOW ---
  const packageButtons = document.querySelectorAll('.pkg-action');
  const ruijieParams = new URLSearchParams(location.search);
  let selectedPackage = null;

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showPackagePaymentModal(packageData, triggerBtn) {
    // Highlight the clicked button
    if (triggerBtn) {
      triggerBtn.classList.add('pkg-action--selected');
    }
    
    // Create modal overlay
    const modal = document.createElement('div');
    modal.className = 'payment-modal-overlay';
    modal.innerHTML = `
      <div class="payment-modal">
        <button class="modal-close" aria-label="Close">&times;</button>
        <h2>Confirm Purchase: ${packageData['data-display-name']}</h2>
        <div class="modal-details">
          <p><strong>Package:</strong> ${packageData['data-tier']}</p>
          <p><strong>Price:</strong> $${packageData['data-amount']} USD (${packageData['data-period']})</p>
          <p><strong>Data:</strong> ${packageData['data-is-uncapped'] === 'true' ? 'Uncapped' : packageData['data-data-limit'] + 'GB'}</p>
          <p><strong>Speed:</strong> ${packageData['data-bandwidth-down']} Mbps download</p>
          <p><strong>Payment Method:</strong> <span class="ecocash-badge">Eco<span class="ecocash-red">Cash</span></span></p>
        </div>
        <div class="modal-form">
          <div class="field">
            <label for="payment-phone">Phone Number for Payment</label>
            <input id="payment-phone" type="tel" placeholder="+263 771 327 202" value="${escHtml(document.getElementById('phone')?.value || '')}" required />
            <span class="field-error" id="err-payment-phone"></span>
          </div>
          <button id="confirm-payment-btn" class="btn-primary">Proceed to Payment</button>
          <p class="modal-notice">You will be redirected to EcoCash to complete the payment.</p>
        </div>
      </div>
    `;
    
    // Prevent background scroll
    document.body.style.overflow = 'hidden';
    document.body.appendChild(modal);
    
    function closeModal() {
      modal.classList.add('payment-modal-overlay--closing');
      setTimeout(() => {
        modal.remove();
        document.body.style.overflow = '';
      }, 250);
      if (triggerBtn) {
        triggerBtn.classList.remove('pkg-action--selected');
      }
      selectedPackage = null;
    }
    
    // Close modal on X click
    modal.querySelector('.modal-close').addEventListener('click', closeModal);
    
    // Close on outside click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    
    // Handle confirm button
    modal.querySelector('#confirm-payment-btn').addEventListener('click', async () => {
      const phone = modal.querySelector('#payment-phone').value.trim();
      
      if (!phone) {
        modal.querySelector('#err-payment-phone').textContent = 'Phone number is required';
        return;
      }
      
      closeModal();
      await initiatePackagePayment(packageData, phone);
    });
    
    // Focus input
    setTimeout(() => modal.querySelector('#payment-phone')?.focus(), 400);
  }

  async function initiatePackagePayment(packageData, phone) {
    const fullName = document.getElementById('fullName')?.value.trim() || 'Guest User';
    const macAddress = ruijieParams.get('mac') || ruijieParams.get('clientMac');
    const ipAddress = ruijieParams.get('ip');
    const ruijieAuthUrl = ruijieParams.get('url') || ruijieParams.get('originalUrl') || ruijieParams.get('ruijieAuthUrl') || null;

    const paymentData = {
      tier: packageData['data-tier'],
      displayName: packageData['data-display-name'],
      amount: parseFloat(packageData['data-amount']),
      currency: packageData['data-currency'],
      billingPeriod: packageData['data-period'],
      dataLimitGb: packageData['data-is-uncapped'] === 'true' ? null : parseFloat(packageData['data-data-limit']),
      isUncapped: packageData['data-is-uncapped'] === 'true',
      bandwidthUp: parseInt(packageData['data-bandwidth-up']),
      bandwidthDown: parseInt(packageData['data-bandwidth-down']),
      phone,
      fullName,
      macAddress,
      ipAddress,
      ruijieAuthUrl,
    };

    try {
      const response = await fetch('/api/payments/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(paymentData),
      });

      const result = await response.json();

      if (!response.ok) {
        alert('Payment initiation failed: ' + (result.error || 'Unknown error'));
        return;
      }

      // Redirect to Pesepay checkout
      if (result.pesepayPollUrl) {
        window.location.href = result.pesepayPollUrl;
      } else {
        alert('Payment processing initiated. Redirecting...');
      }
    } catch (error) {
      console.error('Payment error:', error);
      alert('Network error during payment: ' + error.message);
    }
  }

  // Add event listeners to all package buttons
  packageButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const packageData = {
        'data-tier': btn.dataset.tier,
        'data-display-name': btn.dataset.displayName,
        'data-amount': btn.dataset.amount,
        'data-currency': btn.dataset.currency,
        'data-period': btn.dataset.period,
        'data-data-limit': btn.dataset.dataLimit,
        'data-bandwidth-up': btn.dataset.bandwidthUp,
        'data-bandwidth-down': btn.dataset.bandwidthDown,
        'data-is-uncapped': btn.dataset.isUncapped,
      };
      selectedPackage = packageData;
      showPackagePaymentModal(packageData, btn);
    });
  });

  // --- LOGIN FORM LOGIC ---
  const form       = document.getElementById('signup-form');
  const submitBtn  = document.getElementById('submit-btn');
  const btnText    = document.getElementById('btn-text');
  const btnSpinner = document.getElementById('btn-spinner');
  const formError  = document.getElementById('form-error');
  const voucherParams = new URLSearchParams(location.search);

  function setFieldError(fieldName, message) {
    const el = document.getElementById('err-' + fieldName);
    if (el) el.textContent = message;
    const input = document.getElementById(fieldName) || document.querySelector('[name="' + fieldName + '"]');
    if (input) input.classList.toggle('invalid', !!message);
  }

  function clearErrors() {
    ['fullName', 'phone', 'voucherCode', 'acceptedTos'].forEach(function (f) {
      setFieldError(f, '');
    });
    if(formError) {
        formError.textContent = '';
        formError.classList.add('hidden');
    }
  }

  function setLoading(loading) {
    if (!submitBtn) return;
    submitBtn.disabled = loading;
    if (btnText) btnText.textContent = loading ? 'Connecting\u2026' : 'Connect to Wi\u2011Fi';
    if (btnSpinner) btnSpinner.classList.toggle('hidden', !loading);
  }

  // Only run form logic if the form exists (prevents errors on success.html)
  if (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearErrors();
      
      var data = {
        fullName:    document.getElementById('fullName').value.trim(),
        phone:       document.getElementById('phone').value.trim(),
        voucherCode: document.getElementById('voucherCode').value.trim(),
        acceptedTos: document.getElementById('acceptedTos').checked,
      };

      var hasError = false;
      if (!data.fullName) { setFieldError('fullName', 'Full name is required.'); hasError = true; }
      if (!data.phone) { setFieldError('phone', 'Phone number is required.'); hasError = true; }
      if (!data.voucherCode) { setFieldError('voucherCode', 'Preyone Voucher code is required.'); hasError = true; }
      if (!data.acceptedTos) { setFieldError('acceptedTos', 'You must accept the terms to continue.'); hasError = true; }
      
      if (hasError) {
        return;
      }

      setLoading(true);

      try {
        var apiUrl = '/api/auth/signup?' + voucherParams.toString();
        var res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        var json = await res.json();

        if (!res.ok) {
          if (json.errors && Array.isArray(json.errors)) {
            json.errors.forEach(function (err) { setFieldError(err.path || err.param, err.msg); });
          } else {
            formError.textContent = json.error || 'Something went wrong. Please try again.';
            formError.classList.remove('hidden');
          }
          return;
        }

        // Success Redirect Logic
        var redirect = json.redirectUrl || '/success.html';
        var dest = new URL(redirect, location.origin);
        
        // Pass the session expiry to the success page
        if (json.sessionExpiresAt) {
            dest.searchParams.set('expires', json.sessionExpiresAt);
        }
        if (json.bandwidthMbpsUp) dest.searchParams.set('bwUp', json.bandwidthMbpsUp);
        if (json.bandwidthMbpsDown) dest.searchParams.set('bwDown', json.bandwidthMbpsDown);
        if (json.dataLimitGb != null) dest.searchParams.set('dataLimit', json.dataLimitGb);
        if (json.isUncapped != null) dest.searchParams.set('uncapped', json.isUncapped);
        if (json.durationMin) dest.searchParams.set('dur', json.durationMin);
        if (json.macAddress) dest.searchParams.set('mac', json.macAddress);
        if (json.ipAddress) dest.searchParams.set('ip', json.ipAddress);
        if (json.voucherCode) dest.searchParams.set('voucher', json.voucherCode);
        if (json.packageTier) dest.searchParams.set('pkg', json.packageTier);
        
        location.href = dest.toString();

      } catch (_err) {
        console.error('Network error:', _err);
        if(formError) {
            formError.textContent = 'Network error \u2014 please check your connection and try again.';
            formError.classList.remove('hidden');
        }
      } finally {
        setLoading(false);
      }
    });
  }
})();

// --- GLOBAL UTILITIES (Runs on all pages) ---
document.addEventListener('DOMContentLoaded', function () {
  
  // 1. Dynamic Year
  const yearEl = document.getElementById('current-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // 2. Success Page — Countdown Timer & Session Details
  const timerEl = document.getElementById('timer-display');
  if (timerEl) {
    const params = new URLSearchParams(location.search);
    const exp = params.get('expires');
    var endTime = exp ? new Date(exp).getTime() : null;

    // Set manage account link with all session params
    var maLink = document.getElementById('manageAccountLink');
    if (maLink) {
      var maParams = new URLSearchParams();
      ['token', 'expires', 'bwUp', 'bwDown', 'dataLimit', 'uncapped', 'dur', 'mac', 'ip', 'voucher', 'pkg'].forEach(function (k) {
        var v = params.get(k);
        if (v) maParams.set(k, v);
      });
      maLink.href = '/manage-account.html?' + maParams.toString();
    }

    function updateTimer() {
      if (!endTime) { timerEl.textContent = 'UNLIMITED'; return; }
      var diff = endTime - Date.now();
      if (diff <= 0) {
        timerEl.textContent = '00:00:00';
        return;
      }
      var h = Math.floor(diff / 3600000);
      var m = Math.floor((diff % 3600000) / 60000);
      var s = Math.floor((diff % 60000) / 1000);
      timerEl.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    updateTimer();
    setInterval(updateTimer, 1000);

    // Fill session details
    var bwUp = params.get('bwUp');
    var bwDown = params.get('bwDown');
    var dataLimit = params.get('dataLimit');
    var uncapped = params.get('uncapped');
    var dur = params.get('dur');

    var speedEl = document.getElementById('detail-speed');
    var dataEl = document.getElementById('detail-data');
    var expiresEl = document.getElementById('detail-expires');

    if (speedEl) {
      speedEl.textContent = bwUp && bwDown ? bwUp + ' Mbps \u2191 / ' + bwDown + ' Mbps \u2193' : '\u2014';
    }
    if (dataEl) {
      if (uncapped === 'true') dataEl.textContent = 'Unlimited';
      else if (dataLimit) dataEl.textContent = dataLimit + ' GB';
      else dataEl.textContent = '\u2014';
    }
    if (expiresEl) {
      if (endTime) {
        expiresEl.textContent = new Date(endTime).toLocaleString([], { hour12: false, dateStyle: 'medium', timeStyle: 'medium' });
      } else {
        expiresEl.textContent = '\u2014';
      }
    }
  }
});