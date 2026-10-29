(function () {
  'use strict';
  
  // --- PACKAGE PURCHASE FLOW (Pesepay / EcoCash) ---
  const packageButtons = document.querySelectorAll('.pkg-action');
  const ruijieParams = new URLSearchParams(location.search);

  // The customer normally reaches the portal from the Ruijie-hosted page. Keep
  // that exact page URL (including its per-captive-session sessionId) so the
  // success page can send the customer back to the same Ruijie portal instead
  // of a stale hard-coded session.
  const RUIJIE_PORTAL_PATH_PREFIX = '/download/static/advertisement/maccauth/';
  const RUIJIE_PORTAL_STORAGE_KEY = 'preyone_ruijie_portal';
  const RUIJIE_PORTAL_CONTEXT_TTL_MS = 30 * 60 * 1000;
  const ruijiePortalContext = (function () {
    function isRuijiePortal(url) {
      return /(^|\.)ruijienetworks\.com$/i.test(url.hostname) &&
        url.pathname.indexOf(RUIJIE_PORTAL_PATH_PREFIX) === 0;
    }
    function timestampOf(url) {
      var direct = url.searchParams.get('timestamp');
      if (direct) return direct;
      var match = url.search.match(/[?&]timestamp=?(\d+)/i);
      return match ? match[1] : '';
    }
    function remember(context) {
      try {
        localStorage.setItem(RUIJIE_PORTAL_STORAGE_KEY, JSON.stringify({
          portalUrl: context.portalUrl,
          sessionId: context.sessionId,
          timestamp: context.timestamp,
          savedAt: Date.now(),
        }));
      } catch (_err) {
        /* storage can be unavailable in private mode */
      }
    }
    function restore() {
      try {
        var saved = JSON.parse(localStorage.getItem(RUIJIE_PORTAL_STORAGE_KEY) || 'null');
        if (!saved || !saved.portalUrl) return null;
        if (Date.now() - Number(saved.savedAt) > RUIJIE_PORTAL_CONTEXT_TTL_MS) return null;
        var url = new URL(saved.portalUrl, location.href);
        if (!isRuijiePortal(url)) return null;
        return {
          portalUrl: url.href,
          sessionId: saved.sessionId || '',
          timestamp: saved.timestamp || '',
        };
      } catch (_err) {
        return null;
      }
    }
    var candidates = [
      document.referrer,
      location.href,
      ruijieParams.get('login_url'),
      ruijieParams.get('loginUrl'),
    ];
    for (var i = 0; i < candidates.length; i++) {
      var raw = candidates[i];
      if (!raw) continue;
      try {
        var url = new URL(raw, location.href);
        if (!isRuijiePortal(url)) continue;
        var sessionId = url.searchParams.get('sessionId') ||
          url.searchParams.get('session_id') ||
          url.searchParams.get('sessionid') || '';
        var timestamp = timestampOf(url);
        if (!sessionId && !timestamp) continue;
        var context = { portalUrl: url.href, sessionId: sessionId, timestamp: timestamp };
        remember(context);
        return context;
      } catch (_err) {
        /* not a usable URL */
      }
    }
    return restore();
  })();

  const inboundRuijieSessionId =
    ruijieParams.get('sessionId') ||
    ruijieParams.get('session_id') ||
    ruijieParams.get('sessionid') || '';
  const inboundRuijieTimestamp = (function () {
    var direct = ruijieParams.get('timestamp');
    if (direct) return direct;
    var match = location.search.match(/[?&]timestamp=?(\d+)/i);
    return match ? match[1] : '';
  })();

  let selectedPackage = null;
  let paymentPollTimer = null;
  // Set once /status reports supportRequired, so the give-up message stops
  // claiming "we have not received your payment" when the money is confirmed.
  let paymentSupportPending = false;
  // Remembered so the give-up screen can still quote the reference.
  let lastPaymentReference = null;
  // Set when the customer is sent back from Pesepay's hosted page, so the modal
  // can resume polling instead of asking for a phone number again.
  let pendingReturn = null;

  function showPackagePaymentModal(packageData, triggerBtn) {
    // Highlight the clicked button
    if (triggerBtn) {
      triggerBtn.classList.add('pkg-action--selected');
    }

    // Create modal overlay
    const modal = document.createElement('div');
    modal.className = 'payment-modal-overlay';
    var price = parseFloat(packageData['data-amount']);
    var needsTierCapture = price >= 4.99;

    modal.innerHTML = `
      <div class="payment-modal">
        <button class="modal-close" aria-label="Close">&times;</button>
        <h2>Make Preyone Payment</h2>
        <div class="modal-details">
          <p><strong>Package:</strong> ${packageData['data-tier']}</p>
          <p><strong>Price:</strong> $${packageData['data-amount']} USD (${packageData['data-period']})</p>
          <p><strong>Data:</strong> ${packageData['data-is-uncapped'] === 'true' ? 'Unlimited' : packageData['data-data-limit'] + 'GB'}</p>
          <p><strong>Speed:</strong> ${packageData['data-bandwidth-down']} Mbps download</p>
        </div>
        <form class="modal-form" id="pesepay-form" novalidate>
          <fieldset class="pay-methods" id="pay_methods">
            <legend class="pay-methods__legend">Payment Method</legend>

            <label class="pay-method" data-rail="ecocash" aria-label="EcoCash">
              <input class="pay-method__input" type="radio" name="pay_method" value="ecocash" data-currency="USD" checked />
              <span class="pay-method__logo" aria-hidden="true">
                <img src="/img/pay/ecocash.png?v=41" alt="" onerror="this.remove()" />
              </span>
            </label>

            <label class="pay-method" data-rail="innbucks" aria-label="InnBucks">
              <input class="pay-method__input" type="radio" name="pay_method" value="innbucks" data-currency="USD" />
              <span class="pay-method__logo" aria-hidden="true">
                <img src="/img/pay/innbucks.png?v=41" alt="" class="innbucks-logo" onerror="this.remove()" />
              </span>
            </label>

            <label class="pay-method" data-rail="omari" aria-label="O'mari">
              <input class="pay-method__input" type="radio" name="pay_method" value="omari" data-currency="USD" />
              <span class="pay-method__logo" aria-hidden="true">
                <img src="/img/pay/omari.webp?v=41" alt="" onerror="this.remove()" />
              </span>
            </label>
          </fieldset>
          ${needsTierCapture ? `
          <div class="field" id="field-fullName">
            <label for="pesepay-fullName">Full Name / Company Name</label>
            <input type="text" id="pesepay-fullName" placeholder="Full Name or Company Name" autocomplete="name" required />
            <div class="field-error" id="pesepay-fullName-error"></div>
          </div>
          <div class="field" id="field-contactPhone">
            <label for="pesepay-contactPhone">Primary Contact Number</label>
            <input type="tel" id="pesepay-contactPhone" placeholder="e.g. 0771 327 202" autocomplete="tel" required />
            <div class="field-error" id="pesepay-contactPhone-error"></div>
          </div>
          ` : ''}
          <div class="field">
            <label for="pesepay-phone" id="rail-account-label">Zimbabwe Phone Number</label>
            <input type="tel" id="pesepay-phone" placeholder="e.g. 0771 327 202" autocomplete="tel" />
            <div class="field-subtext" id="rail-instruction-text">Check your phone for the USSD prompt.</div>
            <div class="field-error" id="pesepay-phone-error"></div>
          </div>
          <div class="pay-auth" id="pay-auth" style="display:none">
            <div class="pay-auth__code" id="pay-auth-code" style="display:none">
              <span class="pay-auth__eyebrow">InnBucks Authorization Code</span>
              <div class="pay-auth__code-row">
                <code class="pay-auth__code-value" id="pay-auth-code-value"></code>
                <button type="button" class="pay-auth__copy" id="pay-auth-copy">Copy</button>
              </div>
              <p class="pay-auth__hint" id="pay-auth-hint"></p>
              <p class="pay-auth__ref" id="pay-auth-ref"></p>
            </div>
            <div class="pay-auth__pin" id="pay-auth-pin" style="display:none">
              <label for="omari-auth-pin">O'mari Authorization PIN</label>
              <input type="password" id="omari-auth-pin" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="one-time-code" placeholder="Enter the PIN sent to your phone" />
              <div class="field-error" id="omari-auth-pin-error"></div>
              <button type="button" class="pay-auth__submit" id="omari-auth-submit">Authorize Payment</button>
            </div>
            <div class="pay-auth__status" id="pay-auth-status" role="status" aria-live="polite"></div>
            <div class="pay-auth__feedback" id="pay-auth-feedback" role="status" aria-live="polite"></div>
          </div>
          <button type="submit" id="confirm-payment-btn">
            <span class="btn-text">Pay $${packageData['data-amount']} USD</span>
            <span class="btn-spinner" style="display:none"></span>
          </button>
          <div class="field-success" id="pesepay-result" style="display:none"></div>
          <div class="modal-notice" id="pesepay-status">Check your phone for the payment prompt.</div>
        </form>
      </div>
    `;

    // Prevent background scroll
    document.body.style.overflow = 'hidden';
    document.body.appendChild(modal);

    const form = modal.querySelector('#pesepay-form');
    const phoneEl = form.querySelector('#pesepay-phone');
    const phoneErrorEl = form.querySelector('#pesepay-phone-error');
    const railLabelEl = form.querySelector('#rail-account-label');
    const railInstructionEl = form.querySelector('#rail-instruction-text');
    const payBtn = form.querySelector('#confirm-payment-btn');
    const btnText = payBtn.querySelector('.btn-text');
    const btnSpinner = payBtn.querySelector('.btn-spinner');
    const statusEl = form.querySelector('#pesepay-status');
    const resultEl = form.querySelector('#pesepay-result');
    const authPanel = form.querySelector('#pay-auth');
    const authCodeCard = form.querySelector('#pay-auth-code');
    const authCodeValue = form.querySelector('#pay-auth-code-value');
    const authCodeCopy = form.querySelector('#pay-auth-copy');
    const authHint = form.querySelector('#pay-auth-hint');
    const authRef = form.querySelector('#pay-auth-ref');
    const authPinPanel = form.querySelector('#pay-auth-pin');
    const authPinInput = form.querySelector('#omari-auth-pin');
    const authPinError = form.querySelector('#omari-auth-pin-error');
    const authSubmit = form.querySelector('#omari-auth-submit');
    const authStatus = form.querySelector('#pay-auth-status');
    const authFeedback = form.querySelector('#pay-auth-feedback');
    let activeAuthorization = null;
    const initialBtnLabel = btnText.textContent;
    const railCards = Array.prototype.slice.call(form.querySelectorAll('.pay-method'));

    // Rail selection config
    var railConfig = {
      ecocash: {
        label: 'EcoCash Phone Number',
        shortName: 'EcoCash',
        subtext: 'Check your phone for the USSD prompt.',
        placeholder: 'e.g. 0771 327 202',
        notice: 'A payment request will be sent to your phone. Approve it with your EcoCash PIN.',
        sent: 'A payment request has been sent to your phone. Approve it with your EcoCash PIN. (Keep this page open)',
        currency: 'USD',
        requiresPhone: true,
        requiresIdentifier: true,
      },
      innbucks: {
        label: 'InnBucks Phone Number',
        shortName: 'InnBucks',
        subtext: 'Enter your registered InnBucks phone number to generate your authorization code.',
        placeholder: 'e.g. 0771 327 202',
        notice: 'A payment request will be sent to your phone. Approve it with your InnBucks PIN.',
        sent: 'A payment request has been sent to your phone. Approve it with your InnBucks PIN. (Keep this page open)',
        currency: 'USD',
        requiresPhone: false,
        requiresIdentifier: true,
      },
      omari: {
        label: "O'mari Phone Number",
        shortName: "O'mari",
        subtext: "Enter your registered O'mari phone number to receive the payment authorization PIN.",
        placeholder: "263771327202",
        notice: "A payment request will be sent to your phone. Approve it with your O'mari PIN.",
        sent: "A payment request has been sent to your phone. Approve it with your O'mari PIN. (Keep this page open)",
        currency: 'USD',
        requiresPhone: true,
        requiresIdentifier: true,
      },
    };

    function getRailKey() {
      var checked = form.querySelector('input[name="pay_method"]:checked');
      if (!checked) return 'ecocash';
      return checked.value;
    }

    function syncRailSelection() {
      var key = getRailKey();
      railCards.forEach(function (card) {
        var selected = card.getAttribute('data-rail') === key;
        card.classList.toggle('selected', selected);
        card.setAttribute('aria-checked', selected ? 'true' : 'false');
      });
    }

    function updateRailUI() {
      var key = getRailKey();
      var cfg = railConfig[key] || railConfig.ecocash;
      if (!cfg) return;
      railLabelEl.textContent = cfg.label;
      railInstructionEl.textContent = cfg.subtext;
      phoneEl.placeholder = cfg.placeholder || 'e.g. 0771 327 202';
      phoneErrorEl.textContent = '';
      phoneEl.classList.remove('invalid');
      phoneEl.removeAttribute('aria-invalid');
      if (statusEl && !payBtn.disabled) statusEl.textContent = cfg.notice;
      syncRailSelection();
    }

    function handleRailChange(event) {
      if (!event || !event.target || event.target.name !== 'pay_method') return;
      updateRailUI();
    }

    var payMethodsEl = form.querySelector('#pay_methods');
    if (payMethodsEl) {
      payMethodsEl.addEventListener('change', handleRailChange);
      payMethodsEl.addEventListener('click', function (event) {
        var card = event.target.closest ? event.target.closest('.pay-method') : null;
        if (!card) return;
        // The radio is checked during click activation; defer so the label and
        // helper notice always reflect the newly selected rail.
        setTimeout(updateRailUI, 0);
      });
    }
    updateRailUI();

    function setRailsLocked(locked) {
      railCards.forEach(function (card) {
        card.classList.toggle('processing', locked);
        var input = card.querySelector('input[name="pay_method"]');
        if (input) input.disabled = locked;
      });
      syncRailSelection();
    }

    function setLoading(loading, label) {
      payBtn.disabled = loading;
      payBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
      btnSpinner.style.display = loading ? 'inline-block' : 'none';
      btnText.textContent = loading ? (label || 'Processing\u2026') : initialBtnLabel;
      // Lock the chosen rail while a payment is in flight, but never clear or
      // dim it: .processing keeps the selected card's border and glow.
      setRailsLocked(loading);
    }

    function setStatus(msg) {
      statusEl.textContent = msg;
      statusEl.style.display = 'block';
    }

    const SUPPORT_WHATSAPP = '263771327202';

    // pesepay_reference comes from our own payments table, but it is still
    // interpolated into HTML, so encode it rather than trusting it.
    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function hideAuthPanel() {
      activeAuthorization = null;
      if (!authPanel) return;
      authPanel.style.display = 'none';
      authCodeCard.style.display = 'none';
      authPinPanel.style.display = 'none';
      authStatus.textContent = '';
      authFeedback.textContent = '';
      authPinError.textContent = '';
      authPinInput.value = '';
      authPinInput.classList.remove('invalid');
      authPinInput.removeAttribute('aria-invalid');
      authSubmit.disabled = false;
      authSubmit.textContent = 'Authorize Payment';
    }

    function copyText(text, feedbackEl, successMessage) {
      function done(ok) {
        if (!feedbackEl) return;
        feedbackEl.textContent = ok ? successMessage + ' \u2713' : 'Copy failed \u2014 select and copy manually';
        feedbackEl.style.opacity = '1';
        setTimeout(function () { feedbackEl.style.opacity = '0'; }, 2500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(false); });
        return;
      }
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(true); } catch (e) { done(false); }
      document.body.removeChild(ta);
    }

    function hideCheckoutFields() {
      form.querySelectorAll('.field').forEach(function (f) { f.style.display = 'none'; });
      phoneEl.style.display = 'none';
      payBtn.style.display = 'none';
    }

    function showAuthCode(data) {
      activeAuthorization = {
        paymentId: data.paymentId || data.transaction_id,
        statusToken: data.statusToken,
        referenceNumber: data.referenceNumber || null,
      };
      hideCheckoutFields();
      statusEl.style.display = 'none';
      resultEl.style.display = 'none';
      authPanel.style.display = 'block';
      authCodeCard.style.display = 'block';
      authPinPanel.style.display = 'none';
      var code = data.authorizationCode || '';
      authCodeValue.textContent = code;
      authCodeValue.style.display = code ? '' : 'none';
      authCodeCopy.style.display = code ? '' : 'none';
      authHint.textContent = data.instructions || (code
        ? 'Open your InnBucks app and enter this code to authorize the payment.'
        : 'Open your InnBucks app and approve the payment request.');
      authRef.textContent = data.referenceNumber ? 'Payment reference: ' + data.referenceNumber : '';
      authStatus.textContent = 'Waiting for InnBucks to confirm the payment\u2026 Keep this page open.';
    }

    function showAuthPin(data) {
      activeAuthorization = {
        paymentId: data.paymentId || data.transaction_id,
        statusToken: data.statusToken,
        referenceNumber: data.referenceNumber || null,
      };
      hideCheckoutFields();
      statusEl.style.display = 'none';
      resultEl.style.display = 'none';
      authPanel.style.display = 'block';
      authCodeCard.style.display = 'none';
      authPinPanel.style.display = 'block';
      authStatus.textContent = data.message || 'Enter the authorization PIN sent to your phone.';
      authPinError.textContent = '';
      authPinInput.value = '';
      authPinInput.classList.remove('invalid');
      authPinInput.removeAttribute('aria-invalid');
      setTimeout(function () { authPinInput.focus(); }, 50);
    }

    function showPaymentSuccess(data) {
      hideAuthPanel();
      stopPolling();
      setLoading(false);

      var qs = new URLSearchParams();
      var gatewayKeys = [
        'mac', 'client_mac', 'clientMac', 'ip', 'client_ip', 'wlanuserip', 'res', 'userurl',
        'url', 'origUrl', 'login_url', 'loginUrl', 'nas_ip', 'nasip', 'nas_mac', 'ssid', 'gw_id', 'gw_sn',
      ];
      gatewayKeys.forEach(function (key) {
        var value = ruijieParams.get(key);
        if (value) qs.set(key, value);
      });
      if (ruijiePortalContext) {
        qs.set('ruijiePortal', ruijiePortalContext.portalUrl);
      }
      var sessionId = (ruijiePortalContext && ruijiePortalContext.sessionId) || inboundRuijieSessionId;
      var ruijieTimestamp = (ruijiePortalContext && ruijiePortalContext.timestamp) || inboundRuijieTimestamp;
      if (sessionId) qs.set('sessionId', sessionId);
      if (ruijieTimestamp) qs.set('timestamp', ruijieTimestamp);

      var pkg = selectedPackage || {};
      var packageName = data.packageName || data.tier || pkg['data-tier'] || 'Prepaid';
      var durationMin = data.durationMin != null ? data.durationMin : parseInt(pkg['data-period'], 10);
      var dataLimitGb = data.dataLimitGb != null ? data.dataLimitGb : parseFloat(pkg['data-data-limit']);
      var isUncapped = data.isUncapped === true || pkg['data-is-uncapped'] === 'true';
      var bandwidthUp = data.bandwidthMbpsUp != null ? data.bandwidthMbpsUp : parseInt(pkg['data-bandwidth-up'], 10);
      var bandwidthDown = data.bandwidthMbpsDown != null ? data.bandwidthMbpsDown : parseInt(pkg['data-bandwidth-down'], 10);

      qs.set('voucher', data.voucherCode || '');
      qs.set('pkg', packageName);
      if (Number.isFinite(durationMin) && durationMin > 0) qs.set('dur', String(durationMin));
      if (Number.isFinite(dataLimitGb)) qs.set('dataLimit', String(dataLimitGb));
      if (isUncapped) qs.set('uncapped', 'true');
      if (Number.isFinite(bandwidthUp) && bandwidthUp > 0) qs.set('bwUp', String(bandwidthUp));
      if (Number.isFinite(bandwidthDown) && bandwidthDown > 0) qs.set('bwDown', String(bandwidthDown));
      if (data.amount != null) qs.set('amount', String(data.amount));
      if (data.currency) qs.set('currency', data.currency);
      if (data.reference || data.referenceNumber) qs.set('ref', data.reference || data.referenceNumber);
      if (data.clientName) qs.set('name', data.clientName);
      if (data.clientPhone) qs.set('phone', data.clientPhone);
      if (data.paymentId || data.transaction_id) qs.set('paymentId', data.paymentId || data.transaction_id);

      location.assign('/success.html?' + qs.toString());
    }

    // The customer has paid, but Ruijie Cloud could not issue the code yet
    // (outage, or the tier has no mapped group). We must never imply their money
    // is lost, and must never show a voucher that does not exist. Polling
    // continues, so this state can resolve itself into a real code.
    function showSupportPending(reference, attemptsLeft) {
      hideAuthPanel();
      const ref = reference ? escapeHtml(reference) : 'not recorded yet';
      const waText = encodeURIComponent(
        'Hi Preyone, my payment went through but my WiFi code has not arrived yet. ' +
        'Payment reference: ' + reference + ' (package: ' + packageData['data-tier'] + ')'
      );
      const stayOpen =
        attemptsLeft * 3 >= 60
          ? 'Keep this page open and your code will appear here automatically.'
          : 'If it does not appear shortly, message us and we will sort it out.';

      statusEl.style.display = 'block';
      statusEl.innerHTML = [
        '<div class="pay-support">',
        '<p class="pay-support-title">Your payment went through \u2014 we are finishing your connection.</p>',
        '<p class="pay-support-body">Issuing your WiFi code is taking longer than usual. ' + stayOpen + '</p>',
        '<p class="pay-support-ref">Reference: <strong>' + ref + '</strong></p>',
        '<a class="pay-support-wa" href="https://wa.me/' + SUPPORT_WHATSAPP + '?text=' + waText +
          '" target="_blank" rel="noopener">Message us on WhatsApp</a>',
        '<p class="pay-support-note">Our support team has been notified automatically.</p>',
        '</div>'
      ].join('');
    }

    function showPaymentFailure(detail) {
      stopPolling();
      hideAuthPanel();
      setLoading(false);
      form.querySelectorAll('.field').forEach((f) => { f.style.display = 'none'; });
      payBtn.style.display = 'none';
      statusEl.style.display = 'none';
      // Keep the failed rail visibly selected; only Try Again unlocks it.
      setRailsLocked(true);
      resultEl.removeAttribute('style');
      resultEl.className = 'field-success payment-fail';
      resultEl.style.display = 'block';
      resultEl.setAttribute('role', 'alert');
      resultEl.innerHTML = [
        '<svg class="payment-fail-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="#FF2400" stroke-width="1.8" stroke-linejoin="round"/>' +
          '<path d="M12 9v4" stroke="#FF2400" stroke-width="2" stroke-linecap="round"/>' +
          '<path d="M12 17h.01" stroke="#FF2400" stroke-width="2" stroke-linecap="round"/>' +
        '</svg>',
        '<p class="payment-fail-title">Payment was not successful.</p>',
        typeof detail === 'string' && detail ? '<p class="payment-fail-detail">' + detail + '</p>' : '',
        '<div class="payment-fail-actions">' +
          '<button type="button" class="payment-btn payment-btn--try">Try Again</button>' +
          '<button type="button" class="payment-btn payment-btn--close">Close</button>' +
        '</div>'
      ].join('');
      resultEl.querySelector('.payment-btn--try').addEventListener('click', resetPaymentForm);
      resultEl.querySelector('.payment-btn--close').addEventListener('click', closeModal);
    }

    function resetPaymentForm() {
      stopPolling();
      hideAuthPanel();
      paymentSupportPending = false;
      lastPaymentReference = null;

      // Retry keeps the modal open; only the failure panel and form state reset.
      modal.classList.remove('hidden');
      modal.style.display = '';

      // Restore every control the failure/processing state touched.
      form.querySelectorAll('.field').forEach(function (f) { f.style.display = ''; });
      phoneEl.style.display = '';
      payBtn.style.display = '';
      statusEl.style.display = '';
      resultEl.className = 'field-success';
      resultEl.innerHTML = '';
      resultEl.style.display = 'none';
      resultEl.removeAttribute('role');

      form.querySelectorAll('.field-error').forEach(function (f) { f.textContent = ''; });
      form.querySelectorAll('.invalid').forEach(function (f) { f.classList.remove('invalid'); });
      form.querySelectorAll('[aria-invalid="true"]').forEach(function (f) { f.removeAttribute('aria-invalid'); });

      form.querySelectorAll('input, select, textarea, button').forEach(function (el) {
        el.disabled = false;
      });

      phoneEl.value = '';
      var nameInput = document.getElementById('pesepay-fullName');
      var contactInput = document.getElementById('pesepay-contactPhone');
      if (nameInput) nameInput.value = '';
      if (contactInput) contactInput.value = '';

      // Retry starts from the default rail; the customer can immediately pick
      // a different one and submit again without the modal closing.
      var firstRail = form.querySelector('input[name="pay_method"]');
      if (firstRail) firstRail.checked = true;

      setLoading(false);
      updateRailUI();
      phoneEl.focus();
    }

    function closeModal() {
      if (paymentPollTimer) {
        clearTimeout(paymentPollTimer);
        paymentPollTimer = null;
      }
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

    function stopPolling() {
      if (paymentPollTimer) {
        clearTimeout(paymentPollTimer);
        paymentPollTimer = null;
      }
    }

    function pollPaymentStatus(paymentId, statusToken, attemptsLeft, options) {
      stopPolling();
      options = options || {};
      var intervalMs = options.intervalMs || 1000;
      var referenceNumber = options.referenceNumber || null;
      var authFlow = Boolean(options.authFlow);

      if (attemptsLeft <= 0) {
        setLoading(false);
        if (authFlow) {
          showPaymentFailure('We did not receive confirmation within 90 seconds. If you approved the payment, contact support with your reference.');
          return;
        }
        // Never tell a customer whose money is confirmed that we have not
        // received it. Fall back to the support panel instead.
        if (paymentSupportPending) {
          showSupportPending(lastPaymentReference, 0);
        } else {
          setStatus('We haven\'t received confirmation yet. Check your phone for a pending prompt, then try again.');
        }
        return;
      }

      var statusUrl = referenceNumber
        ? `/api/payments/status?referenceNumber=${encodeURIComponent(referenceNumber)}&token=${encodeURIComponent(statusToken)}`
        : `/api/payments/status?id=${encodeURIComponent(paymentId)}&token=${encodeURIComponent(statusToken)}`;

      fetch(statusUrl)
        .then((r) => {
          if (r.status === 401 || r.status === 403) {
            throw Object.assign(new Error('Payment session expired'), { fatal: true });
          }
          return r.ok ? r.json() : Promise.reject(new Error('status unavailable'));
        })
        .then((data) => {
          if (data.status === 'completed') {
            showPaymentSuccess(data);
            return;
          }
          if (data.status === 'failed' || data.status === 'refunded') {
            showPaymentFailure(data.message || 'Payment was declined. Check your balance and try again.');
            return;
          }
          // Paid, but no code yet. Reassure, surface the reference for support,
          // and keep polling: a later poll may still mint successfully.
          if (data.supportRequired) {
            paymentSupportPending = true;
            lastPaymentReference = data.reference || null;
            showSupportPending(data.reference, attemptsLeft);
          } else if (authFlow) {
            authStatus.textContent = 'Waiting for payment confirmation\u2026 Keep this page open.';
          } else {
            setStatus('Waiting for payment confirmation\u2026 Approve the prompt on your phone. (Keep this page open)');
          }
          paymentPollTimer = setTimeout(
            () => pollPaymentStatus(paymentId, statusToken, attemptsLeft - 1, options),
            intervalMs
          );
        })
        .catch((err) => {
          if (err && err.fatal) {
            stopPolling();
            setLoading(false);
            showPaymentFailure('Your payment session expired. If you were charged, contact support with your reference.');
            return;
          }
          paymentPollTimer = setTimeout(
            () => pollPaymentStatus(paymentId, statusToken, attemptsLeft - 1, options),
            intervalMs
          );
        });
    }

    form.querySelector('#pesepay-phone').addEventListener('input', () => {
      phoneErrorEl.textContent = '';
    });

    authCodeCopy.addEventListener('click', function () {
      copyText(authCodeValue.textContent || '', authFeedback, 'Authorization code copied!');
    });

    authPinInput.addEventListener('input', function () {
      authPinError.textContent = '';
      authPinInput.classList.remove('invalid');
      authPinInput.removeAttribute('aria-invalid');
    });

    authPinInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        authSubmit.click();
      }
    });

    authSubmit.addEventListener('click', async function () {
      if (!activeAuthorization) {
        showPaymentFailure('Your payment session expired. Please try again.');
        return;
      }
      var pin = authPinInput.value.trim();
      if (!/^\d{4,8}$/.test(pin)) {
        authPinError.textContent = 'Enter the numeric PIN sent to your phone.';
        authPinInput.classList.add('invalid');
        authPinInput.setAttribute('aria-invalid', 'true');
        authPinInput.focus();
        return;
      }

      authSubmit.disabled = true;
      authSubmit.textContent = 'Authorizing\u2026';
      authStatus.textContent = 'Checking your authorization PIN\u2026';
      authPinError.textContent = '';

      var authorization = activeAuthorization;
      try {
        var response = await fetch('/api/payments/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transaction_id: authorization.paymentId,
            pin: pin,
            token: authorization.statusToken,
          }),
        });
        var data = {};
        try { data = await response.json(); } catch (e) { data = {}; }
        if (!response.ok || data.success === false) {
          showPaymentFailure(data.error || 'The authorization PIN was not accepted. Please try again.');
          return;
        }
        if (data.status === 'completed' && data.voucherCode) {
          showPaymentSuccess(data);
          return;
        }

        authSubmit.textContent = 'Authorized';
        authPinPanel.style.display = 'none';
        authStatus.textContent = 'PIN accepted. Waiting for O\'mari to confirm the payment\u2026';
        setLoading(true, 'Waiting for approval\u2026');
        pollPaymentStatus(authorization.paymentId, authorization.statusToken, 36, {
          intervalMs: 1000,
          referenceNumber: authorization.referenceNumber,
          authFlow: true,
        });
      } catch (err) {
        authSubmit.disabled = false;
        authSubmit.textContent = 'Authorize Payment';
        authStatus.textContent = 'We could not reach the payment provider. Please try again.';
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const phone = phoneEl.value.trim();
      var checked = form.querySelector('input[name="pay_method"]:checked');
      var railKey = checked ? getRailKey() : 'ecocash';
      var cfg = railConfig[railKey] || railConfig.ecocash;
      var requiresPhone = cfg ? cfg.requiresPhone : true;
      var requiresIdentifier = cfg ? cfg.requiresIdentifier !== false : true;
      phoneErrorEl.textContent = '';


      // Tier capture for $4.99+
      var price = parseFloat(packageData['data-amount']);
      if (price >= 4.99) {
        var nameInput = document.getElementById('pesepay-fullName');
        var contactInput = document.getElementById('pesepay-contactPhone');
        if (nameInput && !nameInput.value.trim()) {
          phoneErrorEl.textContent = 'Full name is required.';
          return;
        }
        if (contactInput && !contactInput.value.trim()) {
          phoneErrorEl.textContent = 'Contact number is required.';
          return;
        }
      }

      if (requiresIdentifier && !phone) {
        phoneErrorEl.textContent = cfg.label + ' is required.';
        return;
      }

      if (requiresPhone && !/^(\+?263|0)?7\d{8}$/.test(phone.replace(/[\s-]/g, ''))) {
        phoneErrorEl.textContent = 'Enter a valid Zimbabwe mobile number, e.g. 0771 327 202.';
        return;
      }
      resultEl.className = 'field-success';
      resultEl.style.display = 'none';
      resultEl.removeAttribute('role');
      resultEl.style.color = '';
      resultEl.style.background = '';
      resultEl.style.border = '';
      setLoading(true, 'Processing Payment\u2026');

      try {
        const result = await initiatePackagePayment(packageData, phone.replace(/[\s-]/g, ''));
        if (result.status === 'failed') {
          showPaymentFailure(result.error || 'Your payment was declined. Check your balance and try again.');
          return;
        }

        // Pesepay sends the EcoCash request straight to the customer's phone as
        // a USSD pull prompt, so there is no hosted page to redirect to — the
        // pesepayPollUrl we get back is a JSON status endpoint that must NOT be
        // shown in a browser. Poll our own status endpoint from here instead.
        if (!result.paymentId || !result.statusToken) {
          showPaymentFailure('We could not reach ' + (cfg.shortName || railKey) + '. Please try again in a moment.');
          return;
        }

        if (railKey === 'omari' && result.requires_pin) {
          setLoading(true, 'Waiting for authorization\u2026');
          showAuthPin(result);
          return;
        }

        if (railKey === 'innbucks') {
          setLoading(true, 'Waiting for approval\u2026');
          showAuthCode(result);
          pollPaymentStatus(result.paymentId, result.statusToken, 36, {
            intervalMs: 1000,
            referenceNumber: result.referenceNumber || null,
            authFlow: true,
          });
          return;
        }

        // EcoCash sends the USSD prompt straight to the customer's phone. The
        // response arrives before Pesepay has a reference, so poll by payment id.
        form.querySelectorAll('.field').forEach((f) => { f.style.display = 'none'; });
        phoneEl.style.display = 'none';
        payBtn.style.display = 'none';
        setLoading(true, 'Waiting for approval\u2026');
        setStatus(cfg.sent);
        pollPaymentStatus(result.paymentId, result.statusToken, 300);
      } catch (err) {
        console.error('Payment error:', err);
        showPaymentFailure((err && err.message) || 'Something unexpected went wrong. Please try again.');
      }
    });

    // Re-opened automatically after returning from Pesepay: start polling straight
    // away instead of showing the phone-number form again.
    if (pendingReturn && pendingReturn.paymentId) {
      form.querySelectorAll('.field').forEach((f) => { f.style.display = 'none'; });
      phoneEl.style.display = 'none';
      payBtn.style.display = 'none';
      setLoading(true, 'Checking payment\u2026');
      setStatus('Waiting for payment confirmation\u2026');
      pollPaymentStatus(pendingReturn.paymentId, pendingReturn.token, 300);
      pendingReturn = null;
    }

    // Close modal on X click
    modal.querySelector('.modal-close').addEventListener('click', closeModal);

    // Close on outside click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  async function initiatePackagePayment(packageData, phone) {
    const fullNameInput = document.getElementById('pesepay-fullName');
    const contactPhoneInput = document.getElementById('pesepay-contactPhone');
    const fullName = (fullNameInput ? fullNameInput.value.trim() : '') || 'Guest User';
    const contactPhone = contactPhoneInput ? contactPhoneInput.value.trim() : phone;
    const macAddress = ruijieParams.get('mac') || ruijieParams.get('clientMac');

    var checked = document.querySelector('input[name="pay_method"]:checked');
    var paymentRail = checked ? checked.value : 'ecocash';

    const paymentData = {
      payment_rail: paymentRail,
      account_identifier: phone || contactPhone,
      client_name: fullName,
      client_phone: contactPhone || phone,
      amount: parseFloat(packageData['data-amount']),
      package_id: packageData['data-tier'],
      currency: packageData['data-currency'],
      macAddress: macAddress,
    };

    const response = await fetch('/api/payments/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paymentData),
    });

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('Invalid response from server');
    }

    if (!response.ok) {
      throw new Error(result.error || 'Payment initiation failed');
    }
    return result;
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

  // --- RETURN FROM PESEPAY ---
  // /api/payments/return sends the customer back here with ?pay=&tok= once they
  // have approved (or abandoned) the EcoCash push. The status endpoint tells us
  // which package was bought, so we can re-open that package's modal and let it
  // resume polling — otherwise the voucher would be invisible until the customer
  // started a brand new payment.
  (function resumeAfterPesepayReturn() {
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get('pay');
    const token = params.get('tok');
    const failure = params.get('payment');
    if (!paymentId && !token && !failure) return;

    // Drop the token from the address bar so a refresh cannot replay this path.
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    }

    if (failure) {
      alert('We could not find that payment. Please start again.');
      return;
    }
    if (!paymentId || !token) return;

    fetch('/api/payments/status?id=' + encodeURIComponent(paymentId) + '&token=' + encodeURIComponent(token))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('lookup failed')); })
      .then(function (data) {
        pendingReturn = { paymentId: paymentId, token: token };
        for (let i = 0; i < packageButtons.length; i++) {
          if (packageButtons[i].dataset.tier === data.tier) {
            packageButtons[i].click();
            return;
          }
        }
        pendingReturn = null;
        alert('Payment received, but we could not reopen the package. Refresh to see your voucher.');
      })
      .catch(function () {
        alert('We could not check that payment. Please refresh and try again.');
      });
  })();

  // --- FORM HELPERS ---
  const voucherParams = new URLSearchParams(location.search);

  // --- DATA EXHAUSTED PANEL ---
  // When the gateway cuts a device off we land back here with the same gateway
  // query string. If that device has burned its allowance, swap the voucher
  // form for an explanation plus a top-up CTA — otherwise the customer just
  // sees a form asking for a code they already used.
  const dataFinishedCard = document.getElementById('data-finished-card');
  const dataFinishedUsage = document.getElementById('data-finished-usage');
  const dataFinishedUsageText = document.getElementById('data-finished-usage-text');
  const dataFinishedCta = document.getElementById('data-finished-cta');
  const dataFinishedRetry = document.getElementById('data-finished-retry');

  function formatBytes(bytes) {
    var gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(gb >= 10 ? 0 : 1) + ' GB';
    return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
  }

  function showDataFinished(status) {
    // The redemption form now lives in the Connect Now popup, so there is no
    // inline card to swap out — hide the trigger instead, otherwise the guest
    // is offered a voucher box they cannot use.
    var connectBtn = document.getElementById('connect-now-btn');
    if (connectBtn) connectBtn.hidden = true;
    dataFinishedCard.hidden = false;

    if (status.uncapped || !status.quotaBytes) return;

    dataFinishedUsage.hidden = false;
    dataFinishedUsageText.textContent =
      formatBytes(status.usedBytes) + ' of ' + formatBytes(status.quotaBytes) + ' used';
  }

  if (dataFinishedCard) {
    if (dataFinishedCta) {
      dataFinishedCta.addEventListener('click', function () {
        var target = document.getElementById('packages-heading');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    if (dataFinishedRetry) {
      dataFinishedRetry.addEventListener('click', function () {
        location.reload();
      });
    }

    var clientMac =
      voucherParams.get('client_mac') || voucherParams.get('mac') || voucherParams.get('clientMac');

    // Only meaningful for a device the gateway just identified; without a MAC
    // there is nothing to look up and we leave the normal form in place.
    if (clientMac) {
      fetch('/api/gateway/quota?mac=' + encodeURIComponent(clientMac))
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (status) {
          if (status && status.found && status.exhausted) showDataFinished(status);
        })
        .catch(function () {
          /* non-critical: fall back to the normal voucher form */
        });
    }
  }

  function redirectToSuccess(json) {
    // Navigate directly to the ext_login URL (or success.html fallback) returned by the server.
    // Do NOT re-encode or add extra params — the server already built the correct URL.
    location.href = json.redirectUrl || '/success.html';
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
          var hasField = false;
          json.errors.forEach(function (err) {
            var fieldName = err.path || err.param;
            setFieldError(fieldName, err.msg);
            if (document.getElementById('err-' + fieldName)) {
              hasField = true;
            }
          });
          if (!hasField && errorEl) {
            errorEl.textContent = json.errors[0].msg || 'Validation failed.';
            errorEl.classList.remove('hidden');
          }
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

  // --- VOUCHER REDEMPTION (shared by the Connect Now popup) ---

  // The account-registration endpoint is the last resort. It is rate limited to
  // 10 requests / 15 min PER IP, and every guest on a hotspot shares one NAT IP,
  // so it is only used when the local route genuinely is not deployed.
  async function legacyRedeem(code) {
    var res = await fetch('/api/auth/signup?' + voucherParams.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voucherCode: code, fullName: 'Voucher Guest', acceptedTos: true }),
    });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(json.error || 'Could not activate that voucher.');
    return json;
  }

  /**
   * Redeem against the LOCAL `vouchers` table: POST /api/portal/redeem.
   *
   * One round-trip, no account, no password and no Ruijie Cloud call, so paying
   * customers queued behind one NAT IP can never throttle each other out.
   * The legacy signup POST is used only when this deployment does not have the
   * route (404/405) or a proxy in front of it is down (501/502/503/504) — a
   * plain 500 is reported to the customer instead of silently retried, because
   * retrying a possibly-committed redemption could burn a second allocation.
   */
  async function redeemVoucher(code, queryOverride, payloadOverride) {
    var query = queryOverride != null ? queryOverride : voucherParams.toString();
    var payload = payloadOverride || {
      voucherCode: code,
      fullName: 'Voucher Guest',
      acceptedTos: true,
    };
    var res;
    try {
      res = await fetch('/api/portal/redeem?' + query, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
    } catch (_networkErr) {
      return legacyRedeem(code);
    }

    if (res.status === 404 || res.status === 405 || [501, 502, 503, 504].indexOf(res.status) !== -1) {
      return legacyRedeem(code);
    }

    var json = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      throw new Error(json.error || 'Could not activate that voucher. Please check the code and try again.');
    }
    return json;
  }

  // --- GATEWAY CONTEXT (client MAC / IP from the redirected URL) ------------
  // The EG105G-P (and the Ruijie AP models in front of it) name the station
  // differently: client_mac, mac, clientMac, sta_mac ... and for the address
  // ip, client_ip, wlanuserip. Normalising the key means one lookup serves every
  // model instead of a per-model branch. `nas_ip` is the GATEWAY address, so it
  // is deliberately never treated as the client IP.
  var GATEWAY_MAC_KEYS = ['clientmac', 'mac', 'macaddress', 'stamac', 'usermac', 'devicemac', 'clienthwaddr'];
  var GATEWAY_IP_KEYS = ['clientip', 'ip', 'ipaddress', 'wlanuserip', 'userip', 'staip', 'deviceip'];

  function normalizeGatewayKey(key) {
    return String(key == null ? '' : key).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function extractGatewayContext(search) {
    var context = { mac: '', ip: '' };
    var params;
    try {
      params = new URLSearchParams(search || '');
    } catch (_err) {
      return context;
    }
    params.forEach(function (value, key) {
      var name = normalizeGatewayKey(key);
      var raw = String(value == null ? '' : value).trim();
      if (!raw) return;
      if (!context.mac && GATEWAY_MAC_KEYS.indexOf(name) !== -1) context.mac = raw;
      if (!context.ip && GATEWAY_IP_KEYS.indexOf(name) !== -1) context.ip = raw;
    });
    return context;
  }

  var gatewayContext = extractGatewayContext(location.search);

  // The gateway params must travel in the QUERY STRING (AGENTS.md: a POST body
  // loses them). location.search is already forwarded verbatim; this only adds
  // the aliases we resolved, and never overrides what the gateway sent.
  function connectQueryString() {
    var qs;
    try {
      qs = new URLSearchParams(location.search);
    } catch (_err) {
      return voucherParams.toString();
    }
    if (gatewayContext.mac && !qs.get('client_mac')) qs.set('client_mac', gatewayContext.mac);
    if (gatewayContext.ip && !qs.get('client_ip') && !qs.get('ip')) qs.set('client_ip', gatewayContext.ip);
    return qs.toString();
  }

  // --- CONNECT NOW POPUP ---------------------------------------------------
  // Hidden by default (`display: none` in _modal.css); toggled here. Cancel,
  // the ✕ button, Escape and a click on the backdrop all close it, and focus
  // returns to the button that opened it.
  var connectModal = document.getElementById('connect-form-modal');
  var connectOpenBtn = document.getElementById('connect-now-btn') || document.getElementById('connectNowBtn');
  var connectForm = document.getElementById('connect-form');
  var connectInput = document.getElementById('connectVoucherCode');
  var connectError = document.getElementById('form-error') || document.getElementById('connect-form-error');
  var connectSubmitBtn = document.getElementById('quick-submit-btn') || document.getElementById('connect-submit-btn');
  var connectSubmitText = document.getElementById('connect-btn-text');
  var connectSubmitSpinner = document.getElementById('connect-btn-spinner');
  var connectReturnFocus = null;

  function isConnectOpen() {
    return !!connectModal && connectModal.classList.contains('is-open');
  }

  function setConnectOpen(open) {
    if (!connectModal) return;
    connectModal.classList.toggle('is-open', !!open);
    connectModal.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (connectOpenBtn) connectOpenBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('connect-modal-open', !!open);
    if (!open) {
      if (connectReturnFocus && typeof connectReturnFocus.focus === 'function') connectReturnFocus.focus();
      return;
    }
    var deviceRow = document.getElementById('connect-device');
    var deviceMac = document.getElementById('connect-device-mac');
    if (deviceRow && deviceMac) {
      if (gatewayContext.mac) {
        deviceMac.textContent = gatewayContext.mac;
        deviceRow.hidden = false;
      } else {
        deviceRow.hidden = true;
      }
    }
    if (connectError) {
      connectError.textContent = '';
      connectError.classList.add('hidden');
    }
    setFieldError('connectVoucherCode', '');
    var input = connectInput || document.getElementById('connectVoucherCode');
    if (input) setTimeout(function () { input.focus(); }, 60);
  }

  function setConnectLoading(loading) {
    if (connectSubmitBtn) connectSubmitBtn.disabled = loading;
    if (connectSubmitText) connectSubmitText.textContent = loading ? 'Connecting\u2026' : 'Connect';
    if (connectSubmitSpinner) connectSubmitSpinner.classList.toggle('hidden', !loading);
  }

  function showConnectError(message) {
    if (!connectError) return;
    connectError.textContent = message;
    connectError.classList.remove('hidden');
  }

  if (connectOpenBtn) {
    connectOpenBtn.addEventListener('click', function () {
      connectReturnFocus = connectOpenBtn;
      setConnectOpen(true);
    });
  }

  ['connect-form-close', 'connect-cancel-btn'].forEach(function (id) {
    var btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', function () { setConnectOpen(false); });
    }
  });

  if (connectModal) {
    // Click-outside-to-close: only a click on the overlay itself counts, so
    // selecting text inside the card never dismisses the form.
    connectModal.addEventListener('click', function (event) {
      if (event.target === connectModal) setConnectOpen(false);
    });
  }

  document.addEventListener('keydown', function (event) {
    if ((event.key === 'Escape' || event.key === 'Esc') && isConnectOpen()) {
      event.preventDefault();
      setConnectOpen(false);
    }
  });

  var connectBuyBtn = document.getElementById('connect-buy-btn');
  if (connectBuyBtn) {
    connectBuyBtn.addEventListener('click', function () {
      setConnectOpen(false);
      var target = document.getElementById('packages-heading');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  if (connectForm) {
    connectForm.addEventListener('submit', async function (event) {
      event.preventDefault();

      var input = connectInput || document.getElementById('connectVoucherCode');
      var code = (input && input.value ? input.value : '').replace(/\s+/g, '').trim();
      if (connectError) {
        connectError.textContent = '';
        connectError.classList.add('hidden');
      }
      setFieldError('connectVoucherCode', '');
      if (!code) {
        setFieldError('connectVoucherCode', 'Voucher code is required.');
        showConnectError('Voucher code is required.');
        if (input) input.focus();
        return;
      }

      setConnectLoading(true);
      try {
        var json = await redeemVoucher(code, connectQueryString(), {
          voucherCode: code,
          fullName: 'Voucher Guest',
          acceptedTos: true,
          clientMac: gatewayContext.mac || undefined,
          clientIp: gatewayContext.ip || undefined,
        });
        if (connectSubmitText) connectSubmitText.textContent = 'Connected \u2014 redirecting\u2026';
        // Server-built ext_login URL, with the original destination attached.
        redirectToSuccess(json);
      } catch (err) {
        setConnectLoading(false);
        var message = (err && err.message) || 'Could not activate that voucher. Please try again.';
        setFieldError('connectVoucherCode', message);
        showConnectError(message);
        if (input) input.focus();
      }
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
  ['fullName', 'phone', 'email', 'voucherCode', 'acceptedTos', 'suVoucherCode', 'connectVoucherCode', 'login-email', 'login-phone', 'login-password', 'suPassword', 'suPasswordConfirm'].forEach(function (f) {
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

// NOTE: "Connect Now" is wired inside the main portal IIFE above
// (open/close/backdrop/Escape + AJAX redemption). The old scroll-to-quick-form
// handler that lived here is gone: the button now opens the popup card instead.

// --- PORTAL LOGIN + INLINE DASHBOARD (account-login.html) ---
function showDashboard() {
  var loginSection = document.getElementById('login-section');
  var dashboard = document.getElementById('ma-dashboard');
  var loadingCard = document.getElementById('ma-loading');
  if (loginSection) loginSection.classList.add('hidden');
  if (loadingCard) loadingCard.classList.add('hidden');
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

  loadMyDevices(token);
}

function loadMyDevices(token) {
  var devicesList = document.getElementById('ma-devices-list');
  var noDevices = document.getElementById('ma-no-devices');
  var devicesSummary = document.getElementById('ma-devices-summary');
  if (!devicesList) return;

  fetch('/api/auth/my-devices', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function (r) { return r.json(); })
    .then(function (json) {
      devicesList.innerHTML = '';
      if (noDevices) noDevices.classList.add('hidden');
      if (devicesSummary) devicesSummary.textContent = '';

      if (!json.voucherCode) {
        if (noDevices) { noDevices.textContent = 'No active session. Connect a device to see bound devices here.'; noDevices.classList.remove('hidden'); }
        return;
      }

      if (devicesSummary) {
        devicesSummary.textContent = 'Voucher ' + json.voucherCode + ' — ' + json.devicesActive + '/' + json.deviceLimit + ' device slots used (' + json.slotsRemaining + ' free).';
      }

      if (!json.devices || json.devices.length === 0) {
        if (noDevices) { noDevices.textContent = 'No devices bound yet. Connect a device to your voucher to see it here.'; noDevices.classList.remove('hidden'); }
        return;
      }

      json.devices.forEach(function (d) {
        var card = document.createElement('div');
        card.className = 'ma-session-card';
        card.innerHTML =
          '<div class="ma-session-status ' + (d.isActive ? 'active' : 'expired') + '">' +
            (d.isActive ? '\u25cf ACTIVE' : '\u25cf INACTIVE') +
          '</div>' +
          '<div class="ma-session-body">' +
            '<div class="ma-session-row"><span class="lbl">MAC</span><span class="val">' + escHtml(d.macAddress) + '</span></div>' +
            (d.label ? '<div class="ma-session-row"><span class="lbl">Label</span><span class="val">' + escHtml(d.label) + '</span></div>' : '') +
            (d.boundAt ? '<div class="ma-session-row"><span class="lbl">Bound</span><span class="val">' + new Date(d.boundAt).toLocaleString() + '</span></div>' : '') +
            (d.lastSeenAt ? '<div class="ma-session-row"><span class="lbl">Last Seen</span><span class="val">' + new Date(d.lastSeenAt).toLocaleString() + '</span></div>' : '') +
          '</div>' +
          '<div style="padding:0.5rem 0.75rem;border-top:1px solid rgba(255,255,255,0.06)">' +
            '<button class="account-btn account-btn--link ma-device-unbind" data-mac="' + escHtml(d.macAddress) + '" style="color:#f87171;font-size:0.75rem">Unbind Device</button>' +
          '</div>';
        devicesList.appendChild(card);
      });

      devicesList.querySelectorAll('.ma-device-unbind').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var mac = btn.getAttribute('data-mac');
          if (!mac) return;
          if (!window.confirm('Unbind device ' + mac + '? It will need to reconnect (and may use another voucher slot).')) return;
          btn.disabled = true;
          btn.textContent = 'Unbinding…';
          fetch('/api/auth/my-devices?mac=' + encodeURIComponent(mac), {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token },
          })
            .then(function (r) { return r.json(); })
            .then(function () { loadMyDevices(token); })
            .catch(function () { btn.disabled = false; btn.textContent = 'Unbind Device'; });
        });
      });
    })
    .catch(function () { /* non-critical */ });
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
  showDashboard();
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
