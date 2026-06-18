(function () {
  'use strict';
  
  // --- PACKAGE PURCHASE FLOW ---
  const packageButtons = document.querySelectorAll('.pkg-action');
  const ruijieParams = new URLSearchParams(location.search);
  let selectedPackage = null;

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

  // --- FORM HELPERS ---
  const voucherParams = new URLSearchParams(location.search);

  function redirectToSuccess(json) {
    var redirect = json.redirectUrl || '/success.html';
    var dest = new URL(redirect, location.origin);
    if (json.sessionToken) dest.searchParams.set('token', json.sessionToken);
    if (json.sessionExpiresAt) dest.searchParams.set('expires', json.sessionExpiresAt);
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
  }

  async function submitForm(data, errorEl) {
    clearErrors();
    try {
      var apiUrl = '/api/auth/signup?' + voucherParams.toString();
      var res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      var json = await res.json();
      if (!res.ok) {
        var loadingEl = document.getElementById('bodyLoading');
        if (loadingEl) loadingEl.classList.add('hidden');
        if (json.errors && Array.isArray(json.errors)) {
          json.errors.forEach(function (err) { setFieldError(err.path || err.param, err.msg); });
        } else {
          if (errorEl) { errorEl.textContent = json.error || 'Something went wrong.'; errorEl.classList.remove('hidden'); }
        }
        return;
      }
      redirectToSuccess(json);
    } catch (_err) {
      console.error('Network error:', _err);
      if (errorEl) { errorEl.textContent = 'Network error \u2014 check your connection.'; errorEl.classList.remove('hidden'); }
    }
  }

  // --- QUICK CONNECT FORM (voucher only) ---
  var quickForm = document.getElementById('quick-form');
  var quickBtn = document.getElementById('quick-submit-btn');
  var quickBtnText = document.getElementById('quick-btn-text');
  var quickBtnSpinner = document.getElementById('quick-btn-spinner');

  function setQuickLoading(loading) {
    if (quickBtn) quickBtn.disabled = loading;
    if (quickBtnText) quickBtnText.textContent = loading ? 'Connecting\u2026' : 'Connect';
    if (quickBtnSpinner) quickBtnSpinner.classList.toggle('hidden', !loading);
  }

  if (quickForm) {
    quickForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var code = document.getElementById('accessCode').value.trim();
      if (!code) { setFieldError('accessCode', 'Access code is required.'); return; }

      setQuickLoading(true);
      var loadingEl = document.getElementById('bodyLoading');
      if (loadingEl) loadingEl.classList.remove('hidden');

      await submitForm({
        fullName: 'Guest',
        phone: 'N/A',
        email: '',
        voucherCode: code,
        acceptedTos: true,
      }, document.getElementById('form-error'));

      setQuickLoading(false);
    });
  }

  // --- SIGN UP FORM (account registration, no voucher) ---
  var signupForm = document.getElementById('signup-form');
  var signupBtn = document.getElementById('signup-submit-btn');
  var signupBtnText = document.getElementById('signup-btn-text');
  var signupBtnSpinner = document.getElementById('signup-btn-spinner');

  function setSignupLoading(loading) {
    if (signupBtn) signupBtn.disabled = loading;
    if (signupBtnText) signupBtnText.textContent = loading ? 'Creating Account\u2026' : 'Create Account';
    if (signupBtnSpinner) signupBtnSpinner.classList.toggle('hidden', !loading);
  }

  if (signupForm) {
    signupForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearErrors();

      var fullName = document.getElementById('fullName').value.trim();
      var phone = document.getElementById('phone').value.trim();
      var email = document.getElementById('email').value.trim();
      var password = document.getElementById('suPassword')?.value.trim() || '';
      var passwordConfirm = document.getElementById('suPasswordConfirm')?.value || '';
      var acceptedTos = document.getElementById('acceptedTos').checked;

      var ZW_PHONE_RE = /^(\+263\d{9}|0\d{9})$/;
      var STRONG_PW_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]).{8,}$/;

      var hasError = false;
      if (!fullName) { setFieldError('fullName', 'Full name is required.'); hasError = true; }
      if (!phone) { setFieldError('phone', 'Phone number is required.'); hasError = true; }
      else if (!ZW_PHONE_RE.test(phone)) { setFieldError('phone', 'Valid Zimbabwean number required (+263 7XX XXX XXX).'); hasError = true; }
      if (!email) { setFieldError('email', 'Email is required.'); hasError = true; }
      if (!password) { setFieldError('suPassword', 'Password is required.'); hasError = true; }
      else if (!STRONG_PW_RE.test(password)) { setFieldError('suPassword', 'Must be 8+ chars with uppercase, lowercase, number & special character.'); hasError = true; }
      if (password && password !== passwordConfirm) { setFieldError('suPasswordConfirm', 'Passwords do not match.'); hasError = true; }
      if (!acceptedTos) { setFieldError('acceptedTos', 'You must accept the terms.'); hasError = true; }
      if (hasError) return;

      setSignupLoading(true);
      var loadingEl = document.getElementById('bodyLoading');
      if (loadingEl) loadingEl.classList.remove('hidden');

      try {
        var res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fullName: fullName, phone: phone, email: email, password: password, acceptedTos: acceptedTos }),
        });
        var json = await res.json();
        if (!res.ok) {
          if (json.errors && Array.isArray(json.errors)) {
            json.errors.forEach(function (err) { setFieldError(err.path || err.param, err.msg); });
          } else {
            var errorEl = document.getElementById('signup-form-error');
            if (errorEl) { errorEl.textContent = json.error || 'Something went wrong.'; errorEl.classList.remove('hidden'); }
          }
          return;
        }
        // Show success message with email
        var emailEl = document.getElementById('registered-email');
        if (emailEl) emailEl.textContent = json.email;
        var section = document.getElementById('signup-section');
        if (section) section.classList.add('hidden');
        var successSection = document.getElementById('register-success-section');
        if (successSection) {
          successSection.classList.remove('hidden');
          successSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (_err) {
        console.error('Register error:', _err);
        var errorEl = document.getElementById('signup-form-error');
        if (errorEl) { errorEl.textContent = 'Network error \u2014 check your connection.'; errorEl.classList.remove('hidden'); }
      } finally {
        setSignupLoading(false);
        if (loadingEl) loadingEl.classList.add('hidden');
      }
    });
  }
})();

// --- GLOBAL FORM HELPERS ---
function setFieldError(fieldName, message) {
  var el = document.getElementById('err-' + fieldName);
  if (el) {
    el.textContent = message;
    el.style.display = message ? 'block' : 'none';
    if (message) console.log('[setFieldError] showing error for', fieldName, ':', message);
  } else {
    console.warn('[setFieldError] no element found for', fieldName);
  }
  var input = document.getElementById(fieldName) || document.querySelector('[name="' + fieldName + '"]');
  if (input) { input.classList.toggle('invalid', !!message); }
}

function clearErrors() {
  ['fullName', 'phone', 'email', 'voucherCode', 'acceptedTos', 'suVoucherCode', 'accessCode', 'login-email', 'login-phone', 'login-password', 'suPassword', 'suPasswordConfirm'].forEach(function (f) {
    setFieldError(f, '');
  });
  var fe = document.getElementById('form-error');
  if (fe) { fe.textContent = ''; fe.classList.add('hidden'); }
  var se = document.getElementById('signup-form-error');
  if (se) { se.textContent = ''; se.classList.add('hidden'); }
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- GLOBAL UTILITIES (Runs on all pages) ---
document.addEventListener('DOMContentLoaded', function () {
  
  // 1. Dynamic Year
  const yearEl = document.getElementById('current-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // 2. Success Page — manage-account link now points to login page (JWT-based)
  // (Handled by static HTML, no URL-param link needed)
});

// Hide loading overlay once page is fully loaded
document.addEventListener('DOMContentLoaded', function () {
  var loadingEl = document.getElementById('bodyLoading');
  if (loadingEl) loadingEl.classList.add('hidden');
});

// Connect Now button — scroll to quick form and highlight access code
document.addEventListener('DOMContentLoaded', function () {
  var btn = document.getElementById('connectNowBtn');
  if (btn) {
    btn.addEventListener('click', function () {
      var card = document.querySelector('.hero-card');
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      var input = document.getElementById('accessCode');
      if (input) {
        setTimeout(function () { input.focus(); }, 500);
        input.classList.add('voucher-highlight');
        setTimeout(function () {
          input.classList.remove('voucher-highlight');
        }, 2600);
      }
    });
  }
});

// --- PORTAL LOGIN + INLINE DASHBOARD (account-login.html) ---
function showDashboard() {
  var loginSection = document.getElementById('login-section');
  var dashboard = document.getElementById('ma-dashboard');
  if (loginSection) loginSection.classList.add('hidden');
  if (dashboard) dashboard.classList.remove('hidden');
  loadDashboardData();
}

function showLoginForm() {
  var loginSection = document.getElementById('login-section');
  var dashboard = document.getElementById('ma-dashboard');
  if (loginSection) loginSection.classList.remove('hidden');
  if (dashboard) dashboard.classList.add('hidden');
}

function loadDashboardData() {
  var token = localStorage.getItem('portal_token');
  if (!token) { showLoginForm(); return; }

  var userInfo = document.getElementById('ma-user-info');
  var sessionsList = document.getElementById('ma-sessions-list');
  var noSessions = document.getElementById('ma-no-sessions');
  var loadingEl = document.getElementById('bodyLoading');

  var profileName = document.getElementById('ma-profile-name');
  var profileEmail = document.getElementById('ma-profile-email');
  var profilePhone = document.getElementById('ma-profile-phone');
  var profileStatus = document.getElementById('ma-profile-status');
  var profileJoined = document.getElementById('ma-profile-joined');
  var dataSummary = document.getElementById('ma-data-summary');
  var dataBars = document.getElementById('ma-data-bars');
  var verifySection = document.getElementById('ma-verify-section');

  // Fetch profile
  fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function (r) { return r.json(); })
    .then(function (json) {
      if (json.user) {
        if (userInfo) userInfo.textContent = 'Welcome back, ' + json.user.full_name + '!';
        if (profileName) profileName.textContent = json.user.full_name || '\u2014';
        if (profileEmail) profileEmail.textContent = json.user.email || '\u2014';
        if (profilePhone) profilePhone.textContent = json.user.phone || '\u2014';
        if (profileJoined) profileJoined.textContent = json.user.created_at ? new Date(json.user.created_at).toLocaleDateString() : '\u2014';
        if (profileStatus) {
          if (json.user.email_verified) {
            profileStatus.innerHTML = '<span style="color:#4ade80">\u2713 Verified</span>';
          } else {
            profileStatus.innerHTML = '<span style="color:#f5a623">\u2014 Unverified</span>';
            if (verifySection) verifySection.classList.remove('hidden');
          }
        }
      }
    })
    .catch(function () { /* non-critical */ });

  // Fetch sessions + data usage
  fetch('/api/auth/portal-sessions', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function (r) { return r.json(); })
    .then(function (json) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (noSessions) noSessions.classList.add('hidden');
      if (sessionsList) sessionsList.innerHTML = '';
      if (dataSummary) dataSummary.innerHTML = '';
      if (dataBars) dataBars.innerHTML = '';

      if (!json.sessions || json.sessions.length === 0) {
        if (noSessions) noSessions.classList.remove('hidden');
        if (dataSummary) dataSummary.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0">No active session.</p>';
        return;
      }

      json.sessions.forEach(function (s) {
        var active = new Date(s.session_expires_at) > new Date();
        var timeLeft = active ? Math.max(0, Math.floor((new Date(s.session_expires_at) - Date.now()) / 60000)) : 0;

        // --- Sessions ---
        var dataStr = s.is_uncapped ? 'Unlimited' : (s.data_limit_gb ? s.data_limit_gb + ' GB' : '\u2014');
        var pkgTier = s.package_tier || '\u2014';

        var card = document.createElement('div');
        card.className = 'ma-session-card';
        card.innerHTML =
          '<div class="ma-session-status ' + (active ? 'active' : 'expired') + '">' +
            (active ? '\u25cf ACTIVE' : '\u25cf EXPIRED') +
            ' <span style="font-weight:400;font-size:0.7rem;color:var(--text-muted)">' + escHtml(pkgTier) + '</span>' +
          '</div>' +
          '<div class="ma-session-body">' +
            '<div class="ma-session-row"><span class="lbl">Voucher</span><span class="val">' + escHtml(s.voucher_code || '\u2014') + '</span></div>' +
            '<div class="ma-session-row"><span class="lbl">Speed</span><span class="val">' + (s.bandwidth_mbps_down || '\u2014') + ' Mbps</span></div>' +
            '<div class="ma-session-row"><span class="lbl">Data</span><span class="val">' + dataStr + '</span></div>' +
            (active ? '<div class="ma-session-row"><span class="lbl">Time Left</span><span class="val">' + timeLeft + ' min</span></div>' : '') +
            '<div class="ma-session-row"><span class="lbl">Expires</span><span class="val">' + new Date(s.session_expires_at).toLocaleString() + '</span></div>' +
            (s.mac_address ? '<div class="ma-session-row"><span class="lbl">Device</span><span class="val">' + escHtml(s.mac_address) + '</span></div>' : '') +
          '</div>';
        if (sessionsList) sessionsList.appendChild(card);

        // --- Data Usage (active sessions only) ---
        if (active && dataSummary && dataBars) {
          dataSummary.innerHTML = ''; // remove "no active session" text

          var usedBytes = s.data_used_bytes || 0;
          var quotaBytes = s.data_quota_bytes || (s.data_limit_gb ? s.data_limit_gb * 1024 * 1024 * 1024 : 0);
          var pct = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0;

          function fmtBytes(b) {
            if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
            if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
            if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
            return b + ' B';
          }

          var dCard = document.createElement('div');
          dCard.className = 'ma-data-card';
          dCard.innerHTML =
            '<div class="ma-data-header">' +
              '<span class="ma-data-pkg">' + escHtml(pkgTier) + '</span>' +
              '<span class="ma-data-speed">' + (s.bandwidth_mbps_down || '\u2014') + ' Mbps</span>' +
            '</div>' +
            '<div class="ma-data-bar-track">' +
              '<div class="ma-data-bar-fill" style="width:' + pct + '%"></div>' +
            '</div>' +
            '<div class="ma-data-stats">' +
              '<span>' + fmtBytes(usedBytes) + ' used</span>' +
              '<span>' + (quotaBytes > 0 ? fmtBytes(quotaBytes) : dataStr) + '</span>' +
            '</div>';
          dataBars.appendChild(dCard);
        }
      });
    })
    .catch(function () {
      if (loadingEl) loadingEl.classList.add('hidden');
      showLoginForm();
      localStorage.removeItem('portal_token');
      localStorage.removeItem('portal_user');
    });
}

document.addEventListener('DOMContentLoaded', function () {
  var loginForm = document.getElementById('login-form');
  var loginBtn = document.getElementById('login-submit-btn');
  var loginBtnText = document.getElementById('login-btn-text');
  var loginBtnSpinner = document.getElementById('login-btn-spinner');
  var loginError = document.getElementById('login-error');

  // Check if already signed in on this page
  if (localStorage.getItem('portal_token')) {
    showDashboard();
  }

  // Sign out
  var signoutBtn = document.getElementById('ma-signout-btn');
  if (signoutBtn) {
    signoutBtn.addEventListener('click', function () {
      localStorage.removeItem('portal_token');
      localStorage.removeItem('portal_user');
      showLoginForm();
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearErrors();
      var email = document.getElementById('login-email').value.trim();
      var phone = document.getElementById('login-phone').value.trim();
      var password = document.getElementById('login-password').value;

      var hasLoginError = false;
      if (!email && !phone) { setFieldError('login-email', 'Email or phone is required.'); hasLoginError = true; }
      if (!password) { setFieldError('login-password', 'Password is required.'); hasLoginError = true; }
      if (hasLoginError) { this.querySelector('#login-email')?.focus(); return; }

      if (loginBtn) loginBtn.disabled = true;
      if (loginBtnText) loginBtnText.textContent = 'Signing in\u2026';
      if (loginBtnSpinner) loginBtnSpinner.classList.remove('hidden');
      if (loginError) { loginError.textContent = ''; loginError.classList.add('hidden'); }
      var loadingEl = document.getElementById('bodyLoading');
      if (loadingEl) loadingEl.classList.remove('hidden');

      try {
        var res = await fetch('/api/auth/portal-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, phone, password }),
        });
        var json = await res.json();
        if (!res.ok) {
          if (loginError) { loginError.textContent = json.error || 'Login failed.'; loginError.classList.remove('hidden'); }
          return;
        }
        localStorage.setItem('portal_token', json.token);
        localStorage.setItem('portal_user', JSON.stringify(json.user));
        showDashboard();
      } catch (_err) {
        if (loginError) { loginError.textContent = 'Network error \u2014 check your connection.'; loginError.classList.remove('hidden'); }
      } finally {
        if (loginBtn) loginBtn.disabled = false;
        if (loginBtnText) loginBtnText.textContent = 'Sign In';
        if (loginBtnSpinner) loginBtnSpinner.classList.add('hidden');
        if (loadingEl) loadingEl.classList.add('hidden');
      }
    });
  }

  // Change Password
  var changePwBtn = document.getElementById('ma-change-pw-btn');
  var currentPwInput = document.getElementById('ma-current-pw');
  var newPwInput = document.getElementById('ma-new-pw');
  var confirmPwInput = document.getElementById('ma-confirm-pw');
  var pwMsg = document.getElementById('ma-pw-msg');
  if (changePwBtn && currentPwInput && newPwInput && confirmPwInput) {
    changePwBtn.addEventListener('click', async function () {
      var token = localStorage.getItem('portal_token');
      if (!token) return;
      var currentPw = currentPwInput.value;
      var newPw = newPwInput.value;
      var confirmPw = confirmPwInput.value;
      if (!currentPw) { if (pwMsg) { pwMsg.textContent = 'Enter your current password.'; pwMsg.style.color = '#f87171'; } currentPwInput.focus(); return; }
      if (!newPw || newPw.length < 8) { if (pwMsg) { pwMsg.textContent = 'New password must be at least 8 characters.'; pwMsg.style.color = '#f87171'; } newPwInput.focus(); return; }
      if (newPw !== confirmPw) { if (pwMsg) { pwMsg.textContent = 'Passwords do not match.'; pwMsg.style.color = '#f87171'; } confirmPwInput.focus(); return; }
      changePwBtn.disabled = true;
      changePwBtn.textContent = 'Saving\u2026';
      try {
        var r = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
        });
        var j = await r.json();
        if (pwMsg) {
          if (r.ok) { pwMsg.textContent = 'Password changed successfully!'; pwMsg.style.color = '#4ade80'; currentPwInput.value = ''; newPwInput.value = ''; confirmPwInput.value = ''; }
          else { pwMsg.textContent = j.error || 'Failed to change password.'; pwMsg.style.color = '#f87171'; }
        }
      } catch (_) {
        if (pwMsg) { pwMsg.textContent = 'Network error.'; pwMsg.style.color = '#f87171'; }
      } finally {
        changePwBtn.disabled = false;
        changePwBtn.textContent = 'Change Password';
      }
    });
  }

  // Resend Verification
  var resendBtn = document.getElementById('ma-resend-verify-btn');
  var verifyMsg = document.getElementById('ma-verify-msg');
  if (resendBtn) {
    resendBtn.addEventListener('click', async function () {
      var token = localStorage.getItem('portal_token');
      if (!token) return;
      resendBtn.disabled = true;
      try {
        var r = await fetch('/api/auth/send-verification', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token },
        });
        var j = await r.json();
        if (verifyMsg) { verifyMsg.textContent = j.message || 'Verification email sent.'; verifyMsg.style.color = '#4ade80'; }
      } catch (_) {
        if (verifyMsg) { verifyMsg.textContent = 'Failed to send verification.'; verifyMsg.style.color = '#f87171'; }
      } finally {
        resendBtn.disabled = false;
      }
    });
  }

  // Buy Data / Top-up
  var topupBtn = document.getElementById('ma-topup-btn');
  if (topupBtn) {
    topupBtn.addEventListener('click', function () {
      window.location.href = '/?topup=1';
    });
  }
});

// --- STANDALONE MANAGE ACCOUNT (manage-account.html) ---
document.addEventListener('DOMContentLoaded', function () {
  var standaloneDashboard = document.getElementById('ma-dashboard');
  // only run on standalone manage-account.html (not account-login.html which has the login form)
  if (!standaloneDashboard || document.getElementById('login-section')) return;
  var token = localStorage.getItem('portal_token');
  if (!token) {
    window.location.href = '/login';
    return;
  }
  loadDashboardData();
});

// Sign Up button — toggle signup section visibility with reveal animation
document.addEventListener('DOMContentLoaded', function () {
  var btn = document.getElementById('successSignUpBtn');
  var section = document.getElementById('signup-section');
  if (btn && section) {
    btn.addEventListener('click', function () {
      var isHidden = section.classList.contains('hidden');
      if (isHidden) {
        section.classList.remove('hidden');
        section.classList.add('signup-section--reveal');
        setTimeout(function () {
          section.classList.remove('signup-section--reveal');
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          var input = document.getElementById('fullName');
          if (input) {
            setTimeout(function () { input.focus(); }, 500);
            input.classList.add('voucher-highlight');
            setTimeout(function () {
              input.classList.remove('voucher-highlight');
            }, 2600);
          }
        }, 450);
      } else {
        section.classList.add('hidden');
      }
    });
  }
});