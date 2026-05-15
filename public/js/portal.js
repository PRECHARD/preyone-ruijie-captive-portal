(function () {
  'use strict';
  
  // --- LOGIN FORM LOGIC ---
  const form       = document.getElementById('signup-form');
  const submitBtn  = document.getElementById('submit-btn');
  const btnText    = document.getElementById('btn-text');
  const btnSpinner = document.getElementById('btn-spinner');
  const formError  = document.getElementById('form-error');
  const ruijieParams = new URLSearchParams(location.search);

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
      console.log('Form submitted');
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
        console.log('Validation failed');
        return;
      }

      console.log('Starting API call');
      setLoading(true);

      try {
        var apiUrl = '/api/auth/signup?' + ruijieParams.toString();
        console.log('API URL:', apiUrl);
        var res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        console.log('Response status:', res.status);

        var json = await res.json();

        if (!res.ok) {
          console.log('API error:', json);
          if (json.errors && Array.isArray(json.errors)) {
            json.errors.forEach(function (err) { setFieldError(err.path || err.param, err.msg); });
          } else {
            formError.textContent = json.error || 'Something went wrong. Please try again.';
            formError.classList.remove('hidden');
          }
          return;
        }

        console.log('Success:', json);

        // Success Redirect Logic
        var redirect = json.redirectUrl || '/success.html';
        var dest = new URL(redirect, location.origin);
        
        // Pass the Starlink session expiry to the success page
        if (json.sessionExpiresAt) {
            dest.searchParams.set('expires', json.sessionExpiresAt);
        }
        
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

  // 2. Success Page Logic
  const sessionInfoEl = document.getElementById('session-info');
  if (sessionInfoEl) {
    const params = new URLSearchParams(location.search);
    const exp = params.get('expires');
    
    if (exp) {
      const d = new Date(exp);
      // Format: e.g., "05:30 PM"
      sessionInfoEl.textContent = d.toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit', 
        hour12: true 
      });
    } else {
      // Default fallback if no expiry is provided
      sessionInfoEl.textContent = "Unlimited Session"; 
    }
  }
});