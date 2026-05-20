(function () {
  'use strict';

  /* ── State ── */
  var token = window.localStorage.getItem('preyoneAdminToken') || '';
  var user = null; // { id, fullName, email, role }
  var cache = { vouchers: [], users: [], logs: [], admins: [] };
  var activeTimers = [];
  var usersFilter = null; // null | 'active'

  /* ── DOM refs ── */
  var $ = function (id) { return document.getElementById(id); };
  var authScreen = $('authScreen');
  var adminRoot = $('adminRoot');
  var statusText = $('statusText');
  var navUserName = $('navUserName');
  var navUserRole = $('navUserRole');
  var refreshAllBtn = $('refreshAllBtn');
  var logoutBtn = $('logoutBtn');

  /* ── Toast ── */
  var toastContainer = $('toastContainer');

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast toast--' + (type || 'info');
    el.textContent = msg;
    toastContainer.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('toast--visible'); });
    setTimeout(function () {
      el.classList.remove('toast--visible');
      setTimeout(function () { el.remove(); }, 300);
    }, 3500);
  }

  /* ── Auth helpers ── */
  function setAuthHeaders() {
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: Object.assign(setAuthHeaders(), opts.headers || {}),
      body: opts.body || undefined,
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { return Promise.reject(d); });
      return r.json();
    });
  }

  function showAdmin() {
    authScreen.classList.add('hidden');
    adminRoot.classList.remove('hidden');
    if (user) {
      navUserName.textContent = user.fullName;
      navUserRole.textContent = user.role;
      navUserRole.className = 'role-badge role-badge--' + user.role.toLowerCase();

      var isMgmt = user.role === 'CEO' || user.role === 'Manager';
      var isCeo = user.role === 'CEO';
      var isStaff = user.role === 'Staff';

      // Show/hide sidebar links
      var mgmtLinks = ['adminUsersLink', 'staffLink', 'reportsLink', 'peakHoursLink'];
      mgmtLinks.forEach(function (id) {
        var el = $(id);
        if (el) el.style.display = isMgmt ? '' : 'none';
      });

      // My Sales — all roles
      var mySalesLink = $('mySalesLink');
      if (mySalesLink) mySalesLink.style.display = isCeo ? '' : '';

      // CEO-only links
      document.querySelectorAll('.ceo-only').forEach(function (el) {
        el.style.display = isCeo ? '' : 'none';
      });

      // Hide Revenue/Pending Payments stat cards for Staff
      var revenueStat = $('statRevenue');
      var pendingStat = $('statPendingPayments');
      if (revenueStat) revenueStat.parentElement.style.display = isStaff ? 'none' : '';
      if (pendingStat) pendingStat.parentElement.style.display = isStaff ? 'none' : '';

      // Add CEO theme class to body
      document.body.classList.toggle('ceo-theme', isCeo);
    }
  }

  function showAuth() {
    adminRoot.classList.add('hidden');
    authScreen.classList.remove('hidden');
    navUserName.textContent = '';
    navUserRole.textContent = '';
  }

  function login(tokenVal, userData) {
    token = tokenVal;
    user = userData;
    window.localStorage.setItem('preyoneAdminToken', token);
    showAdmin();
    loadAll().then(function () {
      var firstLink = document.querySelector('.sidebar-link[data-section="overview"]');
      if (firstLink) firstLink.click();
    }).catch(function () {});
  }

  function logout() {
    token = '';
    user = null;
    window.localStorage.removeItem('preyoneAdminToken');
    activeTimers.forEach(function (t) { clearInterval(t); });
    activeTimers = [];
    showAuth();
    toast('Signed out', 'info');
  }

  /* ── Auth UI ── */
  var loginForm = $('loginForm');
  var signupForm = $('signupForm');
  var loginError = $('loginError');
  var signupError = $('signupError');
  var authSuccess = $('authSuccess');
  var authSuccessMsg = $('authSuccessMsg');

  // Tab switching
  document.querySelectorAll('.auth-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.auth-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var show = tab.getAttribute('data-tab');
      loginForm.classList.toggle('hidden', show !== 'login');
      signupForm.classList.toggle('hidden', show !== 'signup');
      loginError.classList.add('hidden');
      signupError.classList.add('hidden');
      authSuccess.classList.add('hidden');
    });
  });

  // Login
  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    loginError.classList.add('hidden');
    var email = $('loginEmail').value.trim();
    var password = $('loginPassword').value;
    if (!email || !password) { loginError.textContent = 'Email and password required'; loginError.classList.remove('hidden'); return; }

    var btn = $('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) { throw d; } return d; });
    }).then(function (data) {
      login(data.token, data.user);
      playLoginSound();
      toast('Welcome back, ' + data.user.fullName, 'success');
    }).catch(function (err) {
      loginError.textContent = err.error || 'Login failed';
      loginError.classList.remove('hidden');
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    });
  });

  // Signup
  signupForm.addEventListener('submit', function (e) {
    e.preventDefault();
    signupError.classList.add('hidden');
    authSuccess.classList.add('hidden');

    var fullName = $('signupName').value.trim();
    var email = $('signupEmail').value.trim();
    var phone = $('signupPhone').value.trim();
    var role = $('signupRole').value;
    var password = $('signupPassword').value;

    if (!fullName || !email || !phone || !password) {
      signupError.textContent = 'All fields required';
      signupError.classList.remove('hidden');
      return;
    }
    if (password.length < 6) {
      signupError.textContent = 'Password must be at least 6 characters';
      signupError.classList.remove('hidden');
      return;
    }

    var btn = $('signupBtn');
    btn.disabled = true;
    btn.textContent = 'Creating account...';

    fetch('/api/admin/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: fullName, email: email, phone: phone, role: role, password: password }),
    }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) { throw d; } return d; });
    }).then(function (data) {
      signupForm.classList.add('hidden');
      authSuccess.classList.remove('hidden');
      authSuccessMsg.textContent = data.message || 'Account created! You can now sign in.';
      toast(data.message || 'Account created successfully', data.pendingApproval ? 'info' : 'success');
    }).catch(function (err) {
      signupError.textContent = err.error || 'Signup failed';
      signupError.classList.remove('hidden');
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = 'Create Account';
    });
  });

  /* ── Sidebar nav ── */
  var sidebarLinks = document.querySelectorAll('.sidebar-link');
  var sections = {
    overview: $('section-overview'),
    vouchers: $('section-vouchers'),
    users: $('section-users'),
    sessions: $('section-sessions'),
    'ap-health': $('section-ap-health'),
    bandwidth: $('section-bandwidth'),
    'peak-hours': $('section-peak-hours'),
    alerts: $('section-alerts'),
    logs: $('section-logs'),
    'mac-mgmt': $('section-mac-mgmt'),
    'my-sales': $('section-my-sales'),
    time: $('section-time'),
    admins: $('section-admins'),
    staff: $('section-staff'),
    reports: $('section-reports'),
    packages: $('section-packages'),
    broadcasts: $('section-broadcasts'),
    backup: $('section-backup'),
    settings: $('section-settings'),
    audit: $('section-audit'),
  };

  sidebarLinks.forEach(function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var section = link.getAttribute('data-section');
      sidebarLinks.forEach(function (l) { l.classList.remove('active'); });
      link.classList.add('active');
      Object.keys(sections).forEach(function (k) {
        sections[k].classList.toggle('hidden', k !== section);
      });
      if (section === 'vouchers' && packages.length === 0) loadPackages();
      if (section === 'users') { usersFilter = null; startSessionTimerRefresh('userTableContent'); }
      if (section === 'admins' && user && (user.role === 'CEO' || user.role === 'Manager')) loadAdminUsers();
      if (section === 'staff' && user && (user.role === 'CEO' || user.role === 'Manager')) loadStaffManagement();
      if (section === 'my-sales' && user) loadMySales();
      if (section === 'time' && user) loadTimeSection();
      if (section === 'vouchers') {
        if (user && user.role !== 'Staff') loadPendingApprovals();
        if (user && user.role === 'Staff') loadMyApprovals();
      }
      if (section === 'reports') loadPendingHandovers();
      if (section === 'ap-health' && user) loadApHealth();
      if (section === 'bandwidth' && user) loadBandwidth();
      if (section === 'peak-hours' && user && (user.role === 'CEO' || user.role === 'Manager')) loadPeakHours();
      if (section === 'alerts' && user) loadAlerts();
      if (section === 'mac-mgmt' && user) { loadBlacklist(); loadWhitelist(); }
      if (section === 'sessions' && user) loadActiveSessions();
      if (section === 'overview' && user && (user.role === 'CEO' || user.role === 'Manager')) loadDashboardSales();
      if (section === 'reports' && user && (user.role === 'CEO' || user.role === 'Manager')) loadReports();
      if (section === 'settings' && user && user.role === 'CEO') loadSettings();
      if (section === 'audit' && user && user.role === 'CEO') loadAuditLog();
      if (section === 'packages' && user && user.role === 'CEO') loadPackagesManager();
      if (section === 'broadcasts' && user && user.role === 'CEO') loadBroadcasts();
      if (section === 'backup' && user && user.role === 'CEO') loadBackupManager();
      if (section === 'staff' && user && (user.role === 'CEO' || user.role === 'Manager')) { loadStaffManagement(); loadCommissions(); }
    });
  });

  /* ── Stat card navigation ── */
  function navigateToSection(section, filter) {
    usersFilter = filter || null;
    var link = document.querySelector('.sidebar-link[data-section="' + section + '"]');
    if (link) link.click();
  }

  document.querySelectorAll('.stat-card-clickable').forEach(function (card) {
    card.addEventListener('click', function () {
      navigateToSection(card.getAttribute('data-section'), card.getAttribute('data-filter'));
    });
  });

  /* ── Table rendering ── */
  function renderTable(columns, rows, emptyMsg) {
    if (!rows || rows.length === 0) {
      return '<div class="table-empty"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><p>' + (emptyMsg || 'No records found.') + '</p></div>';
    }
    var hdr = columns.map(function (c) { return '<th>' + c.label + '</th>'; }).join('');
    var bdy = rows.map(function (row) {
      var cells = columns.map(function (c) {
        var val = c.render ? c.render(row) : String(row[c.key] !== null && row[c.key] !== undefined ? row[c.key] : '');
        return '<td>' + val + '</td>';
      }).join('');
      return '<tr class="table-row">' + cells + '</tr>';
    }).join('');
    return '<div class="table-wrap"><table class="data-table"><thead><tr>' + hdr + '</tr></thead><tbody>' + bdy + '</tbody></table></div>';
  }

  /* ── Format helpers ── */
  function fmtDate(d) {
    if (!d) return '<span class="muted">—</span>';
    return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function fmtDur(m) {
    if (m == null) return '—';
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    var r = m % 60;
    return h + 'h' + (r ? ' ' + r + 'm' : '');
  }

  function fmtBool(v) {
    return v ? '<span class="badge badge--yes">Yes</span>' : '<span class="badge badge--no">No</span>';
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code).then(function () {
      toast('Copied "' + code + '"', 'success');
    }).catch(function () {
      toast('Could not copy code', 'error');
    });
  }

  /* ── Dashboard helpers ── */
  function fmtSessionTimer(expiresAt) {
    if (!expiresAt) return '<span class="muted">—</span>';
    var diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return '<span class="badge badge--expired">Expired</span>';
    var h = Math.floor(diff / 3600000);
    var m = Math.floor((diff % 3600000) / 60000);
    var s = Math.floor((diff % 60000) / 1000);
    return '<span class="session-timer">' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '</span>';
  }

  function fmtBw(r) {
    return r.bandwidth_mbps_up + ' / ' + r.bandwidth_mbps_down + ' Mbps';
  }

  function fmtData(r) {
    if (r.is_uncapped) return '<span class="badge badge--unlimited">Unlimited</span>';
    if (r.data_limit_gb != null) return r.data_limit_gb + ' GB';
    return '<span class="badge badge--unlimited">Unlimited</span>';
  }

  function drawSignupChart(data) {
    var canvas = $('signupChart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var pad = { top: 10, right: 10, bottom: 30, left: 35 };
    var chartW = W - pad.left - pad.right;
    var chartH = H - pad.top - pad.bottom;

    ctx.clearRect(0, 0, W, H);

    // Build label/value arrays
    var labels = [], values = [];
    var now = new Date();
    for (var i = 6; i >= 0; i--) {
      var d = new Date(now);
      d.setDate(d.getDate() - i);
      var key = d.toISOString().slice(0, 10);
      labels.push(d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));
      var match = data.find(function (r) { return r.day && r.day.slice(0, 10) === key; });
      values.push(match ? match.count : 0);
    }

    var maxVal = Math.max(1, Math.max.apply(null, values));
    var barW = chartW / labels.length * 0.6;
    var gap = chartW / labels.length;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var y = pad.top + chartH - (chartH * g / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '9px Montserrat, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxVal * g / 4), pad.left - 6, y + 3);
    }

    // Bars
    values.forEach(function (v, idx) {
      var x = pad.left + idx * gap + (gap - barW) / 2;
      var barH = (v / maxVal) * chartH;
      var y = pad.top + chartH - barH;

      // Gradient bar
      var grad = ctx.createLinearGradient(0, y, 0, pad.top + chartH);
      grad.addColorStop(0, '#ff00ff');
      grad.addColorStop(1, 'rgba(255,0,255,0.15)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
      ctx.fill();

      // Label
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px Montserrat, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(labels[idx], x + barW / 2, pad.top + chartH + 16);

      // Value on top
      if (v > 0) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px Montserrat, sans-serif';
        ctx.fillText(v, x + barW / 2, y - 5);
      }
    });
  }

  function drawRevenueChart(data) {
    var canvas = $('revenueChart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var pad = { top: 10, right: 10, bottom: 30, left: 45 };
    var chartW = W - pad.left - pad.right;
    var chartH = H - pad.top - pad.bottom;

    ctx.clearRect(0, 0, W, H);

    var labels = [], values = [];
    var now = new Date();
    for (var i = 6; i >= 0; i--) {
      var d = new Date(now);
      d.setDate(d.getDate() - i);
      var key = d.toISOString().slice(0, 10);
      labels.push(d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));
      var match = data.find(function (r) { return r.day && r.day.slice(0, 10) === key; });
      values.push(match ? match.revenue : 0);
    }

    var maxVal = Math.max(1, Math.max.apply(null, values));
    // Use nicer max
    maxVal = Math.ceil(maxVal / 5) * 5 || 5;
    var barW = chartW / labels.length * 0.6;
    var gap = chartW / labels.length;

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var y = pad.top + chartH - (chartH * g / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '9px Montserrat, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('$' + Math.round(maxVal * g / 4), pad.left - 6, y + 3);
    }

    values.forEach(function (v, idx) {
      var x = pad.left + idx * gap + (gap - barW) / 2;
      var barH = (v / maxVal) * chartH;
      var y = pad.top + chartH - barH;

      var grad = ctx.createLinearGradient(0, y, 0, pad.top + chartH);
      grad.addColorStop(0, '#00d4ff');
      grad.addColorStop(1, 'rgba(0,212,255,0.15)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px Montserrat, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(labels[idx], x + barW / 2, pad.top + chartH + 16);

      if (v > 0) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px Montserrat, sans-serif';
        ctx.fillText('$' + v.toFixed(2), x + barW / 2, y - 5);
      }
    });
  }

  function loadChart() {
    if (!user || (user.role !== 'CEO' && user.role !== 'Manager')) return Promise.resolve();
    return api('/api/admin/charts').then(function (data) {
      drawSignupChart(data.dailySignups);
      drawRevenueChart(data.dailyRevenue || []);
      if (data.activeSessions != null) $('statActiveSessions').textContent = data.activeSessions;
    }).catch(function () {});
  }

  function loadDashboardSales() {
    api('/api/admin/dashboard/sales').then(function (d) {
      $('statDailySales').textContent = '$' + d.daily.amount.toFixed(2) + ' (' + d.daily.count + ')';
      $('statWeeklySales').textContent = '$' + d.weekly.amount.toFixed(2) + ' (' + d.weekly.count + ')';
      $('statMonthlySales').textContent = '$' + d.monthly.amount.toFixed(2) + ' (' + d.monthly.count + ')';
      $('statTotalSales').textContent = '$' + d.total.amount.toFixed(2) + ' (' + d.total.count + ')';
    }).catch(function () {});
  }

  function loadActiveSessions() {
    $('sessionLoader').classList.remove('hidden');
    api('/api/admin/active-sessions').then(function (d) {
      $('sessionLoader').classList.add('hidden');
      $('statSessionsActive').textContent = d.totalActive;
      $('statSessionsRedeemed').textContent = d.totalRedeemed;
      $('statSessionsVouchers').textContent = d.perVoucher.length;
      var totalData = d.activeUsers.reduce(function (s, u) { return s + (u.data_used_bytes || 0); }, 0);
      $('statSessionsData').textContent = totalData > 1073741824 ? (totalData / 1073741824).toFixed(1) + ' GB' : totalData > 1048576 ? (totalData / 1048576).toFixed(0) + ' MB' : (totalData / 1024).toFixed(0) + ' KB';

      var sessionColumns = [
        { label: 'Name', render: function (r) { return '<span style="color:#fff;font-weight:600">' + escHtml(r.full_name) + '</span>'; } },
        { label: 'Phone', render: function (r) { return escHtml(r.phone || '—'); } },
        { label: 'Voucher', render: function (r) { return '<code>' + escHtml(r.voucher_code || '—') + '</code>'; } },
        { label: 'Data Used', key: null, render: function (r) {
          var du = r.data_used_bytes || 0;
          return du > 1073741824 ? (du / 1073741824).toFixed(2) + ' GB' : du > 1048576 ? (du / 1048576).toFixed(0) + ' MB' : (du / 1024).toFixed(0) + ' KB';
        }},
        { label: 'Data Left', key: null, render: function (r) {
          if (r.data_left_bytes === -1) return '<span style="color:#71ff2f">Unlimited</span>';
          if (r.data_left_bytes <= 0) return '<span style="color:#ff6b6b">Exhausted</span>';
          var dl = r.data_left_bytes;
          return dl > 1073741824 ? (dl / 1073741824).toFixed(2) + ' GB' : dl > 1048576 ? (dl / 1048576).toFixed(0) + ' MB' : (dl / 1024).toFixed(0) + ' KB';
        }},
        { label: 'Usage', key: null, render: function (r) {
          if (!r.usage_percent) return '<span style="color:#64748b">—</span>';
          var pct = parseFloat(r.usage_percent);
          var color = pct > 80 ? '#ff6b6b' : pct > 50 ? '#ffa500' : '#71ff2f';
          return '<div style="display:flex;align-items:center;gap:0.5rem"><div style="width:60px;height:6px;background:#1e293b;border-radius:3px;overflow:hidden"><div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:3px"></div></div><span style="color:' + color + ';font-size:0.7rem">' + pct + '%</span></div>';
        }},
        { label: 'Time Left', key: null, render: function (r) {
          var tl = r.time_left_min || 0;
          if (tl <= 0) return '<span style="color:#ff6b6b">Expired</span>';
          return tl > 60 ? Math.floor(tl / 60) + 'h ' + (tl % 60) + 'm' : tl + ' min';
        }},
        { label: 'MAC', render: function (r) { return '<code style="font-size:0.6rem">' + escHtml(r.mac_address || '—') + '</code>'; } },
      ];
      $('sessionTableContent').innerHTML = renderTable(sessionColumns, d.activeUsers, 'No active sessions.');

      // Per-voucher breakdown
      var vCols = [
        { label: 'Voucher Code', render: function (r) { return '<code>' + escHtml(r.voucher_code) + '</code>'; } },
        { label: 'Connected Users', key: 'connected_users', render: function (r) { return '<span style="color:#13d8ff;font-weight:700">' + r.connected_users + '</span>'; } },
      ];
      $('voucherSessionContent').innerHTML = renderTable(vCols, d.perVoucher, 'No vouchers in use.');
    }).catch(function () { $('sessionLoader').classList.add('hidden'); });
  }

  function refreshStaffOverview() {
    if (!user || user.role !== 'Staff') return;
    api('/api/admin/staff/stats').then(function (d) {
      $('statActiveSessions').textContent = d.activeSessions;
      $('statTotalUsers').textContent = d.totalUsers;
      $('statVouchersTotal').textContent = d.vouchersCreated;
      $('statVouchersUsed').textContent = d.vouchersUsed;
    }).catch(function () {});
  }

  function loadOverview() {
    if (user && user.role === 'Staff') {
      refreshStaffOverview();
      var chartSection = $('chartSection');
      if (chartSection) chartSection.classList.add('hidden');
      var recent = cache.logs.slice(-10).reverse();
      $('recentLogContent').innerHTML = recent.length ? renderTable(
        [
          { label: 'Event', key: 'event' },
          { label: 'User', key: 'full_name' },
          { label: 'Detail', key: 'detail', render: function (r) { return r.detail || '<span class="muted">—</span>'; } },
          { label: 'Time', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
        ],
        recent,
        'No recent activity.'
      ) : '<div class="table-empty"><p>No recent activity.</p></div>';
      return;
    }
    var activeSessions = cache.users.filter(function (u) { return u.session_expires_at && new Date(u.session_expires_at) > new Date(); }).length;
    var totalUsers = cache.users.length;
    var vouchersTotal = cache.vouchers.length;
    var vouchersUsed = cache.vouchers.reduce(function (sum, v) { return sum + (v.used_count || 0); }, 0);

    $('statActiveSessions').textContent = activeSessions;
    $('statTotalUsers').textContent = totalUsers;
    $('statVouchersTotal').textContent = vouchersTotal;
    $('statVouchersUsed').textContent = vouchersUsed;

    // Show chart section for CEO/Manager only
    var chartSection = $('chartSection');
    if (chartSection) {
      chartSection.classList.toggle('hidden', !user || (user.role !== 'CEO' && user.role !== 'Manager'));
    }

    var recent = cache.logs.slice(-10).reverse();
    $('recentLogContent').innerHTML = recent.length ? renderTable(
      [
        { label: 'Event', key: 'event' },
        { label: 'User', key: 'full_name' },
        { label: 'Detail', key: 'detail', render: function (r) { return r.detail || '<span class="muted">—</span>'; } },
        { label: 'Time', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
      ],
      recent,
      'No recent activity.'
    ) : '<div class="table-empty"><p>No recent activity.</p></div>';

    // Load Customer KPIs
    loadCustomerKPIs();
  }

  function loadCustomerKPIs() {
    if (!user || (user.role !== 'CEO' && user.role !== 'Manager')) return;
    api('/api/admin/customer-kpis').then(function (d) {
      // Add KPI stat cards to dashboard if not already there
      var statsGrid = $('statsGrid');
      if (!statsGrid) return;
      var existingKpi = document.getElementById('kpiAvgSession');
      if (existingKpi) return; // already added

      var kpiHtml =
        '<div class="stat-card-admin stat-card-admin--pink" id="kpiAvgSession">' +
          '<span class="stat-label">Avg Session</span>' +
          '<span class="stat-number">' + d.avgSessionDurationMin + ' min' + '</span>' +
        '</div>' +
        '<div class="stat-card-admin stat-card-admin--cyan" id="kpiAvgData">' +
          '<span class="stat-label">Avg Data/User</span>' +
          '<span class="stat-number">' + (d.avgBytesPerUser > 1073741824 ? (d.avgBytesPerUser / 1073741824).toFixed(2) + ' GB' : d.avgBytesPerUser > 1048576 ? (d.avgBytesPerUser / 1048576).toFixed(0) + ' MB' : (d.avgBytesPerUser / 1024).toFixed(0) + ' KB') + '</span>' +
        '</div>' +
        '<div class="stat-card-admin stat-card-admin--purple" id="kpiReconnect">' +
          '<span class="stat-label">Reconnect Rate</span>' +
          '<span class="stat-number">' + d.reconnectRate + '%' + '</span>' +
        '</div>' +
        '<div class="stat-card-admin stat-card-admin--green" id="kpiCompletion">' +
          '<span class="stat-label">Completion</span>' +
          '<span class="stat-number">' + d.completionRate + '%' + '</span>' +
        '</div>';
      statsGrid.insertAdjacentHTML('beforeend', kpiHtml);
    }).catch(function () {});
  }

  function clearTimers() {
    if (dashboardRefreshTimer) { clearInterval(dashboardRefreshTimer); dashboardRefreshTimer = null; }
    activeTimers.forEach(function (t) { clearInterval(t); });
    activeTimers = [];
  }

  var dashboardRefreshTimer = null;

  function startDashboardRefresh() {
    if (dashboardRefreshTimer) clearInterval(dashboardRefreshTimer);
    dashboardRefreshTimer = setInterval(function () {
      if (!user) return;
      loadChart();
      loadRevenue();
      if (user.role === 'CEO' || user.role === 'Manager') loadDashboardSales();
      if (user.role === 'Staff') refreshStaffOverview();
      // Refresh alert badge count
      api('/api/admin/alerts').then(function (d) {
        var badge = $('alertBadge');
        if (d.totalUnacknowledged > 0) {
          badge.textContent = d.totalUnacknowledged;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }).catch(function () {});
      // Refresh notification counts
      pollNotifications();
    }, 30000);
  }

  /* ── Notification System ── */

  var prevNotifCount = 0;

  function playNotifSound() {
    try {
      var ctx = new (window.AudioContext || (window).webkitAudioContext)();
      // iPhone Milestone — three-tone ascending C5→E5→G5 major arpeggio
      var notes = [523.25, 659.25, 783.99];
      var startTime = ctx.currentTime;
      notes.forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        var t = startTime + i * 0.12;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.6, t);
        gain.gain.linearRampToValueAtTime(0.4, t + 0.08);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
        osc.start(t);
        osc.stop(t + 0.25);
      });
    } catch (e) { /* audio not supported */ }
  }

  function playLoginSound() {
    try {
      var ctx = new (window.AudioContext || (window).webkitAudioContext)();
      var now = ctx.currentTime;
      // Ascending welcome chime: C4→E4→G4→C5 (bright major chord)
      var notes = [261.63, 329.63, 392.0, 523.25];
      notes.forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        var t = now + i * 0.1;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.5, t);
        gain.gain.linearRampToValueAtTime(0.3, t + 0.06);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
        osc.start(t);
        osc.stop(t + 0.3);
      });
    } catch (e) { /* audio not supported */ }
  }

  function flashSidebarLink(linkId) {
    var link = $(linkId);
    if (!link) return;
    link.style.transition = 'none';
    link.style.boxShadow = 'inset 3px 0 0 0 var(--accent-cyan), 0 0 15px rgba(0,212,255,0.2)';
    link.style.borderLeft = '2px solid var(--accent-cyan)';
    setTimeout(function () {
      link.style.transition = 'box-shadow 0.8s, border-color 0.8s';
      link.style.boxShadow = '';
      link.style.borderLeft = '';
    }, 3000);
  }

  function pollNotifications() {
    if (!user) return;
    api('/api/admin/notifications/count').then(function (d) {
      var total = d.total || 0;

      // Unread broadcast badge
      var bcastLink = $('broadcastsLink');
      if (bcastLink) {
        var existingBadge = bcastLink.querySelector('.notif-badge');
        if (d.unreadBroadcasts > 0) {
          if (!existingBadge) {
            var badge = document.createElement('span');
            badge.className = 'notif-badge';
            badge.textContent = d.unreadBroadcasts;
            bcastLink.appendChild(badge);
          } else {
            existingBadge.textContent = d.unreadBroadcasts;
          }
          flashSidebarLink('broadcastsLink');
        } else {
          if (existingBadge) existingBadge.remove();
        }
      }

      // Manager/CEO sidebar highlights
      if (user.role === 'CEO' || user.role === 'Manager') {
        var vLink = document.querySelector('a[data-section="vouchers"]');
        var rLink = document.querySelector('a[data-section="reports"]');
        if (d.pendingApprovals > 0) {
          if (vLink) vLink.style.borderLeft = '2px solid var(--accent-cyan)';
          flashSidebarLink('vouchersLink');
        } else {
          if (vLink) vLink.style.borderLeft = '';
        }
        if (d.pendingHandovers > 0) {
          if (rLink) rLink.style.borderLeft = '2px solid var(--accent-cyan)';
        } else {
          if (rLink) rLink.style.borderLeft = '';
        }
      }

      // Staff: new approved notifications
      if (user.role === 'Staff' && d.newApproved > 0) {
        var mySalesLink = $('mySalesLink');
        if (mySalesLink) {
          mySalesLink.style.borderLeft = '2px solid var(--accent-cyan)';
          flashSidebarLink('mySalesLink');
        }
      }

      // Play sound and show toast if new notifications arrived
      if (total > prevNotifCount && prevNotifCount > 0) {
        playNotifSound();
        var msg = '';
        var parts = [];
        if (d.unreadBroadcasts > 0) parts.push(d.unreadBroadcasts + ' new broadcast(s)');
        if (user.role !== 'Staff') {
          if (d.pendingApprovals > 0) parts.push(d.pendingApprovals + ' voucher approval(s)');
          if (d.pendingHandovers > 0) parts.push(d.pendingHandovers + ' cash handover(s)');
        } else {
          if (d.newApproved > 0) parts.push(d.newApproved + ' voucher request(s) approved!');
        }
        msg = parts.join(', ');
        if (msg) {
          // Show broadcast as a clickable toast
          if (d.unreadBroadcasts > 0) {
            var bcastToast = document.createElement('div');
            bcastToast.className = 'toast toast--broadcast toast--visible';
            bcastToast.style.cssText = 'cursor:pointer;background:linear-gradient(135deg,#6a0dad,#ff00ff);color:#fff;border:1px solid rgba(255,0,255,0.3);';
            bcastToast.innerHTML = '<strong>📢 ' + d.unreadBroadcasts + ' New Broadcast' + (d.unreadBroadcasts > 1 ? 's' : '') + '</strong><br><span style="font-size:0.75rem;opacity:0.8;">' + msg + ' — Click to view</span>';
            bcastToast.addEventListener('click', function () {
              var bLink = document.querySelector('.sidebar-link[data-section="broadcasts"]');
              if (bLink) bLink.click();
              bcastToast.remove();
            });
            $('toastContainer').appendChild(bcastToast);
            setTimeout(function () { if (bcastToast.parentNode) bcastToast.remove(); }, 8000);
          } else {
            toast(msg, 'info');
          }
          if (window.Notification && Notification.permission === 'granted') {
            new Notification('Preyone Admin', { body: msg, icon: '/images/preyonetabicon.webp' });
          }
        }
      }
      prevNotifCount = total;
    }).catch(function () {});
  }

  // Request notification permission on init
  setTimeout(function () {
    if (window.Notification && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, 5000);

  function startSessionTimerRefresh(tableId) {
    var container = document.getElementById(tableId);
    if (!container) return;
    var timers = container.querySelectorAll('.session-timer');
    if (timers.length === 0) return;
    var interval = setInterval(function () {
      timers.forEach(function (el) {
        var expires = el.getAttribute('data-expires');
        if (!expires) { el.textContent = '—'; return; }
        var diff = new Date(expires).getTime() - Date.now();
        if (diff <= 0) { el.textContent = 'Expired'; el.className = 'badge badge--expired'; return; }
        var h = Math.floor(diff / 3600000);
        var m = Math.floor((diff % 3600000) / 60000);
        var s = Math.floor((diff % 60000) / 1000);
        el.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      });
    }, 1000);
    activeTimers.push(interval);
  }

  /* ── Loaders ── */
  var loaders = {
    vouchers: $('voucherLoader'),
    users: $('userLoader'),
    logs: $('logLoader'),
    'my-sales': $('mySalesLoader'),
    timeSummary: $('timeSummaryLoader'),
    timeLogs: $('timeLogsLoader'),
    admins: $('adminUserLoader'),
    staff: $('staffLoader'),
    pendingStaff: $('pendingStaffLoader'),
    revenueTier: $('revenueTierLoader'),
    transactions: $('transactionLoader'),
    staffSales: $('staffSalesLoader'),
    allStaffSales: $('allStaffSalesLoader'),
    auditLog: $('auditLogLoader'),
    ap: $('apLoader'),
    bwTop: $('bwTopLoader'),
    alert: $('alertLoader'),
    blacklist: $('blacklistLoader'),
    whitelist: $('whitelistLoader'),
  };

  var contents = {
    vouchers: $('voucherTableContent'),
    users: $('userTableContent'),
    logs: $('logTableContent'),
    'my-sales': $('mySalesTableContent'),
    timeSummary: $('timeSummaryContent'),
    timeLogs: $('timeLogsContent'),
    admins: $('adminUserTableContent'),
    staff: $('staffTableContent'),
    pendingStaff: $('pendingStaffContent'),
    revenueTier: $('revenueTierContent'),
    transactions: $('transactionTableContent'),
    staffSales: $('staffSalesSummaryContent'),
    allStaffSales: $('allStaffSalesContent'),
    auditLog: $('auditLogTableContent'),
    ap: $('apTableContent'),
    bwTop: $('bwTopContent'),
    bwHourly: $('bwHourlyContent'),
    peakSignup: $('peakSignupContent'),
    peakDaily: $('peakDailyContent'),
    alert: $('alertTableContent'),
    alertAll: $('alertAllContent'),
    blacklist: $('blacklistContent'),
    whitelist: $('whitelistContent'),
  };

  function showLoader(section) {
    if (loaders[section]) loaders[section].classList.remove('hidden');
    if (contents[section]) contents[section].innerHTML = '';
  }

  function hideLoader(section) {
    if (loaders[section]) loaders[section].classList.add('hidden');
  }

  /* ── Data fetching ── */
  function loadVouchers() {
    showLoader('vouchers');
    return api('/api/admin/vouchers').then(function (data) {
      cache.vouchers = data;
      contents.vouchers.innerHTML = renderTable(
        [
          { label: 'Code', key: 'code', render: function (r) { return '<span class="code-cell" title="Click to copy" onclick="(' + copyCode.toString() + ')(\'' + r.code.replace(/'/g, "\\'") + '\')">' + r.code + '</span>'; } },
          { label: 'Price', render: function (r) { return r.price_amount ? '$' + parseFloat(r.price_amount).toFixed(2) : '<span class="muted">—</span>'; } },
          { label: 'Duration', key: 'duration_min', render: function (r) { return fmtDur(r.duration_min); } },
          { label: 'Bandwidth (↑/↓)', render: function (r) { return fmtBw(r); } },
          { label: 'Data', render: function (r) { return fmtData(r); } },
          { label: 'Max Uses', key: 'max_uses' },
          { label: 'Used', render: function (r) {
            return '<a href="#" class="redemption-link" data-voucher-id="' + r.id + '" data-voucher-code="' + r.code.replace(/'/g, "&apos;") + '">' + r.used_count + '/' + r.max_uses + '</a>';
          }},
          { label: 'Expires', key: 'expires_at', render: function (r) { return fmtDate(r.expires_at); } },
          { label: 'Created', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
        ],
        data,
        'No vouchers created yet.'
      );
      // Bind redemption links
      Array.from(contents.vouchers.querySelectorAll('.redemption-link')).forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          showRedemptions(a.getAttribute('data-voucher-id'), a.getAttribute('data-voucher-code'));
        });
      });
      hideLoader('vouchers');
    }).catch(function (err) {
      hideLoader('vouchers');
      contents.vouchers.innerHTML = '<div class="table-error">' + escHtml(err.error || 'Failed to load vouchers.') + '</div>';
      throw err;
    });
  }

  function showRedemptions(voucherId, voucherCode) {
    var container = $('redemptionDetail');
    var content = $('redemptionContent');
    var title = $('redemptionTitle');
    title.textContent = 'Redemptions — ' + voucherCode;
    content.innerHTML = '<div class="table-loader"><div class="loader-spinner"></div><span>Loading redemptions...</span></div>';
    container.classList.remove('hidden');

    api('/api/admin/voucher-redemptions?voucher_id=' + encodeURIComponent(voucherId)).then(function (data) {
      if (!data || data.length === 0) {
        content.innerHTML = '<div class="table-empty"><p>No redemptions recorded for this voucher.</p></div>';
        return;
      }
      content.innerHTML = renderTable(
        [
          { label: 'User', key: 'full_name', render: function (r) { return r.full_name || '<span class="muted">—</span>'; } },
          { label: 'MAC Address', key: 'mac_address', render: function (r) { return r.mac_address || '<span class="muted">—</span>'; } },
          { label: 'IP Address', key: 'ip_address', render: function (r) { return r.ip_address || '<span class="muted">—</span>'; } },
          { label: 'Used At', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
        ],
        data,
        'No redemptions recorded for this voucher.'
      );
    }).catch(function () {
      content.innerHTML = '<div class="table-error">Failed to load redemptions.</div>';
    });
  }

  window.closeRedemptions = function () {
    $('redemptionDetail').classList.add('hidden');
  };

  function loadUsers() {
    showLoader('users');
    return api('/api/admin/users').then(function (data) {
      cache.users = data;
      var filtered = data;
      if (usersFilter === 'active') {
        filtered = data.filter(function (u) { return u.session_expires_at && new Date(u.session_expires_at) > new Date(); });
      }
      contents.users.innerHTML = renderTable(
        [
          { label: 'Name', key: 'full_name' },
          { label: 'Phone', key: 'phone' },
          { label: 'Voucher', key: 'voucher_code', render: function (r) { return r.voucher_code ? '<span class="code-cell-sm">' + r.voucher_code + '</span>' : '<span class="muted">—</span>'; } },
          { label: 'Session', render: function (r) { return r.session_expires_at ? '<span class="session-timer" data-expires="' + r.session_expires_at + '">' + fmtSessionTimer(r.session_expires_at) + '</span>' : '<span class="muted">—</span>'; } },
          { label: 'TOS', key: 'accepted_tos', render: function (r) { return fmtBool(r.accepted_tos); } },
          { label: 'MAC', key: 'mac_address', render: function (r) { return r.mac_address || '<span class="muted">—</span>'; } },
          { label: 'IP', key: 'ip_address', render: function (r) { return r.ip_address || '<span class="muted">—</span>'; } },
        ],
        filtered,
        usersFilter === 'active' ? 'No active sessions.' : 'No users registered.'
      );
      hideLoader('users');
      startSessionTimerRefresh('userTableContent');
    }).catch(function (err) {
      hideLoader('users');
      contents.users.innerHTML = '<div class="table-error">' + escHtml(err.error || 'Failed to load users.') + '</div>';
      throw err;
    });
  }

  function loadLogs() {
    showLoader('logs');
    return api('/api/admin/access-log').then(function (data) {
      cache.logs = data;
      contents.logs.innerHTML = renderTable(
        [
          { label: 'Event', key: 'event' },
          { label: 'User', key: 'full_name' },
          { label: 'MAC', key: 'mac_address', render: function (r) { return r.mac_address || '<span class="muted">—</span>'; } },
          { label: 'IP', key: 'ip_address', render: function (r) { return r.ip_address || '<span class="muted">—</span>'; } },
          { label: 'Detail', key: 'detail', render: function (r) { return r.detail || '<span class="muted">—</span>'; } },
          { label: 'Time', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
        ],
        data,
        'No access log entries yet.'
      );
      hideLoader('logs');
    }).catch(function (err) {
      hideLoader('logs');
      contents.logs.innerHTML = '<div class="table-error">' + escHtml(err.error || 'Failed to load logs.') + '</div>';
      throw err;
    });
  }

  function loadAdminUsers() {
    showLoader('admins');
    return api('/api/admin/admin-users').then(function (data) {
      cache.admins = data;
      contents.admins.innerHTML = renderTable(
        [
          { label: 'Name', key: 'full_name' },
          { label: 'Email', key: 'email' },
          { label: 'Phone', key: 'phone' },
          { label: 'Role', key: 'role', render: function (r) { return '<span class="role-badge role-badge--' + r.role.toLowerCase() + '">' + r.role + '</span>'; } },
          { label: 'Created', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
        ],
        data,
        'No admin users found.'
      );
      hideLoader('admins');
    }).catch(function (err) {
      hideLoader('admins');
      contents.admins.innerHTML = '<div class="table-error">' + escHtml(err.error || 'Failed to load admin users.') + '</div>';
      throw err;
    });
  }

  /* ── Revenue data ── */
  function loadRevenue() {
    if (!user || (user.role !== 'CEO' && user.role !== 'Manager')) return Promise.resolve();
    return api('/api/admin/revenue').then(function (data) {
      $('statRevenue').textContent = '$' + parseFloat(data.combinedRevenue || data.totalRevenue).toFixed(2);
      $('statPendingPayments').textContent = '$' + parseFloat(data.pendingRevenue).toFixed(2);
    }).catch(function () {});
  }

  /* ── AP Health Dashboard ── */
  function loadApHealth() {
    showLoader('ap');
    api('/api/admin/ap-health').then(function (d) {
      $('apStatTotal').textContent = d.total;
      $('apStatOnline').textContent = d.online;
      $('apStatWarning').textContent = d.warning;
      $('apStatOffline').textContent = d.offline;
      $('apStatClients').textContent = d.totalClients;

      var apColumns = [
        { label: 'Name', render: function (r) { return '<span style="color:#fff;font-weight:600">' + escHtml(r.name) + '</span>'; } },
        { label: 'Model', key: 'model', render: function (r) { return r.model || '<span class="muted">—</span>'; } },
        { label: 'MAC', render: function (r) { return '<code>' + escHtml(r.mac_address) + '</code>'; } },
        { label: 'IP', key: 'ip_address', render: function (r) { return r.ip_address || '<span class="muted">—</span>'; } },
        { label: 'Location', key: 'location', render: function (r) { return r.location || '<span class="muted">—</span>'; } },
        { label: 'Status', render: function (r) {
          var s = r.status;
          if (s === 'online') return '<span class="badge badge--yes">Online</span>';
          if (s === 'warning') return '<span class="badge badge--warn">Warning</span>';
          return '<span class="badge badge--no">Offline</span>';
        }},
        { label: 'Firmware', key: 'firmware_version', render: function (r) { return r.firmware_version || '<span class="muted">—</span>'; } },
        { label: 'Clients', key: 'clients_count' },
        { label: 'Uptime', render: function (r) {
          if (!r.uptime_seconds || r.uptime_seconds <= 0) return '<span class="muted">—</span>';
          var d = Math.floor(r.uptime_seconds / 86400);
          var h = Math.floor((r.uptime_seconds % 86400) / 3600);
          return (d > 0 ? d + 'd ' : '') + h + 'h';
        }},
        { label: 'Last Seen', render: function (r) { return fmtDate(r.last_seen); } },
      ];
      // CEO-only actions column
      if (user && user.role === 'CEO') {
        apColumns.push({ label: 'Actions', render: function (r) {
          return '<div style="display:flex;gap:0.4rem;">' +
            '<button class="btn-icon" onclick="editApDevice(\'' + r.id + '\',\'' + escHtml(r.name) + '\',\'' + escHtml(r.model||'') + '\',\'' + escHtml(r.mac_address) + '\',\'' + escHtml(r.ip_address||'') + '\',\'' + escHtml(r.location||'') + '\')" title="Edit" style="color:var(--accent-cyan);font-size:0.7rem;">✎</button>' +
            '<button class="btn-icon" onclick="deleteApDevice(\'' + r.id + '\',\'' + escHtml(r.name) + '\')" title="Delete" style="color:var(--red);font-size:0.7rem;">✕</button>' +
            '</div>';
        }});
      }
      contents.ap.innerHTML = renderTable(apColumns, d.devices, 'No AP devices registered.');
      hideLoader('ap');
    }).catch(function () { hideLoader('ap'); });
  }

  /* ── Bandwidth Monitor ── */
  function drawBandwidthChart(data) {
    var canvas = $('bandwidthChart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!data || data.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '12px Montserrat, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No bandwidth data available yet', W / 2, H / 2);
      return;
    }

    var pad = { top: 10, right: 10, bottom: 30, left: 45 };
    var chartW = W - pad.left - pad.right;
    var chartH = H - pad.top - pad.bottom;

    var labels = data.map(function (r) {
      var d = new Date(r.hour);
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    });
    var upValues = data.map(function (r) { return parseInt(r.bytes_up) || 0; });
    var downValues = data.map(function (r) { return parseInt(r.bytes_down) || 0; });
    var maxVal = Math.max(1, Math.max.apply(null, upValues.concat(downValues)));
    maxVal = Math.ceil(maxVal / 1024 / 1024) * 5 || 5; // MB scale

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var y = pad.top + chartH - (chartH * g / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '9px Montserrat, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxVal * g / 4) + ' MB', pad.left - 6, y + 3);
    }

    // Down (cyan area)
    var gap = chartW / Math.max(1, labels.length - 1);
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + chartH);
    downValues.forEach(function (v, i) {
      var x = pad.left + i * gap;
      var barH = (v / 1024 / 1024 / maxVal) * chartH;
      var y = pad.top + chartH - barH;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.left + (downValues.length - 1) * gap, pad.top + chartH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,212,255,0.15)';
    ctx.fill();
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    downValues.forEach(function (v, i) {
      var x = pad.left + i * gap;
      var barH = (v / 1024 / 1024 / maxVal) * chartH;
      var y = pad.top + chartH - barH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Up (pink area)
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + chartH);
    upValues.forEach(function (v, i) {
      var x = pad.left + i * gap;
      var barH = (v / 1024 / 1024 / maxVal) * chartH;
      var y = pad.top + chartH - barH;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.left + (upValues.length - 1) * gap, pad.top + chartH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,0,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = '#ff00ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    upValues.forEach(function (v, i) {
      var x = pad.left + i * gap;
      var barH = (v / 1024 / 1024 / maxVal) * chartH;
      var y = pad.top + chartH - barH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // X labels (every other)
    labels.forEach(function (label, i) {
      if (i % 2 !== 0 && i !== labels.length - 1) return;
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '8px Montserrat, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, pad.left + i * gap, pad.top + chartH + 16);
    });

    // Legend
    ctx.fillStyle = '#00d4ff';
    ctx.fillRect(W - 110, 4, 8, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '8px Montserrat, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Download', W - 98, 12);
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(W - 40, 4, 8, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('Upload', W - 28, 12);
  }

  function loadBandwidth() {
    showLoader('bwTop');
    api('/api/admin/bandwidth').then(function (d) {
      $('bwStatActive').textContent = d.activeNow;
      $('bwStatProfiles').textContent = d.totalProfiles;
      var totalBytes = d.totalBytesUsed || 0;
      $('bwStatTotalBytes').textContent = totalBytes > 1073741824 ? (totalBytes / 1073741824).toFixed(2) + ' GB' : totalBytes > 1048576 ? (totalBytes / 1048576).toFixed(0) + ' MB' : (totalBytes / 1024).toFixed(0) + ' KB';
      var totalQuota = d.totalQuota || 0;
      $('bwStatTotalQuota').textContent = totalQuota > 1073741824 ? (totalQuota / 1073741824).toFixed(2) + ' GB' : totalQuota > 1048576 ? (totalQuota / 1048576).toFixed(0) + ' MB' : (totalQuota / 1024).toFixed(0) + ' KB';

      drawBandwidthChart(d.hourly);

      // Hourly table
      if (d.hourly && d.hourly.length) {
        contents.bwHourly.innerHTML = renderTable(
          [
            { label: 'Hour', render: function (r) { return new Date(r.hour).toLocaleString(); } },
            { label: 'Up', render: function (r) {
              var b = parseInt(r.bytes_up) || 0;
              return b > 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(0) + ' MB' : (b / 1024).toFixed(0) + ' KB';
            }},
            { label: 'Down', render: function (r) {
              var b = parseInt(r.bytes_down) || 0;
              return b > 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(0) + ' MB' : (b / 1024).toFixed(0) + ' KB';
            }},
          ],
          d.hourly,
          'No bandwidth data yet.'
        );
      } else {
        contents.bwHourly.innerHTML = '<div class="table-empty"><p>No hourly bandwidth data yet.</p></div>';
      }
    }).catch(function () {});

    // Top users
    api('/api/admin/bandwidth/top-users').then(function (data) {
      var bwColumns = [
        { label: 'Name', render: function (r) { return '<span style="color:#fff;font-weight:600">' + escHtml(r.full_name) + '</span>'; } },
        { label: 'MAC', render: function (r) { return '<code>' + escHtml(r.mac_address || '—') + '</code>'; } },
        { label: 'Data Used', render: function (r) {
          var du = parseInt(r.data_used_bytes) || 0;
          return du > 1073741824 ? (du / 1073741824).toFixed(2) + ' GB' : du > 1048576 ? (du / 1048576).toFixed(0) + ' MB' : (du / 1024).toFixed(0) + ' KB';
        }},
        { label: 'BW Up', key: 'bandwidth_up_kbps', render: function (r) { return r.bandwidth_up_kbps ? (r.bandwidth_up_kbps / 1000).toFixed(1) + ' Mbps' : '—'; } },
        { label: 'BW Down', key: 'bandwidth_down_kbps', render: function (r) { return r.bandwidth_down_kbps ? (r.bandwidth_down_kbps / 1000).toFixed(1) + ' Mbps' : '—'; } },
        { label: 'Session', render: function (r) { return fmtDate(r.session_start); } },
        { label: 'Uncapped', render: function (r) { return fmtBool(r.is_uncapped); } },
      ];
      contents.bwTop.innerHTML = renderTable(bwColumns, data, 'No active sessions with bandwidth data.');
      hideLoader('bwTop');
    }).catch(function () { hideLoader('bwTop'); });
  }

  /* ── Peak Hours Analytics ── */
  function drawPeakHourChart(data) {
    var canvas = $('peakHourChart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!data || !data.signupHours || data.signupHours.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '12px Montserrat, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No peak hour data yet', W / 2, H / 2);
      return;
    }

    var pad = { top: 10, right: 10, bottom: 30, left: 35 };
    var chartW = W - pad.left - pad.right;
    var chartH = H - pad.top - pad.bottom;

    var signupMap = {};
    data.signupHours.forEach(function (r) { signupMap[r.hour] = r.count; });
    var accessMap = {};
    data.accessHours.forEach(function (r) { accessMap[r.hour] = r.count; });

    var maxVal = 1;
    var values = [];
    for (var h = 0; h < 24; h++) {
      var su = signupMap[h] || 0;
      var ac = accessMap[h] || 0;
      maxVal = Math.max(maxVal, su, ac);
      values.push({ hour: h, signups: su, access: ac });
    }
    maxVal = Math.ceil(maxVal / 2) * 2 || 2;
    var barW = (chartW / 24) * 0.4;
    var gap = chartW / 24;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var y = pad.top + chartH - (chartH * g / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '9px Montserrat, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxVal * g / 4), pad.left - 6, y + 3);
    }

    values.forEach(function (v) {
      var x = pad.left + v.hour * gap;

      // Signup bar (pink)
      var suH = (v.signups / maxVal) * chartH;
      var suY = pad.top + chartH - suH;
      var grad = ctx.createLinearGradient(0, suY, 0, pad.top + chartH);
      grad.addColorStop(0, '#ff00ff');
      grad.addColorStop(1, 'rgba(255,0,255,0.1)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, suY, barW, suH);

      // Access bar (cyan) - offset by barW
      var acH = (v.access / maxVal) * chartH;
      var acY = pad.top + chartH - acH;
      var grad2 = ctx.createLinearGradient(0, acY, 0, pad.top + chartH);
      grad2.addColorStop(0, '#00d4ff');
      grad2.addColorStop(1, 'rgba(0,212,255,0.1)');
      ctx.fillStyle = grad2;
      ctx.fillRect(x + barW, acY, barW, acH);

      // Hour label (every 3)
      if (v.hour % 3 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '8px Montserrat, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(v.hour + ':00', x + barW, pad.top + chartH + 16);
      }
    });

    // Legend
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(W - 110, 4, 8, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '8px Montserrat, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Signups', W - 98, 12);
    ctx.fillStyle = '#00d4ff';
    ctx.fillRect(W - 40, 4, 8, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('Access', W - 28, 12);
  }

  function loadPeakHours() {
    api('/api/admin/peak-hours').then(function (d) {
      // Find peak hours
      var peakSignup = 0, peakAccess = 0;
      var maxSu = 0, maxAc = 0;
      (d.signupHours || []).forEach(function (r) {
        if (r.count > maxSu) { maxSu = r.count; peakSignup = r.hour; }
      });
      (d.accessHours || []).forEach(function (r) {
        if (r.count > maxAc) { maxAc = r.count; peakAccess = r.hour; }
      });
      $('peakSignupHour').textContent = peakSignup + ':00' + (maxSu ? ' (' + maxSu + ')' : '');
      $('peakAccessHour').textContent = peakAccess + ':00' + (maxAc ? ' (' + maxAc + ')' : '');

      var avgDaily = 0;
      if (d.dailyPeaks && d.dailyPeaks.length) {
        avgDaily = Math.round(d.dailyPeaks.reduce(function (s, r) { return s + r.signups; }, 0) / d.dailyPeaks.length);
      }
      $('peakAvgDaily').textContent = avgDaily;

      drawPeakHourChart(d);

      // Hourly signup table
      if (d.signupHours && d.signupHours.length) {
        contents.peakSignup.innerHTML = renderTable(
          [
            { label: 'Hour (24h)', render: function (r) { return r.hour + ':00'; } },
            { label: 'Signups', key: 'count' },
          ],
          d.signupHours,
          'No signup data.'
        );
      } else {
        contents.peakSignup.innerHTML = '<div class="table-empty"><p>No signup data yet.</p></div>';
      }

      // Daily peaks table
      if (d.dailyPeaks && d.dailyPeaks.length) {
        contents.peakDaily.innerHTML = renderTable(
          [
            { label: 'Date', render: function (r) { return new Date(r.day).toLocaleDateString(); } },
            { label: 'Signups', key: 'signups' },
          ],
          d.dailyPeaks,
          'No daily data.'
        );
      } else {
        contents.peakDaily.innerHTML = '<div class="table-empty"><p>No daily data yet.</p></div>';
      }
    }).catch(function () {});
  }

  /* ── Alerts ── */
  function loadAlerts() {
    showLoader('alert');
    api('/api/admin/alerts').then(function (d) {
      var counts = {};
      (d.counts || []).forEach(function (c) { counts[c.severity] = c.count; });
      $('alertCountCritical').textContent = counts.critical || 0;
      $('alertCountWarning').textContent = counts.warning || 0;
      $('alertCountInfo').textContent = counts.info || 0;
      $('alertCountPending').textContent = d.totalUnacknowledged;

      // Update badge in nav
      var badge = $('alertBadge');
      if (d.totalUnacknowledged > 0) {
        badge.textContent = d.totalUnacknowledged;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }

      // Show ack all button
      var ackBtn = $('ackAllAlertsBtn');
      if (d.active && d.active.length > 0) {
        ackBtn.style.display = '';
      } else {
        ackBtn.style.display = 'none';
      }

      var sectionMap = { voucher_approval: 'vouchers', cash_handover: 'reports', ap_device: 'ap-health' };

      // Active alerts table
      var alertColumns = [
        { label: 'Severity', render: function (r) {
          if (r.severity === 'critical') return '<span class="badge badge--no">Critical</span>';
          if (r.severity === 'warning') return '<span class="badge badge--warn">Warning</span>';
          return '<span class="badge badge--yes">Info</span>';
        }},
        { label: 'Type', key: 'type' },
        { label: 'Title', render: function (r) { return '<span style="color:#fff;font-weight:600">' + escHtml(r.title) + '</span>'; } },
        { label: 'Message', key: 'message', render: function (r) { return r.message || '<span class="muted">—</span>'; } },
        { label: 'Target', key: 'target_type', render: function (r) { return r.target_type ? r.target_type + (r.target_id ? ': ' + r.target_id.slice(0, 8) + '...' : '') : '<span class="muted">—</span>'; } },
        { label: 'Time', render: function (r) { return fmtDate(r.created_at); } },
        { label: '', render: function (r) {
          if (r.acknowledged) return '<span class="muted">Acknowledged</span>';
          return '<button class="btn-action btn-action--approve ack-alert-btn" data-alert-id="' + r.id + '" title="Acknowledge"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 10 8 14 16 6"/></svg> Ack</button>';
        }},
      ];
      contents.alert.innerHTML = renderTable(alertColumns, d.active, 'No active alerts.');

      // Make rows clickable to navigate to target section
      contents.alert.querySelectorAll('.data-table tbody tr').forEach(function (row, i) {
        row.style.cursor = 'pointer';
        row.sectionIndex = i;
        row.addEventListener('click', function () {
          var alertData = d.active && d.active[row.sectionIndex];
          if (alertData && alertData.target_type && sectionMap[alertData.target_type]) {
            var targetLink = document.querySelector('.sidebar-link[data-section="' + sectionMap[alertData.target_type] + '"]');
            if (targetLink) targetLink.click();
          }
        });
      });

      // Bind acknowledge buttons
      Array.from(contents.alert.querySelectorAll('.ack-alert-btn')).forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = btn.getAttribute('data-alert-id');
          api('/api/admin/alerts/' + id + '/acknowledge', { method: 'POST' }).then(function () {
            toast('Alert acknowledged', 'success');
            loadAlerts();
          }).catch(function (err) {
            toast(err.error || 'Failed to acknowledge', 'error');
          });
        });
      });

      // All alerts table
      var allColumns = [
        { label: 'Severity', render: function (r) {
          if (r.severity === 'critical') return '<span class="badge badge--no">Critical</span>';
          if (r.severity === 'warning') return '<span class="badge badge--warn">Warning</span>';
          return '<span class="badge badge--yes">Info</span>';
        }},
        { label: 'Title', key: 'title', render: function (r) { return '<span style="color:#fff;font-weight:600">' + escHtml(r.title) + '</span>'; } },
        { label: 'Message', key: 'message', render: function (r) { return r.message || '<span class="muted">—</span>'; } },
        { label: 'Status', render: function (r) {
          return r.acknowledged ? '<span class="badge badge--yes">Done</span>' : '<span class="badge badge--no">Open</span>';
        }},
        { label: 'Time', render: function (r) { return fmtDate(r.created_at); } },
      ];
      contents.alertAll.innerHTML = renderTable(allColumns, d.all, 'No alerts.');

      hideLoader('alert');
    }).catch(function () { hideLoader('alert'); });
  }

  /* ── MAC Blacklist ── */
  function loadBlacklist() {
    showLoader('blacklist');
    api('/api/admin/blacklist').then(function (data) {
      $('macStatBlacklisted').textContent = data.length;
      contents.blacklist.innerHTML = renderTable(
        [
          { label: 'MAC Address', render: function (r) { return '<code>' + escHtml(r.mac_address) + '</code>'; } },
          { label: 'Reason', key: 'reason', render: function (r) { return r.reason || '<span class="muted">—</span>'; } },
          { label: 'Blocked By', key: 'blocked_by_name', render: function (r) { return r.blocked_by_name || '<span class="muted">—</span>'; } },
          { label: 'Date', render: function (r) { return fmtDate(r.created_at); } },
          { label: '', render: function (r) {
            return '<button class="btn-action btn-action--remove bl-remove-btn" data-bl-id="' + r.id + '" title="Unblock"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="4" x2="16" y2="16"/><line x1="16" y1="4" x2="4" y2="16"/></svg></button>';
          }},
        ],
        data,
        'No blacklisted MACs.'
      );
      // Bind remove
      Array.from(contents.blacklist.querySelectorAll('.bl-remove-btn')).forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = btn.getAttribute('data-bl-id');
          if (!confirm('Unblock this MAC?')) return;
          api('/api/admin/blacklist/' + id, { method: 'DELETE' }).then(function () {
            toast('MAC unblocked', 'success');
            loadBlacklist();
          }).catch(function (err) {
            toast(err.error || 'Failed to unblock', 'error');
          });
        });
      });
      hideLoader('blacklist');
    }).catch(function () { hideLoader('blacklist'); });
  }

  /* ── MAC Whitelist ── */
  function loadWhitelist() {
    showLoader('whitelist');
    api('/api/admin/whitelist').then(function (data) {
      $('macStatWhitelisted').textContent = data.length;
      contents.whitelist.innerHTML = renderTable(
        [
          { label: 'MAC Address', render: function (r) { return '<code>' + escHtml(r.mac_address) + '</code>'; } },
          { label: 'Label', key: 'label', render: function (r) { return r.label || '<span class="muted">—</span>'; } },
          { label: 'Added By', key: 'added_by_name', render: function (r) { return r.added_by_name || '<span class="muted">—</span>'; } },
          { label: 'Date', render: function (r) { return fmtDate(r.created_at); } },
          { label: '', render: function (r) {
            return '<button class="btn-action btn-action--remove wl-remove-btn" data-wl-id="' + r.id + '" title="Remove"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="4" x2="16" y2="16"/><line x1="16" y1="4" x2="4" y2="16"/></svg></button>';
          }},
        ],
        data,
        'No whitelisted MACs.'
      );
      Array.from(contents.whitelist.querySelectorAll('.wl-remove-btn')).forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = btn.getAttribute('data-wl-id');
          if (!confirm('Remove this MAC from whitelist?')) return;
          api('/api/admin/whitelist/' + id, { method: 'DELETE' }).then(function () {
            toast('MAC removed from whitelist', 'success');
            loadWhitelist();
          }).catch(function (err) {
            toast(err.error || 'Failed to remove', 'error');
          });
        });
      });
      hideLoader('whitelist');
    }).catch(function () { hideLoader('whitelist'); });
  }

  /* ── My Sales (Staff) ── */
  function loadMySales() {
    showLoader('my-sales');
    api('/api/admin/my-sales').then(function (data) {
      $('mySalesTotal').textContent = '$' + data.totalAmount.toFixed(2);
      $('mySalesCount').textContent = data.totalSales;
      contents['my-sales'].innerHTML = renderTable(
        [
          { label: 'Code', key: 'code', render: function (r) { return '<span class="code-cell-sm">' + r.code + '</span>'; } },
          { label: 'Price', render: function (r) { return r.price_amount ? '$' + parseFloat(r.price_amount).toFixed(2) : '<span class="muted">—</span>'; } },
          { label: 'Duration', key: 'duration_min', render: function (r) { return fmtDur(r.duration_min); } },
          { label: 'Bandwidth (↑/↓)', render: function (r) { return fmtBw(r); } },
          { label: 'Data', render: function (r) { return fmtData(r); } },
          { label: 'Used', key: 'used_count' },
          { label: 'Created', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
        ],
        data.sales,
        'No sales recorded yet.'
      );
      hideLoader('my-sales');
      loadHandoverReadySales();
      loadHandoverHistory();
    }).catch(function () { hideLoader('my-sales'); });
  }

  /* ── Cash Handover ── */
  var selectedHandoverSales = [];

  function loadHandoverReadySales() {
    if (!user || user.role !== 'Staff') return;
    api('/api/admin/cash-handovers/available-sales').then(function (data) {
      var card = $('handoverReadyCard');
      var amtEl = $('handoverReadyAmount');
      var section = $('handoverSection');
      if (data.count > 0) {
        card.style.display = '';
        amtEl.textContent = '$' + data.totalAvailable.toFixed(2) + ' (' + data.count + ' sales)';
        section.classList.remove('hidden');
        // Add checkboxes to the sales table
        loadHandoverCheckboxes(data.sales);
      } else {
        card.style.display = 'none';
        section.classList.add('hidden');
      }
    }).catch(function () {});
  }

  function loadHandoverCheckboxes(sales) {
    var tableContent = $('mySalesTableContent');
    if (!tableContent) return;
    // Add checkbox column to the existing table
    var headerRow = tableContent.querySelector('thead tr');
    if (headerRow) {
      var existing = headerRow.querySelector('.handover-check-hdr');
      if (!existing) {
        var th = document.createElement('th');
        th.className = 'handover-check-hdr';
        th.textContent = 'H/O';
        headerRow.insertBefore(th, headerRow.firstChild);
      }
    }
    var rows = tableContent.querySelectorAll('tbody tr');
    var btn = $('handoverCashBtn');
    selectedHandoverSales = [];
    btn.disabled = true;

    rows.forEach(function (row) {
      var codeCell = row.querySelector('td');
      if (!codeCell) return;
      var code = codeCell.textContent.trim();
      var sale = sales.find(function (s) { return s.voucher_code === code; });
      if (sale) {
        var td = document.createElement('td');
        td.style.width = '2rem';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'handover-checkbox';
        cb.dataset.saleId = sale.id;
        cb.addEventListener('change', function () {
          if (this.checked) {
            selectedHandoverSales.push(this.dataset.saleId);
          } else {
            selectedHandoverSales = selectedHandoverSales.filter(function (id) { return id !== this.dataset.saleId; }.bind(this));
          }
          btn.disabled = selectedHandoverSales.length === 0;
        });
        td.appendChild(cb);
        row.insertBefore(td, row.firstChild);
      }
    });
  }

  // Bind handover button
  var handoverBtn = $('handoverCashBtn');
  if (handoverBtn) {
    handoverBtn.addEventListener('click', function () {
      if (selectedHandoverSales.length === 0) { toast('Select sales to hand over', 'error'); return; }
      handoverBtn.disabled = true;
      handoverBtn.innerHTML = '<div class="btn-spinner"></div> Submitting...';
      api('/api/admin/cash-handovers', {
        method: 'POST',
        body: JSON.stringify({ saleIds: selectedHandoverSales })
      }).then(function (data) {
        toast(data.message, 'success');
        selectedHandoverSales = [];
        loadMySales();
        loadHandoverReadySales();
        loadHandoverHistory();
      }).catch(function (err) {
        toast(err.error || 'Failed to submit handover', 'error');
      }).finally(function () {
        handoverBtn.disabled = false;
        handoverBtn.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="8" y1="8" x2="14" y2="8"/><line x1="6" y1="14" x2="6" y2="14.01"/></svg> Hand Over Cash';
      });
    });
  }

  function loadHandoverHistory() {
    var container = $('handoverHistory');
    if (!container) return;
    api('/api/admin/cash-handovers/my').then(function (data) {
      if (!data || data.length === 0) {
        container.innerHTML = '';
        return;
      }
      var rows = data.map(function (h) {
        var statusClass = h.status === 'approved' ? 'badge--yes' : (h.status === 'rejected' ? 'badge--no' : 'badge--warn');
        return '<tr><td>' + fmtDate(h.created_at) + '</td><td>$' + parseFloat(h.total_amount).toFixed(2) + '</td><td>' + h.sale_count + '</td><td><span class="badge ' + statusClass + '">' + h.status + '</span></td></tr>';
      }).join('');
      container.innerHTML = '<div class="section-head" style="margin-top:1rem;"><h3 class="section-head-title" style="font-size:0.9rem;">Handover History</h3></div><div class="card card-table" style="padding:0;"><table class="data-table"><thead><tr><th>Date</th><th>Amount</th><th>Sales</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }).catch(function () {});
  }

  /* ── Voucher Approval Requests ── */

  function loadPendingApprovals() {
    if (!user || user.role === 'Staff') return;
    var container = $('pendingApprovalsContainer');
    var content = $('pendingApprovalsContent');
    if (!container || !content) return;
    showLoader('pendingApprovals');
    container.classList.remove('hidden');
    api('/api/admin/vouchers/pending-approvals').then(function (data) {
      if (!data || data.length === 0) {
        container.classList.add('hidden');
        return;
      }
      container.classList.remove('hidden');
      content.innerHTML = renderTable(
        [
          { label: 'Staff', key: 'requested_by_name' },
          { label: 'Type', key: 'request_type' },
          { label: 'Package', key: 'package_tier' },
          { label: 'Count', key: 'voucher_count' },
          { label: 'Price', render: function (r) { return r.price_amount ? '$' + parseFloat(r.price_amount).toFixed(2) : '<span class="muted">—</span>'; } },
          { label: 'Requested', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
          { label: 'Actions', render: function (r) {
            return '<button class="btn-action btn-action--approve approve-request-btn" data-id="' + r.id + '" title="Approve">✓ Approve</button> ' +
                   '<button class="btn-action btn-action--reject reject-request-btn" data-id="' + r.id + '" title="Reject">✗ Reject</button>';
          }},
        ],
        data,
        'No pending approvals.'
      );
      hideLoader('pendingApprovals');

      // Bind approve/reject buttons
      content.querySelectorAll('.approve-request-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = this.dataset.id;
          api('/api/admin/vouchers/approvals/' + id + '/approve', { method: 'POST' }).then(function (d) {
            toast(d.message, 'success');
            loadPendingApprovals();
            loadVouchers();
          }).catch(function (err) { toast(err.error || 'Failed to approve', 'error'); });
        });
      });
      content.querySelectorAll('.reject-request-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = this.dataset.id;
          api('/api/admin/vouchers/approvals/' + id + '/reject', { method: 'POST' }).then(function () {
            toast('Request rejected', 'info');
            loadPendingApprovals();
          }).catch(function (err) { toast(err.error || 'Failed to reject', 'error'); });
        });
      });
    }).catch(function () { hideLoader('pendingApprovals'); });
  }

  function loadMyApprovals() {
    if (!user || user.role !== 'Staff') return;
    var container = $('myApprovalsContainer');
    var content = $('myApprovalsContent');
    if (!container || !content) return;
    showLoader('myApprovals');
    container.classList.remove('hidden');
    api('/api/admin/vouchers/my-approvals').then(function (data) {
      if (!data || data.length === 0) {
        container.classList.add('hidden');
        hideLoader('myApprovals');
        return;
      }
      container.classList.remove('hidden');
      content.innerHTML = renderTable(
        [
          { label: 'Type', key: 'request_type' },
          { label: 'Package', key: 'package_tier' },
          { label: 'Count', key: 'voucher_count' },
          { label: 'Price', render: function (r) { return r.price_amount ? '$' + parseFloat(r.price_amount).toFixed(2) : '<span class="muted">—</span>'; } },
          { label: 'Status', render: function (r) {
            var cls = r.status === 'approved' ? 'badge--yes' : (r.status === 'rejected' ? 'badge--no' : 'badge--warn');
            return '<span class="badge ' + cls + '">' + r.status + '</span>';
          }},
          { label: 'Date', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
          { label: 'Codes', render: function (r) {
            if (r.status !== 'approved' || !r.voucher_data || !r.voucher_data.codes) return '<span class="muted">—</span>';
            return r.voucher_data.codes.map(function (c) {
              return '<span style="display:inline-block;font-family:monospace;font-size:0.8rem;color:var(--accent-cyan);background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:4px;padding:0.1rem 0.4rem;margin:0.1rem;">' + c + '</span>';
            }).join('') +
            '<button class="btn-action btn-action--download download-approved-btn" style="margin-left:0.5rem;" data-codes="' + r.voucher_data.codes.join(',') + '">Download</button>';
          }},
        ],
        data,
        'No approval requests yet.'
      );
      hideLoader('myApprovals');

      // Bind download buttons
      content.querySelectorAll('.download-approved-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var codes = this.dataset.codes.split(',');
          // Try to find vouchers by code and download each
          codes.forEach(function (code, i) {
            setTimeout(function () {
              downloadVoucherCard({ code: code.trim(), package_tier: '' });
            }, i * 400);
          });
        });
      });
    }).catch(function () { hideLoader('myApprovals'); });
  }

  /* ── Pending Cash Handovers (Manager/CEO) ── */

  function loadPendingHandovers() {
    if (!user || user.role === 'Staff') return;
    var container = $('pendingHandoversContainer');
    var content = $('pendingHandoversContent');
    if (!container || !content) return;
    showLoader('pendingHandovers');
    api('/api/admin/cash-handovers/pending').then(function (data) {
      if (!data || data.length === 0) {
        container.classList.add('hidden');
        hideLoader('pendingHandovers');
        return;
      }
      container.classList.remove('hidden');
      content.innerHTML = renderTable(
        [
          { label: 'Staff', key: 'staff_name' },
          { label: 'Amount', render: function (r) { return '$' + parseFloat(r.total_amount).toFixed(2); } },
          { label: 'Sales', key: 'sale_count' },
          { label: 'Date', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
          { label: 'Actions', render: function (r) {
            return '<button class="btn-action btn-action--approve approve-handover-btn" data-id="' + r.id + '">✓ Approve</button> ' +
                   '<button class="btn-action btn-action--reject reject-handover-btn" data-id="' + r.id + '">✗ Reject</button>';
          }},
        ],
        data,
        'No pending handovers.'
      );
      hideLoader('pendingHandovers');

      content.querySelectorAll('.approve-handover-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = this.dataset.id;
          api('/api/admin/cash-handovers/' + id + '/approve', { method: 'POST' }).then(function (d) {
            toast(d.message, 'success');
            loadPendingHandovers();
            loadRevenue();
          }).catch(function (err) { toast(err.error || 'Failed to approve', 'error'); });
        });
      });
      content.querySelectorAll('.reject-handover-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = this.dataset.id;
          api('/api/admin/cash-handovers/' + id + '/reject', { method: 'POST' }).then(function () {
            toast('Handover rejected', 'info');
            loadPendingHandovers();
          }).catch(function (err) { toast(err.error || 'Failed to reject', 'error'); });
        });
      });
    }).catch(function () { hideLoader('pendingHandovers'); });
  }

  /* ── Time & Attendance ── */
  var clockInterval = null;

  function loadTimeSection() {
    loadClockStatus();
    loadTimeLogs();
  }

  function loadClockStatus() {
    api('/api/admin/clock-status').then(function (data) {
      var statusEl = $('clockStatusText');
      var sinceEl = $('clockActiveSince');
      if (data.clockedIn && data.log) {
        statusEl.textContent = 'Clocked In';
        statusEl.style.color = '#71ff2f';
        var start = new Date(data.log.clock_in);
        sinceEl.textContent = 'Since ' + start.toLocaleTimeString();
        sinceEl.classList.remove('hidden');
        $('clockInBtn').disabled = true;
        $('clockOutBtn').disabled = false;
        if (clockInterval) clearInterval(clockInterval);
        clockInterval = setInterval(function () {
          var mins = Math.round((Date.now() - start.getTime()) / 60000);
          sinceEl.textContent = 'Since ' + start.toLocaleTimeString() + ' (' + mins + ' min)';
        }, 30000);
      } else {
        statusEl.textContent = 'Clocked Out';
        statusEl.style.color = '#94a3b8';
        sinceEl.classList.add('hidden');
        $('clockInBtn').disabled = false;
        $('clockOutBtn').disabled = true;
        if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
      }
    }).catch(function () {});
  }

  function loadTimeLogs() {
    var isMgmt = user && (user.role === 'CEO' || user.role === 'Manager');
    showLoader('timeLogs');
    showLoader('timeSummary');
    api('/api/admin/time-logs').then(function (data) {
      $('timeSummaryDesc').textContent = isMgmt ? 'All staff time summary' : 'Your time logs';

      // Summary table
      var summaryRows = data.summary && data.summary.length ? data.summary : [];
      if (isMgmt && summaryRows.length) {
        $('timeSummaryContent').innerHTML = renderTable(
          [
            { label: 'Staff', key: 'full_name' },
            { label: 'Role', key: 'role' },
            { label: 'Total Shifts', key: 'total_shifts' },
            { label: 'Total Hours', render: function (r) { return (r.total_minutes / 60).toFixed(1) + 'h'; } },
          ],
          summaryRows,
          'No time data yet.'
        );
      } else if (!isMgmt) {
        var ownSummary = data.logs.reduce(function (acc, r) {
          acc.totalShifts++;
          acc.totalMinutes += r.duration_min || 0;
          return acc;
        }, { totalShifts: 0, totalMinutes: 0 });
        $('timeSummaryContent').innerHTML = renderTable(
          [
            { label: 'Metric', render: function () { return 'Total Shifts'; }, key2: 'value' },
          ],
          [{ Metric: 'Total Shifts', value: ownSummary.totalShifts }, { Metric: 'Total Hours', value: (ownSummary.totalMinutes / 60).toFixed(1) + 'h' }],
          'No time data yet.'
        );
        // Hmm, renderTable expects objects. Let me use a simpler approach.
        $('timeSummaryContent').innerHTML = '<div class="table-empty"><p>Total Shifts: ' + ownSummary.totalShifts + ' &middot; Total Hours: ' + (ownSummary.totalMinutes / 60).toFixed(1) + 'h</p></div>';
      } else {
        $('timeSummaryContent').innerHTML = '<div class="table-empty"><p>No time data yet.</p></div>';
      }

      // Detail logs table
      var cols = [
        { label: 'Staff', key: 'full_name', render: function (r) { return r.full_name || 'You'; } },
        { label: 'Clock In', key: 'clock_in', render: function (r) { return fmtDate(r.clock_in); } },
        { label: 'Clock Out', key: 'clock_out', render: function (r) { return r.clock_out ? fmtDate(r.clock_out) : '<span style="color:#71ff2f">Active</span>'; } },
        { label: 'Duration', render: function (r) { return r.duration_min != null ? r.duration_min + ' min' : (r.clock_out ? '—' : '<span style="color:#71ff2f">In progress</span>'); } },
      ];
      $('timeLogsContent').innerHTML = renderTable(cols, data.logs, 'No time logs recorded.');
      hideLoader('timeLogs');
      hideLoader('timeSummary');
    }).catch(function () { hideLoader('timeLogs'); hideLoader('timeSummary'); });
  }

  function handleClockIn() {
    api('/api/admin/clock-in', { method: 'POST' }).then(function () {
      toast('Clocked in successfully', 'success');
      loadClockStatus();
      loadTimeLogs();
    }).catch(function (err) {
      toast(err.error || 'Failed to clock in', 'error');
    });
  }

  function handleClockOut() {
    api('/api/admin/clock-out', { method: 'POST' }).then(function () {
      toast('Clocked out successfully', 'success');
      loadClockStatus();
      loadTimeLogs();
    }).catch(function (err) {
      toast(err.error || 'Failed to clock out', 'error');
    });
  }

  /* ── Staff Management ── */
  function loadStaffManagement() {
    // Load pending approvals
    showLoader('pendingStaff');
    api('/api/admin/staff-pending').then(function (data) {
      contents.pendingStaff.innerHTML = renderTable(
        [
          { label: 'Name', key: 'full_name' },
          { label: 'Email', key: 'email' },
          { label: 'Phone', key: 'phone' },
          { label: 'Requested', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
          {
            label: 'Actions',
            render: function (r) {
              return '<div class="action-btns">' +
                '<button class="btn-action btn-action--approve" data-staff-id="' + r.id + '" title="Approve"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 10 8 14 16 6"/></svg> Approve</button>' +
                '<button class="btn-action btn-action--reject" data-staff-id="' + r.id + '" title="Reject"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="4" x2="16" y2="16"/><line x1="16" y1="4" x2="4" y2="16"/></svg> Reject</button>' +
                '</div>';
            },
          },
        ],
        data,
        'No pending staff approvals.'
      );
      hideLoader('pendingStaff');
      bindStaffActions();
    }).catch(function () { hideLoader('pendingStaff'); });

    // Load staff status (online/offline)
    api('/api/admin/staff-status').then(function (statusData) {
      var statusMap = {};
      if (statusData && statusData.statuses) {
        statusData.statuses.forEach(function (s) { statusMap[s.id] = s; });
      }
      // Load all staff accounts
      showLoader('staff');
      api('/api/admin/staff').then(function (data) {
        var isCeo = user && user.role === 'CEO';
        // Merge status into staff data
        data = data.map(function (r) {
          var st = statusMap[r.id] || {};
          r._online = st.is_online || false;
          r._clockIn = st.clock_in || null;
          return r;
        });
        contents.staff.innerHTML = renderTable(
        [
          { label: 'Name', key: 'full_name' },
          { label: 'Email', key: 'email' },
          { label: 'Phone', key: 'phone' },
          {
            label: 'Online',
            render: function (r) {
              if (!r.approved) return '<span class="badge badge--no">Inactive</span>';
              return r._online
                ? '<span class="badge badge--yes" style="position:relative;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#00e676;margin-right:4px;animation:pulse-dot 1.5s ease-in-out infinite;"></span>Online</span>'
                : '<span class="badge badge--no">Offline</span>';
            },
          },
          { label: 'Since', render: function (r) {
            return r._clockIn && r._online ? fmtDate(r._clockIn) : '—';
          } },
          { label: 'Created', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
          {
            label: 'Actions',
            render: function (r) {
              var toggleIcon = r.approved
                ? '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="7"/><line x1="6" y1="10" x2="14" y2="10"/></svg> Deactivate'
                : '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="7"/><line x1="10" y1="6" x2="10" y2="14"/><line x1="6" y1="10" x2="14" y2="10"/></svg> Activate';
              var toggleAction = r.approved ? 'deactivate' : 'activate';
              var btns = '<div class="action-btns">' +
                '<button class="btn-action btn-action--' + toggleAction + '" data-staff-id="' + r.id + '" data-action="' + toggleAction + '">' + toggleIcon + '</button>' +
                '<button class="btn-action btn-action--remove" data-staff-id="' + r.id + '" data-action="remove" title="Remove"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Remove</button>';
              if (isCeo && r.approved) {
                btns += '<button class="btn-action btn-action--ceo" data-promote-id="' + r.id + '" title="Promote to Manager"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 17v-1a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v1"/><circle cx="8" cy="6" r="3"/><polyline points="15 4 18 7 23 2"/></svg> Promote</button>';
              }
              btns += '</div>';
              return btns;
            },
          },
        ],
        data,
        'No staff accounts found.'
      );
      hideLoader('staff');
      bindStaffActions();
    }).catch(function () { hideLoader('staff'); });

    // Load managers for CEO view
    if (user && user.role === 'CEO') {
      api('/api/admin/managers').then(function (data) {
        if (data.length === 0) return;
        var mgrHtml = '<div class="section-head" style="margin-top:1.5rem;"><h3 class="section-head-title" style="font-size:1rem;">Current Manager</h3></div>';
        mgrHtml += renderTable(
          [
            { label: 'Name', key: 'full_name' },
            { label: 'Email', key: 'email' },
            { label: 'Phone', key: 'phone' },
            { label: 'Status', key: 'approved', render: function (r) { return r.approved ? '<span class="badge badge--yes">Active</span>' : '<span class="badge badge--no">Inactive</span>'; } },
            {
              label: 'Actions',
              render: function (r) {
                return '<div class="action-btns">' +
                  '<button class="btn-action btn-action--deactivate" data-mgr-id="' + r.id + '" data-mgr-action="demote" title="Demote to Staff"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3v12M5 10l5 5 5-5"/></svg> Demote</button>' +
                  '<button class="btn-action btn-action--remove" data-mgr-id="' + r.id + '" data-mgr-action="remove" title="Remove Manager"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Remove</button>' +
                  '</div>';
              },
            },
          ],
          data,
          'No manager assigned.'
        );
        // Append after staff table container
        var staffContainer = $('staffTableContainer');
        var existingMgr = staffContainer.querySelector('.manager-section');
        if (existingMgr) existingMgr.remove();
        var mgrDiv = document.createElement('div');
        mgrDiv.className = 'manager-section';
        mgrDiv.innerHTML = mgrHtml;
        staffContainer.appendChild(mgrDiv);
        // Bind manager actions
        document.querySelectorAll('[data-mgr-id]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.getAttribute('data-mgr-id');
            var action = btn.getAttribute('data-mgr-action');
            if (!confirm('Are you sure you want to ' + action + ' this Manager?')) return;
            api('/api/admin/manager-' + action + '/' + id, { method: 'POST' }).then(function (data) {
              toast(data.message, 'success');
              loadStaffManagement();
            }).catch(function (err) {
              toast(err.error || 'Action failed', 'error');
            });
          });
        });
      }).catch(function () {});
    }
  });
  }

  function bindStaffActions() {
    document.querySelectorAll('[data-staff-id]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-staff-id');
        var action = btn.getAttribute('data-action') || (btn.classList.contains('btn-action--approve') ? 'approve' : 'reject');
        if (action === 'remove' || action === 'reject') {
          if (!confirm('Are you sure you want to ' + action + ' this staff member?')) return;
        }
        var endpoint = '/api/admin/staff-' + action + '/' + id;
        api(endpoint, { method: 'POST' }).then(function (data) {
          toast(data.message || 'Action completed', 'success');
          loadStaffManagement();
        }).catch(function (err) {
          toast(err.error || 'Action failed', 'error');
        });
      });
    });

    // CEO-only: promote to Manager buttons
    document.querySelectorAll('[data-promote-id]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-promote-id');
        if (!confirm('Promote this staff member to Manager?')) return;
        api('/api/admin/manager-promote/' + id, { method: 'POST' }).then(function (data) {
          toast(data.message, 'success');
          loadStaffManagement();
        }).catch(function (err) {
          toast(err.error || 'Promotion failed', 'error');
        });
      });
    });
  }

  /* ── Settings (CEO only) ── */
  function loadSettings() {
    api('/api/admin/settings').then(function (data) {
      $('setTosText').value = data.tos_text || '';
      $('setSessionTimeout').value = data.session_timeout_min || '1440';
      $('setWelcomeMsg').value = data.welcome_message || '';
    }).catch(function () {});
    loadMaintenance();
    loadRetention();
    loadBranding();
  }

  var settingsForm = $('settingsForm');
  if (settingsForm) {
    settingsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {
        tos_text: $('setTosText').value,
        session_timeout_min: $('setSessionTimeout').value,
        welcome_message: $('setWelcomeMsg').value,
      };
      var btn = $('saveSettingsBtn');
      btn.disabled = true;
      btn.innerHTML = '<div class="btn-spinner"></div> Saving...';
      api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) }).then(function (data) {
        var status = $('settingsStatus');
        status.className = 'form-status form-status--success';
        status.textContent = data.message || 'Settings saved';
        status.classList.remove('hidden');
        toast('Settings saved', 'success');
      }).catch(function (err) {
        var status = $('settingsStatus');
        status.className = 'form-status form-status--error';
        status.textContent = err.error || 'Failed to save settings';
        status.classList.remove('hidden');
        toast(err.error || 'Failed to save settings', 'error');
      }).finally(function () {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 10 8 14 16 6"/></svg> Save Settings';
      });
    });
  }

  /* ── Audit Log (CEO only) ── */
  function loadAuditLog() {
    showLoader('auditLog');
    api('/api/admin/audit-log').then(function (data) {
      contents.auditLog.innerHTML = renderTable(
        [
          { label: 'Admin', key: 'admin_name', render: function (r) { return r.admin_name || '<span class="muted">System</span>'; } },
          { label: 'Action', key: 'action' },
          { label: 'Target', key: 'target_type', render: function (r) { return r.target_type ? r.target_type + (r.target_id ? ': ' + r.target_id.slice(0, 8) + '...' : '') : '<span class="muted">—</span>'; } },
          { label: 'Detail', key: 'detail', render: function (r) { return r.detail || '<span class="muted">—</span>'; } },
          { label: 'Time', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
        ],
        data,
        'No audit log entries yet.'
      );
      hideLoader('auditLog');
    }).catch(function () { hideLoader('auditLog'); });
  }

  /* ── CSV Export (CEO only) ── */
  var exportBtn = $('exportCsvBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      if (!token) { toast('Sign in first', 'error'); return; }
      var a = document.createElement('a');
      a.href = '/api/admin/revenue/export';
      // Fetch with auth to get CSV
      fetch('/api/admin/revenue/export', { headers: { 'Authorization': 'Bearer ' + token } }).then(function (r) {
        if (!r.ok) throw new Error('Export failed');
        return r.blob();
      }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        a.href = url;
        a.download = 'preyone-revenue-export.csv';
        a.click();
        URL.revokeObjectURL(url);
        toast('Revenue CSV downloaded', 'success');
      }).catch(function () {
        toast('Failed to export CSV', 'error');
      });
    });
  }

  /* ── Reports & Bookkeeping ── */
  function loadReports() {
    showLoader('revenueTier');
    showLoader('transactions');
    showLoader('staffSales');
    showLoader('allStaffSales');
    api('/api/admin/revenue').then(function (data) {
      $('revenueTotal').textContent = '$' + parseFloat(data.totalRevenue).toFixed(2);
      $('revenuePending').textContent = '$' + parseFloat(data.pendingRevenue).toFixed(2);

      contents.revenueTier.innerHTML = renderTable(
        [
          { label: 'Package Tier', key: 'package_tier' },
          { label: 'Transactions', key: 'count' },
          { label: 'Total Revenue', render: function (r) { return '$' + parseFloat(r.total).toFixed(2); } },
        ],
        data.byTier,
        'No completed transactions yet.'
      );
      hideLoader('revenueTier');

      contents.transactions.innerHTML = renderTable(
        [
          { label: 'User', key: 'user_name', render: function (r) { return r.user_name || '<span class="muted">—</span>'; } },
          { label: 'Package', key: 'package_tier' },
          { label: 'Amount', render: function (r) { return '$' + parseFloat(r.amount).toFixed(2); } },
          { label: 'Currency', key: 'currency' },
          { label: 'Status', render: function (r) { return r.status === 'completed' ? '<span class="badge badge--yes">Paid</span>' : '<span class="badge badge--no">' + r.status + '</span>'; } },
          { label: 'Date', key: 'completed_at', render: function (r) { return fmtDate(r.completed_at || r.created_at); } },
        ],
        data.recentTransactions,
        'No transactions yet.'
      );
      hideLoader('transactions');
    }).catch(function () {
      hideLoader('revenueTier');
      hideLoader('transactions');
    });

    // Load staff sales summary
    api('/api/admin/staff-sales').then(function (data) {
      contents.staffSales.innerHTML = renderTable(
        [
          { label: 'Staff Name', key: 'full_name' },
          { label: 'Vouchers Sold', key: 'total_sales' },
          { label: 'Total Amount', render: function (r) { return '$' + parseFloat(r.total_amount).toFixed(2); } },
        ],
        data.staffSummary,
        'No staff sales recorded yet.'
      );
      hideLoader('staffSales');

      contents.allStaffSales.innerHTML = renderTable(
        [
          { label: 'Staff', key: 'sold_by_name', render: function (r) { return r.sold_by_name || '<span class="muted">—</span>'; } },
          { label: 'Code', key: 'code', render: function (r) { return '<span class="code-cell-sm">' + r.code + '</span>'; } },
          { label: 'Price', render: function (r) { return r.price_amount ? '$' + parseFloat(r.price_amount).toFixed(2) : '<span class="muted">—</span>'; } },
          { label: 'Duration', key: 'duration_min', render: function (r) { return fmtDur(r.duration_min); } },
          { label: 'Used', key: 'used_count' },
          { label: 'Date', key: 'created_at', render: function (r) { return fmtDate(r.created_at); } },
        ],
        data.allSales,
        'No staff sales detail yet.'
      );
      hideLoader('allStaffSales');
    }).catch(function () {
      hideLoader('staffSales');
      hideLoader('allStaffSales');
    });
  }

  function loadAll() {
    clearTimers();
    var p1 = loadVouchers();
    var p2 = loadUsers();
    var p3 = loadLogs();
    var p4 = loadPackages();
    return Promise.all([p1, p2, p3, p4]).then(function () {
      loadOverview();
      loadChart();
      loadRevenue();
      if (user && (user.role === 'CEO' || user.role === 'Manager')) loadDashboardSales();
      startDashboardRefresh();
    });
  }

  /* ── Event listeners ── */
  logoutBtn.addEventListener('click', logout);

  refreshAllBtn.addEventListener('click', function () {
    if (!token) { toast('Connect first', 'error'); return; }
    loadAll().then(function () { toast('All data refreshed', 'success'); }).catch(function () {});
  });

  /* ── Packages ── */
  var packages = [];
  var selectedPkg = null;

  function generateCode(packageTier) {
    var slug = packageTier.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    var rand = '';
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (var i = 0; i < 4; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return slug + '-' + rand;
  }

  function fmtPkgDur(m) {
    if (m == null) return '—';
    if (m >= 43200) return Math.round(m / 43200) + 'mo';
    if (m >= 1440) return Math.round(m / 1440) + 'd';
    if (m >= 60) return Math.round(m / 60) + 'h';
    return m + 'm';
  }

  function fmtPkgBw(pkg) {
    var up = pkg.bandwidth_mbps_up, down = pkg.bandwidth_mbps_down;
    if (up === down) return up + 'Mbps';
    return up + '/' + down + 'Mbps';
  }

  function fmtPkgData(pkg) {
    if (pkg.is_uncapped) return 'Unlim';
    if (pkg.data_limit_gb != null) return pkg.data_limit_gb + 'GB';
    return '—';
  }

  function buildPkgCard(pkg) {
    var sel = selectedPkg && selectedPkg.tier_name === pkg.tier_name;
    var isCeo = user && user.role === 'CEO';
    var accent = isCeo ? 'rgba(255,215,0,0.3)' : 'rgba(255,0,255,0.3)';
    var accent2 = isCeo ? 'rgba(255,215,0,0.15)' : 'rgba(0,212,255,0.3)';
    return '<div class="package-card' + (sel ? ' package-card--selected' : '') + '" data-tier="' + pkg.tier_name + '">' +
      '<div class="pkg-check"><svg viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" stroke="#fff" stroke-width="2" fill="none"/></svg></div>' +
      '<div class="pkg-display">' + pkg.display_name + '</div>' +
      '<div class="pkg-tier">' + pkg.tier_name + '</div>' +
      '<div class="pkg-price-row">' +
        '<span class="pkg-price">$' + parseFloat(pkg.price_amount).toFixed(2) + '</span>' +
        '<span class="pkg-currency">' + pkg.billing_period + '</span>' +
      '</div>' +
      '<div class="pkg-badges">' +
        '<span class="pkg-badge"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="5"/><path d="M6 3v3l2 2"/></svg>' + fmtPkgDur(pkg.duration_min) + '</span>' +
        '<span class="pkg-badge"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 4h10M1 8h10"/><rect x="1" y="2" width="10" height="8" rx="1"/></svg>' + fmtPkgBw(pkg) + '</span>' +
        '<span class="pkg-badge"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="1" width="8" height="10" rx="1"/><path d="M2 5h8"/></svg>' + fmtPkgData(pkg) + '</span>' +
      '</div>' +
    '</div>';
  }

  function loadPackages() {
    return api('/api/admin/packages').then(function (data) {
      packages = data;
      var grid = $('packageGrid');
      grid.innerHTML = data.map(buildPkgCard).join('');
      // Click handler
      Array.from(grid.children).forEach(function (card) {
        card.addEventListener('click', function (e) {
          var tier = card.getAttribute('data-tier');
          selectPackage(tier);
        });
      });
      // Populate bulk tier dropdown
      var bulkSelect = $('bulkTier');
      if (bulkSelect) {
        bulkSelect.innerHTML = '<option value="">Select package...</option>' +
          data.map(function (p) { return '<option value="' + p.tier_name + '">' + p.display_name + ' (' + p.tier_name + ') - $' + parseFloat(p.price_amount).toFixed(2) + '</option>'; }).join('');
      }
    }).catch(function () {});
  }

  function selectPackage(tier) {
    var pkg = packages.find(function (p) { return p.tier_name === tier; });
    if (!pkg) return;
    selectedPkg = pkg;

    // Update cards
    var grid = $('packageGrid');
    Array.from(grid.children).forEach(function (c) {
      c.classList.toggle('package-card--selected', c.getAttribute('data-tier') === tier);
    });

    // Update code bar
    $('vcbPkgBadge').textContent = pkg.tier_name;
    $('vCode').value = generateCode(tier);
    $('vCodeErr').textContent = '';

    // Only PreBIZ/PreMAX/PreULTRA/PreEXECUTIVE allow max uses selection
    var allowed = ['PreBIZ', 'PreMAX', 'PreULTRA', 'PreEXECUTIVE'];
    var usesInput = $('vUses');
    if (allowed.indexOf(tier) !== -1) {
      usesInput.disabled = false;
    } else {
      usesInput.disabled = true;
      usesInput.value = '1';
    }
  }

  /* ── Regenerate code ── */
  $('regenerateCodeBtn').addEventListener('click', function () {
    if (!selectedPkg) { toast('Select a package first', 'info'); return; }
    $('vCode').value = generateCode(selectedPkg.tier_name);
  });

  /* ── Voucher Card ── */
  function fmtDataSimple(r) {
    if (r.is_uncapped) return 'Unlimited';
    if (r.data_limit_gb != null) return r.data_limit_gb + ' GB';
    return 'Unlimited';
  }

  function fmtBwSimple(r) {
    return r.bandwidth_mbps_up + ' Mbps';
  }

  function fmtDurLong(m) {
    if (m == null) return '—';
    if (m >= 43200) return Math.round(m / 43200) + ' MONTH' + (Math.round(m / 43200) > 1 ? 'S' : '') + ' UNLIMITED SESSION';
    if (m >= 1440) return Math.round(m / 1440) + ' DAY' + (Math.round(m / 1440) > 1 ? 'S' : '') + ' UNLIMITED SESSION';
    if (m >= 60) return Math.round(m / 60) + ' HOUR' + (Math.round(m / 60) > 1 ? 'S' : '') + ' SESSION';
    return m + ' MIN SESSION';
  }

  function fmtDurShort(m) {
    if (m == null) return '—';
    if (m >= 43200) { var vm = Math.round(m / 43200); return vm + ' Month' + (vm > 1 ? 's' : ''); }
    if (m >= 1440) { var vd = Math.round(m / 1440); return vd + ' Day' + (vd > 1 ? 's' : ''); }
    if (m >= 60) { var vh = Math.round(m / 60); return vh + ' Hour' + (vh > 1 ? 's' : ''); }
    return m + ' Min';
  }

  function fmtEntitlement(m) {
    if (m == null) return 'Internet Access';
    if (m >= 43200) return Math.round(m / 43200) + ' Month' + (Math.round(m / 43200) > 1 ? 's' : '') + ' Unlimited Internet Access';
    if (m >= 1440) return Math.round(m / 1440) + ' Day' + (Math.round(m / 1440) > 1 ? 's' : '') + ' Unlimited Internet Access';
    if (m >= 60) return Math.round(m / 60) + ' Hour' + (Math.round(m / 60) > 1 ? 's' : '') + ' Internet Access';
    return m + ' Min Internet Access';
  }

  function voucherSerial(code) {
    var h = 0;
    for (var i = 0; i < code.length; i++) { h = ((h << 5) - h) + code.charCodeAt(i); h |= 0; }
    var num = ((h & 0x7FFFFFFF) % 90000) + 10000;
    return 'SN: ' + new Date().getFullYear() + '-' + num + '-' + code.slice(0, 1).toUpperCase();
  }

  function calcValidUntil(data) {
    if (data.expires_at) return new Date(data.expires_at).toISOString().split('T')[0];
    var d = new Date();
    d.setMinutes(d.getMinutes() + (data.duration_min || 60));
    return d.toISOString().split('T')[0];
  }

  function fmtPkgDesc(data) {
    var parts = [];
    if (data.bandwidth_mbps_up) parts.push(data.bandwidth_mbps_up + ' Mbps');
    parts.push('UltraNet');
    if (data.duration_min >= 43200) parts.push('Monthly');
    else if (data.duration_min >= 1440) parts.push('Daily');
    else parts.push('Flex');
    parts.push('Package');
    return parts.join(' ');
  }

  function buildBarcodeHtml() {
    var bars = '';
    for (var i = 0; i < 16; i++) {
      var w = [2, 4, 1, 6, 3][i % 5];
      bars += '<span style="display:block;width:' + w + 'px;background:#1e293b;border-radius:1px;"></span>';
    }
    return bars;
  }

  function showVoucherCard(data) {
    var container = $('voucherCardContainer');
    var tierText = data.package_tier || 'Custom';
    var priceText = data.price_amount ? '$' + parseFloat(data.price_amount).toFixed(2) : '';
    var codeSafe = data.code.replace(/'/g, "\\'");
    var bwVal = fmtBwSimple(data);
    var dataVal = fmtDataSimple(data);
    var durVal = fmtDurLong(data.duration_min);

    // WhatsApp text
    var waText = '*Preyone WiFi Voucher*%0A%0A' +
      'Code: `' + data.code + '`%0A' +
      'Package: ' + tierText + '%0A' +
      'Duration: ' + durVal + '%0A' +
      'Bandwidth: ' + bwVal + '%0A' +
      'Data: ' + dataVal +
      (priceText ? '%0APrice: ' + priceText : '') +
      '%0A%0A_Thank you for choosing Preyone_';

    var serial = voucherSerial(data.code);

    container.innerHTML =
      '<div class="voucher-card-wrap">' +
        '<div class="preyone-voucher">' +
          '<div class="brand-ribbon"><div class="ribbon-text">PREYONE WI-FI</div></div>' +
          '<div class="voucher-content">' +
            '<div class="voucher-header">' +
              '<div class="logo-group">' +
                '<h1>PREYONE</h1>' +
                '<p class="subtitle">ULTRANET CONNECTIVITY</p>' +
              '</div>' +
              '<div class="badge-container"><div class="access-badge">PREMIUM ACCESS</div></div>' +
            '</div>' +
            '<div class="specs-grid">' +
              '<div class="spec-block"><span class="spec-label">DATA PROFILE</span><span class="spec-value">' + dataVal + '</span></div>' +
              '<div class="spec-block text-right"><span class="spec-label">BANDWIDTH PROFILE</span><span class="spec-value">' + bwVal + '</span></div>' +
              '<div class="spec-block"><span class="spec-label">SALE PRICE</span><span class="spec-value">' + priceText + '</span></div>' +
              '<div class="spec-block text-right"><span class="spec-label">VALIDITY TIMELINE</span><span class="spec-value highlight-blue">' + durVal + '</span></div>' +
            '</div>' +
            '<div class="token-container">' +
              '<span class="token-title">WI-FI VOUCHER PIN</span>' +
              '<div class="token-box">' +
                '<span class="token-string" style="cursor:pointer" onclick="navigator.clipboard.writeText(\'' + codeSafe + '\').then(function(){toast(\'Copied ' + codeSafe + '\',\'success\')})">' + data.code + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="voucher-footer">' +
              '<div class="meta-terms">' +
                '<p class="infrastructure">Starlink Business Infrastructure Optimized</p>' +
                '<p class="support">Support Helpdesk: +263 771 327 202</p>' +
              '</div>' +
              '<div class="barcode-wrapper">' +
                '<div class="simulated-barcode" aria-hidden="true">' + buildBarcodeHtml() + '</div>' +
                '<span class="serial-no">' + serial + '</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="voucher-card-actions-bar">' +
           '<button class="btn-action btn-action--wa" id="waShareBtn" title="Share on WhatsApp">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>' +
            ' WhatsApp' +
          '</button>' +
          '<button class="btn-action btn-action--copy" onclick="navigator.clipboard.writeText(\'' + codeSafe + '\').then(function(){toast(\'Voucher code copied\',\'success\')})" title="Copy code">' +
            '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="13" height="15" rx="2"/><polyline points="2 5 2 18 15 18"/></svg>' +
            ' Copy' +
          '</button>' +
          '<button class="btn-action btn-action--download" id="downloadCardBtn" title="Download as image">' +
            '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3v12M5 10l5 5 5-5"/><path d="M3 16v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1"/></svg>' +
            ' Download' +
          '</button>' +
        '</div>' +
      '</div>';
    container.classList.remove('hidden');
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Bind download button
    setTimeout(function () {
      var dlBtn = $('downloadCardBtn');
      if (dlBtn) dlBtn.addEventListener('click', function () { downloadVoucherCard(data); });
      var waBtn = $('waShareBtn');
      if (waBtn) waBtn.addEventListener('click', function () {
        downloadVoucherCard(data);
        setTimeout(function () {
          window.open('https://wa.me/?text=' + waText, '_blank');
        }, 500);
      });
    }, 100);
  }

  function downloadVoucherCard(data) {
    var code = data.code || 'PREYONE-XXXX';
    var tierText = data.package_tier || 'Custom';
    var priceText = data.price_amount ? '$' + parseFloat(data.price_amount).toFixed(2) : '';
    var durShort = fmtDurShort(data.duration_min);
    var validUntil = calcValidUntil(data);
    var issuedByName = user && user.fullName ? user.fullName : 'Preyone UltraNet';
    var dataVal = data.is_uncapped ? 'UNCAPPED DATA' : (data.data_limit_gb != null ? data.data_limit_gb + ' GB' : 'UNLIMITED');
    var bwVal = data.bandwidth_mbps_up ? data.bandwidth_mbps_up + ' Mbps' : '—';
    var serial = voucherSerial(code);

    var W = 800, H = 450;
    var c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    var ctx = c.getContext('2d');

    // ── Cyberpunk border glow ──
    var bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, '#050604'); bgGrad.addColorStop(0.46, '#020202'); bgGrad.addColorStop(1, '#050506');
    ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);
    [ [[50, 40, 300], 'rgba(113,255,47,0.15)'],
      [[750, 50, 280], 'rgba(19,216,255,0.15)'],
      [[30, 400, 260], 'rgba(54,124,255,0.12)'],
      [[770, 380, 300], 'rgba(139,77,255,0.12)'] ].forEach(function (g) {
      var rg = ctx.createRadialGradient(g[0][0], g[0][1], 5, g[0][0], g[0][1], g[0][2]);
      rg.addColorStop(0, g[1]); rg.addColorStop(0.4, g[1]); rg.addColorStop(1, 'transparent');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    });

    // ── LEFT: Logo (aligned with ULTRANET) ──
    var logoG = ctx.createLinearGradient(115, 0, 221, 0);
    logoG.addColorStop(0, '#71ff2f'); logoG.addColorStop(0.5, '#13d8ff'); logoG.addColorStop(1, '#367cff');
    ctx.fillStyle = logoG; ctx.font = '700 30px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('PREYONE', 115, 51);

    // ── ULTRANET WIFI / VOUCHER ──
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

    // ── RIGHT: Voucher Code Box (label inside) ──
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

    // ── Package Allocation with canvas-drawn icons ──
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

    // ── Instructions strip ──
    var iy = 248;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(38, iy, 724, 32, 6); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '600 7px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('HOW TO CONNECT', 52, iy + 13);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 9px Montserrat, sans-serif';
    ctx.fillText('1  Connect to "Preyone UltraNet Wi-Fi"', 52, iy + 26);
    ctx.fillText('2  Login screen appears automatically', 290, iy + 26);
    ctx.fillText('3  Enter your unique Voucher PIN', 530, iy + 26);

    // ── Info row (Package + enlarged price) ──
    var fy = 296;
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Issued By', 38, fy);
    ctx.fillStyle = '#ffffff'; ctx.font = '600 13px Montserrat, sans-serif';
    var iv = issuedByName;
    while (ctx.measureText(iv).width > 140 && iv.length > 2) { iv = iv.slice(0, -1); }
    if (iv !== issuedByName) iv += '..';
    ctx.fillText(iv, 38, fy + 18);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Location', 220, fy);
    ctx.fillStyle = '#ffffff'; ctx.font = '600 13px Montserrat, sans-serif';
    ctx.fillText('Chitungwiza', 220, fy + 18);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '600 8px Montserrat, sans-serif'; ctx.textAlign = 'left';
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
    ctx.font = '700 ' + ptSize + 'px Montserrat, sans-serif';
    while (ctx.measureText(tierText).width > 180 && ptSize > 12) { ptSize -= 1; ctx.font = '700 ' + ptSize + 'px Montserrat, sans-serif'; }
    ctx.fillText(tierText, 560, fy + 28);
    if (priceText) {
      ctx.shadowColor = 'rgba(113,255,47,0.5)'; ctx.shadowBlur = 14;
      ctx.fillStyle = '#71ff2f'; ctx.font = '900 30px Montserrat, sans-serif';
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
    var tGrad = ctx.createLinearGradient(100, 0, 700, 0);
    tGrad.addColorStop(0, '#71ff2f'); tGrad.addColorStop(0.5, '#13d8ff'); tGrad.addColorStop(1, '#8b4dff');
    ctx.fillStyle = tGrad; ctx.font = '900 14px Montserrat, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Thank you for choosing Preyone UltraNet WiFi.', W / 2, 426);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 10px Montserrat, sans-serif';
    ctx.fillText('We appreciate your trust and support.', W / 2, 444);

    // ── Left-edge barcode strip ──
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
    // SN below barcode
    ctx.fillStyle = '#64748b';
    ctx.font = '600 10px Montserrat, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('SN: ' + serial, W - 14, H - 10);

    // ── Logo image overlay ──
    var logoImg = new Image();
    logoImg.onload = function () {
      ctx.drawImage(logoImg, 28, 8, 78, 78);
      doDownload();
    };
    logoImg.onerror = function () { doDownload(); };
    logoImg.src = '/images/preyone-green-neonglow.png';

    function doDownload() {
      var link = document.createElement('a');
      link.download = 'preyone-voucher-' + data.code + '.png';
      link.href = c.toDataURL('image/png');
      link.click();
      toast('Voucher card downloaded', 'success');
    }
  }

  /* ── Create Voucher ── */
  var voucherForm = $('voucherForm');
  var createBtn = $('createVoucherBtn');
  var vStatus = $('voucherCreateStatus');

  voucherForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!token) { toast('Sign in first', 'error'); return; }

    var tier = selectedPkg ? selectedPkg.tier_name : null;
    var code = $('vCode').value.trim();
    var uses = parseInt($('vUses').value, 10);
    var priceInput = $('vPrice').value;

    $('vCodeErr').textContent = '';
    vStatus.classList.add('hidden');

    var valid = true;
    if (!tier) { toast('Select a package tier', 'error'); valid = false; }
    if (!code) { $('vCodeErr').textContent = 'Code required'; valid = false; }
    if (!priceInput) { toast('Sale price required', 'error'); valid = false; }
    if (!uses || uses < 1) { toast('Max uses must be at least 1', 'error'); valid = false; }
    if (!valid) return;

    var payload = { code: code, maxUses: uses, packageTier: tier, priceAmount: parseFloat(priceInput) };

    createBtn.disabled = true;
    createBtn.innerHTML = '<div class="btn-spinner"></div> Creating...';

    api('/api/admin/vouchers', { method: 'POST', body: JSON.stringify(payload) }).then(function (data) {
      vStatus.className = 'form-status form-status--success';
      vStatus.textContent = 'Voucher "' + data.code + '" created successfully.';
      vStatus.classList.remove('hidden');
      showVoucherCard(data);
      voucherForm.reset();
      $('vUses').value = '1';
      selectedPkg = null;
      var grid = $('packageGrid');
      Array.from(grid.children).forEach(function (c) { c.classList.remove('package-card--selected'); });
      $('vcbPkgBadge').textContent = '—';
      $('vCode').value = '';
      toast('Voucher ' + data.code + ' created', 'success');
      loadVouchers();
    }).catch(function (err) {
      if (err.requiresApproval) {
        vStatus.className = 'form-status form-status--cyan';
        vStatus.innerHTML =
          '<strong style="color:var(--accent-cyan);">' + err.error + '</strong>' +
          '<br><br>' +
          '<button class="btn-primary" id="singleApprovalBtn" style="font-size:0.8rem;padding:0.5rem 1rem;">' +
            '<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Submit for Management Approval' +
          '</button>';
        vStatus.classList.remove('hidden');
        var singleBtn = $('singleApprovalBtn');
        if (singleBtn) {
          singleBtn.addEventListener('click', function () {
            singleBtn.disabled = true;
            singleBtn.innerHTML = '<div class="btn-spinner"></div> Sending...';
            api('/api/admin/vouchers/request-approval', {
              method: 'POST',
              body: JSON.stringify({ requestType: 'single', packageTier: tier, priceAmount: priceInput ? parseFloat(priceInput) : undefined, code: code, maxUses: uses })
            }).then(function (data) {
              toast(data.message, 'success');
              vStatus.className = 'form-status form-status--success';
              vStatus.textContent = '✓ ' + data.message;
            }).catch(function (e) {
              toast(e.error || 'Failed to submit request', 'error');
              singleBtn.disabled = false;
              singleBtn.innerHTML = '<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Submit for Management Approval';
            });
          });
        }
      } else {
        vStatus.className = 'form-status form-status--error';
        vStatus.textContent = err.error || 'Failed to create voucher';
        vStatus.classList.remove('hidden');
        toast(err.error || 'Failed to create voucher', 'error');
      }
    }).finally(function () {
      createBtn.disabled = false;
      createBtn.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="7"/><line x1="10" y1="6" x2="10" y2="14"/><line x1="6" y1="10" x2="14" y2="10"/></svg> Create';
    });
  });

  /* ── Clock In / Out ── */
  $('clockInBtn').addEventListener('click', handleClockIn);
  $('clockOutBtn').addEventListener('click', handleClockOut);

  /* ── Blacklist Form ── */
  var blForm = $('blacklistForm');
  if (blForm) {
    blForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var mac = $('blMac').value.trim();
      var reason = $('blReason').value.trim();
      if (!mac) { toast('MAC address required', 'error'); return; }
      api('/api/admin/blacklist', { method: 'POST', body: JSON.stringify({ macAddress: mac, reason: reason || undefined }) }).then(function () {
        toast('MAC blacklisted', 'success');
        $('blMac').value = '';
        $('blReason').value = '';
        loadBlacklist();
      }).catch(function (err) {
        toast(err.error || 'Failed to blacklist MAC', 'error');
      });
    });
  }

  /* ── Whitelist Form ── */
  var wlForm = $('whitelistForm');
  if (wlForm) {
    wlForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var mac = $('wlMac').value.trim();
      var label = $('wlLabel').value.trim();
      if (!mac) { toast('MAC address required', 'error'); return; }
      api('/api/admin/whitelist', { method: 'POST', body: JSON.stringify({ macAddress: mac, label: label || undefined }) }).then(function () {
        toast('MAC whitelisted', 'success');
        $('wlMac').value = '';
        $('wlLabel').value = '';
        loadWhitelist();
      }).catch(function (err) {
        toast(err.error || 'Failed to whitelist MAC', 'error');
      });
    });
  }

  /* ── Bulk Voucher Form ── */
  var bulkForm = $('bulkVoucherForm');
  if (bulkForm) {
    bulkForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var tier = $('bulkTier').value;
      var count = parseInt($('bulkCount').value, 10);
      var price = parseFloat($('bulkPrice').value) || 0;
      if (!tier) { toast('Select a package tier', 'error'); return; }
      if (count < 1 || count > 100) { toast('Count must be 1-100', 'error'); return; }

      var btn = $('bulkCreateBtn');
      btn.disabled = true;
      btn.innerHTML = '<div class="btn-spinner"></div> Generating...';

      api('/api/admin/vouchers/bulk', { method: 'POST', body: JSON.stringify({ count: count, packageTier: tier, priceAmount: price || undefined }) }).then(function (data) {
        var status = $('bulkVoucherStatus');
        status.className = 'form-status form-status--success';
        status.textContent = data.message;
        status.classList.remove('hidden');
        toast(data.message, 'success');

        // Show codes
        var vouchers = data.vouchers;
        var codesStr = vouchers.map(function (v) { return v.code; }).join(', ');
        var codesSafe = codesStr.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        var listHtml = vouchers.map(function (v) {
          var sc = v.code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          return '<span style="display:inline-block;font-family:monospace;font-size:0.85rem;color:var(--accent-cyan);background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:6px;padding:0.2rem 0.6rem;margin:0.2rem;">' + sc + '</span>';
        }).join('');
        $('bulkVoucherResults').innerHTML =
          '<div class="card" style="padding:1rem;">' +
            '<div class="section-head" style="margin-top:0;">' +
              '<h3 class="section-head-title" style="font-size:0.9rem;">Generated Codes</h3>' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.75rem;">' + listHtml + '</div>' +
            '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
              '<button class="btn-action btn-action--copy" id="bulkCopyAllBtn" data-codes="' + codesSafe + '" style="flex-shrink:0;">Copy All</button>' +
              '<button class="btn-action btn-action--download" id="bulkDownloadPngsBtn" style="flex-shrink:0;">Download Vouchers</button>' +
            '</div>' +
          '</div>';
        $('bulkVoucherResults').classList.remove('hidden');

        // Bind Copy All
        var copyBtn = $('bulkCopyAllBtn');
        if (copyBtn) {
          copyBtn.addEventListener('click', function () {
            navigator.clipboard.writeText(codesStr).then(function () {
              toast('All codes copied', 'success');
            }).catch(function () {
              toast('Failed to copy', 'error');
            });
          });
        }

        // Bind Download PNGs
        var dlBtn = $('bulkDownloadPngsBtn');
        if (dlBtn) {
          dlBtn.addEventListener('click', function () {
            var i = 0;
            (function next() {
              if (i >= vouchers.length) { toast('All vouchers downloaded', 'success'); return; }
              downloadVoucherCard(vouchers[i]);
              setTimeout(next, 400);
              i++;
            })();
          });
        }

        loadVouchers();
      }).catch(function (err) {
        if (err.requiresApproval) {
          var tier = $('bulkTier').value;
          var count = parseInt($('bulkCount').value, 10);
          var price = parseFloat($('bulkPrice').value) || 0;
          var reqEl = $('bulkApprovalRequest');
          reqEl.classList.remove('hidden');
          reqEl.innerHTML =
            '<div class="card" style="padding:1rem;border-color:var(--cyan);">' +
              '<p style="color:var(--accent-cyan);font-size:0.85rem;margin-bottom:0.75rem;">' +
                '<strong>Staff cannot sell Bulk vouchers.</strong> Only Management may approve the sale. Submit a request below:' +
              '</p>' +
              '<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">' +
                '<span style="font-size:0.8rem;color:var(--text-muted);">' + tier + ' × ' + count + (price ? ' — $' + price.toFixed(2) : '') + '</span>' +
                '<button class="btn-primary" id="submitApprovalBtn" style="font-size:0.8rem;padding:0.5rem 1rem;">' +
                  '<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Request Approval' +
                '</button>' +
              '</div>' +
            '</div>';
          var submitBtn = $('submitApprovalBtn');
          if (submitBtn) {
            submitBtn.addEventListener('click', function () {
              submitBtn.disabled = true;
              submitBtn.innerHTML = '<div class="btn-spinner"></div> Sending...';
              api('/api/admin/vouchers/request-approval', {
                method: 'POST',
                body: JSON.stringify({ requestType: 'bulk', packageTier: tier, count: count, priceAmount: price || undefined })
              }).then(function (data) {
                toast(data.message, 'success');
                reqEl.innerHTML = '<p style="color:var(--green);font-size:0.85rem;">✓ ' + data.message + '</p>';
              }).catch(function (e) {
                toast(e.error || 'Failed to submit request', 'error');
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Request Approval';
              });
            });
          }
        } else {
          var status = $('bulkVoucherStatus');
          status.className = 'form-status form-status--error';
          status.textContent = err.error || 'Bulk generation failed';
          status.classList.remove('hidden');
          toast(err.error || 'Bulk generation failed', 'error');
        }
      }).finally(function () {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="7"/><line x1="10" y1="6" x2="10" y2="14"/><line x1="6" y1="10" x2="14" y2="10"/></svg> Generate Bulk';
      });
    });
  }

  /* ── Alerts Buttons ── */
  var ackAllBtn = $('ackAllAlertsBtn');
  if (ackAllBtn) {
    ackAllBtn.addEventListener('click', function () {
      // Fetch all active alerts and acknowledge them one by one
      api('/api/admin/alerts').then(function (d) {
        if (!d.active || d.active.length === 0) { toast('No active alerts', 'info'); return; }
        var promises = d.active.map(function (a) {
          return api('/api/admin/alerts/' + a.id + '/acknowledge', { method: 'POST' });
        });
        Promise.all(promises).then(function () {
          toast('All alerts acknowledged', 'success');
          loadAlerts();
        }).catch(function () {
          toast('Some alerts failed to acknowledge', 'error');
          loadAlerts();
        });
      }).catch(function () {});
    });
  }

  var seedBtn = $('seedAlertsBtn');
  if (seedBtn) {
    seedBtn.addEventListener('click', function () {
      api('/api/admin/alerts/seed-mock', { method: 'POST' }).then(function (d) {
        toast(d.message || 'Mock alerts generated', 'success');
        loadAlerts();
      }).catch(function (err) {
        toast(err.error || 'Failed to generate alerts', 'error');
      });
    });
  }

  /* ── AP Device Management (CEO) ── */
  window.editApDevice = function (id, name, model, mac, ip, location) {
    $('apName').value = name;
    $('apModel').value = model;
    $('apMac').value = mac;
    $('apIp').value = ip;
    $('apLocation').value = location;
    $('apEditId').value = id;
    $('apDeviceSaveBtn').innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 10 8 14 16 6"/></svg> Update AP';
    $('apDeviceSaveBtn').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  window.deleteApDevice = function (id, name) {
    if (!confirm('Delete AP "' + name + '"? This cannot be undone.')) return;
    api('/api/admin/ap-devices/' + id, { method: 'DELETE' }).then(function (d) {
      toast(d.message, 'success');
      loadApHealth();
    }).catch(function (err) { toast(err.error || 'Delete failed', 'error'); });
  };

  (function initApDeviceForm() {
    var form = $('apDeviceForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var editId = $('apEditId').value;
      var body = {
        name: $('apName').value.trim(),
        model: $('apModel').value.trim(),
        macAddress: $('apMac').value.trim(),
        ipAddress: $('apIp').value.trim(),
        location: $('apLocation').value.trim(),
      };
      if (!body.name || !body.macAddress) { $('apDeviceStatus').textContent = 'Name and MAC required'; $('apDeviceStatus').className = 'form-status form-status--error'; return; }
      var url = editId ? '/api/admin/ap-devices/' + editId : '/api/admin/ap-devices';
      var method = editId ? 'PUT' : 'POST';
      api(url, { method: method, body: JSON.stringify(body) }).then(function () {
        $('apDeviceStatus').textContent = editId ? 'AP updated!' : 'AP added!';
        $('apDeviceStatus').className = 'form-status form-status--success';
        form.reset();
        $('apEditId').value = '';
        $('apDeviceSaveBtn').innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="7"/><line x1="10" y1="6" x2="10" y2="14"/><line x1="6" y1="10" x2="14" y2="10"/></svg> Add AP';
        loadApHealth();
        setTimeout(function () { $('apDeviceStatus').className = 'form-status hidden'; }, 3000);
      }).catch(function (err) { $('apDeviceStatus').textContent = err.error || 'Failed'; $('apDeviceStatus').className = 'form-status form-status--error'; });
    });
  })();

  /* ── Package Management (CEO) ── */
  function loadPackagesManager() {
    api('/api/admin/packages/manage').then(function (pkgs) {
      if (!pkgs || pkgs.length === 0) {
        $('packageTableContent').innerHTML = '<div class="table-empty"><p>No packages found. Create one above.</p></div>';
        return;
      }
      var cols = [
        { label: 'Tier', render: function (r) { return '<strong>' + escHtml(r.tier_name) + '</strong>'; } },
        { label: 'Display', render: function (r) { return escHtml(r.display_name); } },
        { label: 'Price', render: function (r) { return '$' + parseFloat(r.price_amount).toFixed(2); } },
        { label: 'Duration', render: function (r) { return r.duration_min + ' min'; } },
        { label: 'Data', render: function (r) { return r.is_uncapped ? '∞' : (r.data_limit_gb ? r.data_limit_gb + ' GB' : '—'); } },
        { label: 'BW', render: function (r) { return r.bandwidth_mbps_up + '/' + r.bandwidth_mbps_down + ' Mbps'; } },
        { label: 'Period', render: function (r) { return r.billing_period; } },
        { label: 'Actions', render: function (r) {
          return '<div style="display:flex;gap:0.4rem;">' +
            '<button class="btn-icon" onclick="editPackage(\'' + r.id + '\')" title="Edit" style="color:var(--accent-cyan);">&nbsp;✎&nbsp;</button>' +
            '<button class="btn-icon" onclick="deletePackage(\'' + r.id + '\')" title="Delete" style="color:var(--red);">&nbsp;✕&nbsp;</button>' +
            '</div>';
        }},
      ];
      $('packageTableContent').innerHTML = renderTable(cols, pkgs);
    }).catch(function (err) { toast(err.error || 'Failed to load packages', 'error'); });
  }

  window.editPackage = function (id) {
    api('/api/admin/packages/manage').then(function (pkgs) {
      var pkg = pkgs.find(function (p) { return p.id === id; });
      if (!pkg) return;
      $('pkgTierName').value = pkg.tier_name;
      $('pkgDisplayName').value = pkg.display_name;
      $('pkgPrice').value = pkg.price_amount;
      $('pkgDuration').value = pkg.duration_min;
      $('pkgData').value = pkg.data_limit_gb || 0;
      $('pkgBwUp').value = pkg.bandwidth_mbps_up;
      $('pkgBwDown').value = pkg.bandwidth_mbps_down;
      $('pkgPeriod').value = pkg.billing_period;
      $('pkgUncapped').checked = pkg.is_uncapped;
      $('pkgEditId').value = id;
      $('pkgSaveBtn').innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 10 8 14 16 6"/></svg> Update Package';
      $('pkgSaveBtn').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  window.deletePackage = function (id) {
    if (!confirm('Delete this package? This cannot be undone.')) return;
    api('/api/admin/packages/' + id, { method: 'DELETE' }).then(function (d) {
      toast(d.message, 'success');
      loadPackagesManager();
    }).catch(function (err) { toast(err.error || 'Delete failed', 'error'); });
  };

  (function initPackageForm() {
    var form = $('packageForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var editId = $('pkgEditId').value;
      var body = {
        tierName: $('pkgTierName').value.trim(),
        displayName: $('pkgDisplayName').value.trim(),
        priceAmount: parseFloat($('pkgPrice').value) || 0,
        durationMin: parseInt($('pkgDuration').value) || 1440,
        dataLimitGb: parseFloat($('pkgData').value) || null,
        bandwidthUp: parseInt($('pkgBwUp').value) || 2,
        bandwidthDown: parseInt($('pkgBwDown').value) || 2,
        billingPeriod: $('pkgPeriod').value,
        isUncapped: $('pkgUncapped').checked,
      };
      if (!body.tierName || !body.displayName) { $('packageFormStatus').textContent = 'Tier name and display name required'; $('packageFormStatus').className = 'form-status form-status--error'; return; }
      var url = editId ? '/api/admin/packages/' + editId : '/api/admin/packages';
      var method = editId ? 'PUT' : 'POST';
      api(url, { method: method, body: JSON.stringify(body) }).then(function () {
        $('packageFormStatus').textContent = editId ? 'Package updated!' : 'Package created!';
        $('packageFormStatus').className = 'form-status form-status--success';
        if (!editId) form.reset();
        $('pkgEditId').value = '';
        $('pkgSaveBtn').innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 10 8 14 16 6"/></svg> Create Package';
        loadPackagesManager();
        loadPackages(); // Refresh the voucher creation package grid too
        setTimeout(function () { $('packageFormStatus').className = 'form-status hidden'; }, 3000);
      }).catch(function (err) { $('packageFormStatus').textContent = err.error || 'Failed'; $('packageFormStatus').className = 'form-status form-status--error'; });
    });
  })();

  /* ── Broadcast Messages (CEO) ── */
  function loadBroadcasts() {
    api('/api/admin/broadcasts').then(function (bcasts) {
      if (!bcasts || bcasts.length === 0) {
        $('broadcastTableContent').innerHTML = '<div class="table-empty"><p>No broadcasts sent yet.</p></div>';
        return;
      }
      var cols = [
        { label: '', render: function (r) { return r.is_unread ? '<span style="color:var(--accent);font-size:1.2rem;">●</span>' : ''; } },
        { label: 'Title', render: function (r) { return '<strong>' + escHtml(r.title) + '</strong>'; } },
        { label: 'Message', render: function (r) { return escHtml(r.message); } },
        { label: 'Sent By', render: function (r) { return escHtml(r.created_by_name || '—'); } },
        { label: 'Date', render: function (r) { return new Date(r.created_at).toLocaleString(); } },
      ];
      $('broadcastTableContent').innerHTML = renderTable(cols, bcasts);

      // Mark all as read when viewing the section
      api('/api/admin/broadcasts/read-all', { method: 'POST' }).catch(function () {});
    }).catch(function (err) { toast(err.error || 'Failed to load broadcasts', 'error'); });
  }

  (function initBroadcastForm() {
    var form = $('broadcastForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = $('bcastTitle').value.trim();
      var message = $('bcastMessage').value.trim();
      if (!title || !message) { $('broadcastStatus').textContent = 'Title and message required'; $('broadcastStatus').className = 'form-status form-status--error'; return; }
      api('/api/admin/broadcast', { method: 'POST', body: JSON.stringify({ title: title, message: message }) }).then(function () {
        $('broadcastStatus').textContent = 'Broadcast sent!';
        $('broadcastStatus').className = 'form-status form-status--success';
        form.reset();
        loadBroadcasts();
        setTimeout(function () { $('broadcastStatus').className = 'form-status hidden'; }, 3000);
      }).catch(function (err) { $('broadcastStatus').textContent = err.error || 'Failed'; $('broadcastStatus').className = 'form-status form-status--error'; });
    });
  })();

  /* ── Backup Manager (CEO) ── */
  function loadBackupManager() {
    api('/api/admin/backup/logs').then(function (logs) {
      $('backupCount').textContent = (logs && logs.length) || 0;
      if (!logs || logs.length === 0) {
        $('backupTableContent').innerHTML = '<div class="table-empty"><p>No backups created yet.</p></div>';
        return;
      }
      var cols = [
        { label: 'File Name', render: function (r) { return escHtml(r.file_name); } },
        { label: 'Size', render: function (r) { return r.file_size ? (r.file_size / 1024).toFixed(1) + ' KB' : '—'; } },
        { label: 'Created By', render: function (r) { return escHtml(r.created_by_name || '—'); } },
        { label: 'Date', render: function (r) { return new Date(r.created_at).toLocaleString(); } },
      ];
      $('backupTableContent').innerHTML = renderTable(cols, logs);
    }).catch(function (err) { toast(err.error || 'Failed to load backups', 'error'); });
  }

  (function initBackupBtn() {
    var btn = $('createBackupBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (!confirm('Create a full system backup? This may take a moment.')) return;
      btn.disabled = true;
      btn.textContent = 'Creating backup...';
      api('/api/admin/backup', { method: 'POST' }).then(function (d) {
        toast('Backup created: ' + d.fileName + ' (' + (d.fileSize / 1024).toFixed(1) + ' KB)', 'success');
        // Trigger file download
        var blob = new Blob([JSON.stringify(d.data, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = d.fileName;
        a.click();
        loadBackupManager();
      }).catch(function (err) { toast(err.error || 'Backup failed', 'error'); }).finally(function () {
        btn.disabled = false;
        btn.textContent = 'Create Backup';
      });
    });
  })();

  /* ── Commissions (CEO) ── */
  function loadCommissions() {
    api('/api/admin/commissions').then(function (data) {
      if (!data || data.length === 0) {
        $('commissionTableContent').innerHTML = '<div class="table-empty"><p>No staff accounts found.</p></div>';
        return;
      }
      var rows = data.map(function (r) {
        return {
          id: r.staff_id || r.id,
          full_name: r.full_name || 'Unknown',
          email: r.email || '',
          commission_pct: r.commission_pct || 0,
          has_commission: r.commission_pct !== null,
        };
      });
      var cols = [
        { label: 'Name', render: function (r) { return escHtml(r.full_name); } },
        { label: 'Email', render: function (r) { return escHtml(r.email); } },
        { label: 'Commission %', render: function (r) {
          return '<div class="stepper stepper--sm" style="display:inline-flex;width:100px;">' +
            '<input type="number" min="0" max="100" step="0.5" value="' + r.commission_pct + '" data-staff-id="' + r.id + '" class="commission-input" />' +
            '</div>';
        }},
        { label: 'Actions', render: function (r) {
          return '<button class="btn-action btn-action--save" onclick="saveCommission(\'' + r.id + '\')" style="font-size:0.65rem;padding:0.25rem 0.6rem;">Save</button>';
        }},
      ];
      $('commissionTableContent').innerHTML = renderTable(cols, rows);
    }).catch(function (err) { toast(err.error || 'Failed to load commissions', 'error'); });
  }

  window.saveCommission = function (staffId) {
    var input = document.querySelector('.commission-input[data-staff-id="' + staffId + '"]');
    var val = input ? parseFloat(input.value) : 0;
    if (isNaN(val) || val < 0 || val > 100) { toast('Commission must be 0-100%', 'error'); return; }
    api('/api/admin/commissions/' + staffId, { method: 'PUT', body: JSON.stringify({ commissionPct: val }) }).then(function () {
      toast('Commission saved!', 'success');
    }).catch(function (err) { toast(err.error || 'Failed', 'error'); });
  };

  /* ── Maintenance Mode (CEO) ── */
  function loadMaintenance() {
    api('/api/admin/maintenance').then(function (data) {
      $('maintenanceToggle').checked = data.enabled;
      $('maintenanceMsg').value = data.message || '';
    }).catch(function () {});
  }

  (function initMaintenance() {
    var btn = $('saveMaintenanceBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var enabled = $('maintenanceToggle').checked;
      var message = $('maintenanceMsg').value.trim();
      api('/api/admin/maintenance', { method: 'PUT', body: JSON.stringify({ enabled: enabled, message: message || undefined }) }).then(function (d) {
        $('maintenanceStatus').textContent = d.message;
        $('maintenanceStatus').className = 'form-status form-status--success';
        setTimeout(function () { $('maintenanceStatus').className = 'form-status hidden'; }, 3000);
      }).catch(function (err) { $('maintenanceStatus').textContent = err.error || 'Failed'; $('maintenanceStatus').className = 'form-status form-status--error'; });
    });
  })();

  /* ── Data Retention (CEO) ── */
  function loadRetention() {
    api('/api/admin/retention').then(function (data) {
      $('retSessionDays').value = data.session_days || 90;
      $('retAccessLogDays').value = data.access_log_days || 30;
      $('retAuditLogDays').value = data.audit_log_days || 365;
    }).catch(function () {});
  }

  (function initRetentionForm() {
    var form = $('retentionForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      api('/api/admin/retention', { method: 'PUT', body: JSON.stringify({
        sessionDays: parseInt($('retSessionDays').value) || 90,
        accessLogDays: parseInt($('retAccessLogDays').value) || 30,
        auditLogDays: parseInt($('retAuditLogDays').value) || 365,
      }) }).then(function () {
        $('retentionStatus').textContent = 'Retention policy updated!';
        $('retentionStatus').className = 'form-status form-status--success';
        setTimeout(function () { $('retentionStatus').className = 'form-status hidden'; }, 3000);
      }).catch(function (err) { $('retentionStatus').textContent = err.error || 'Failed'; $('retentionStatus').className = 'form-status form-status--error'; });
    });
  })();

  /* ── Branding (CEO) ── */
  function loadBranding() {
    api('/api/admin/branding').then(function (data) {
      if (!data) return;
      $('brandPortalTitle').value = data.portal_title || '';
      $('brandVoucherHeader').value = data.voucher_header || '';
      $('brandVoucherFooter').value = data.voucher_footer || '';
      $('brandPrimaryColor').value = data.primary_color || '#ff00ff';
      $('brandAccentColor').value = data.accent_color || '#6a0dad';
    }).catch(function () {});
  }

  (function initBrandingForm() {
    var form = $('brandingForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      api('/api/admin/branding', { method: 'PUT', body: JSON.stringify({
        portalTitle: $('brandPortalTitle').value.trim(),
        voucherHeader: $('brandVoucherHeader').value.trim(),
        voucherFooter: $('brandVoucherFooter').value.trim(),
        primaryColor: $('brandPrimaryColor').value.trim(),
        accentColor: $('brandAccentColor').value.trim(),
      }) }).then(function () {
        $('brandingStatus').textContent = 'Branding updated!';
        $('brandingStatus').className = 'form-status form-status--success';
        setTimeout(function () { $('brandingStatus').className = 'form-status hidden'; }, 3000);
      }).catch(function (err) { $('brandingStatus').textContent = err.error || 'Failed'; $('brandingStatus').className = 'form-status form-status--error'; });
    });
  })();

  /* ── Kill Switch (CEO) ── */
  (function initKillSwitch() {
    var btn = $('killSwitchBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (!confirm('WARNING: This will disconnect ALL active users immediately. Are you sure?')) return;
      if (!confirm('FINAL WARNING: This action cannot be undone. All active sessions will be terminated.')) return;
      btn.disabled = true;
      btn.textContent = 'Killing sessions...';
      api('/api/admin/kill-sessions', { method: 'POST' }).then(function (d) {
        $('killSwitchStatus').textContent = d.message;
        $('killSwitchStatus').className = 'form-status form-status--success';
        toast(d.message, 'warning');
      }).catch(function (err) { $('killSwitchStatus').textContent = err.error || 'Failed'; $('killSwitchStatus').className = 'form-status form-status--error'; }).finally(function () {
        btn.disabled = false;
        btn.textContent = 'Kill All Sessions';
      });
    });
  })();

  /* ── Scheduled Reports (CEO) ── */
  function loadReportSchedules() {
    api('/api/admin/report-schedules').then(function (data) {
      if (!data || data.length === 0) {
        $('reportScheduleTableContent').innerHTML = '<div class="table-empty"><p>No report schedules configured.</p></div>';
        return;
      }
      var cols = [
        { label: 'Frequency', render: function (r) { return '<span style="text-transform:capitalize;">' + r.frequency + '</span>'; } },
        { label: 'Recipients', render: function (r) {
          var recips = typeof r.recipients === 'string' ? JSON.parse(r.recipients) : (r.recipients || []);
          return recips.join(', ') || '—';
        }},
        { label: 'Status', render: function (r) { return r.enabled ? '<span class="form-status--success" style="font-size:0.7rem;">Active</span>' : '<span style="color:var(--text-muted);font-size:0.7rem;">Disabled</span>'; } },
        { label: 'Last Sent', render: function (r) { return r.last_sent_at ? new Date(r.last_sent_at).toLocaleString() : '—'; } },
        { label: 'Actions', render: function (r) {
          return '<button class="btn-icon" onclick="deleteReportSchedule(\'' + r.id + '\')" title="Delete" style="color:var(--red);">&nbsp;✕&nbsp;</button>';
        }},
      ];
      $('reportScheduleTableContent').innerHTML = renderTable(cols, data);
    }).catch(function (err) { toast(err.error || 'Failed to load schedules', 'error'); });
  }

  window.deleteReportSchedule = function (id) {
    if (!confirm('Delete this schedule?')) return;
    api('/api/admin/report-schedules/' + id, { method: 'DELETE' }).then(function () {
      toast('Schedule deleted', 'success');
      loadReportSchedules();
    }).catch(function (err) { toast(err.error || 'Delete failed', 'error'); });
  };

  (function initReportScheduleForm() {
    var form = $('reportScheduleForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var recipients = $('rsRecipients').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (recipients.length === 0) { $('reportScheduleStatus').textContent = 'At least one recipient email required'; $('reportScheduleStatus').className = 'form-status form-status--error'; return; }
      api('/api/admin/report-schedules', { method: 'POST', body: JSON.stringify({
        frequency: $('rsFrequency').value,
        recipients: recipients,
        enabled: $('rsEnabled').checked,
      }) }).then(function () {
        $('reportScheduleStatus').textContent = 'Schedule created!';
        $('reportScheduleStatus').className = 'form-status form-status--success';
        form.reset();
        $('rsEnabled').checked = true;
        loadReportSchedules();
        setTimeout(function () { $('reportScheduleStatus').className = 'form-status hidden'; }, 3000);
      }).catch(function (err) { $('reportScheduleStatus').textContent = err.error || 'Failed'; $('reportScheduleStatus').className = 'form-status form-status--error'; });
    });
  })();

  /* ── Init ── */
  (function init() {
    var saved = window.localStorage.getItem('preyoneAdminToken');
    if (saved) {
      token = saved;
      // Verify token is still valid by fetching /me
      fetch('/api/admin/auth/me', { headers: { 'Authorization': 'Bearer ' + token } }).then(function (r) {
        if (!r.ok) throw new Error('Invalid token');
        return r.json();
      }).then(function (u) {
        user = { id: u.id, fullName: u.full_name, email: u.email, role: u.role };
        showAdmin();
        loadAll().then(function () {
          var firstLink = document.querySelector('.sidebar-link[data-section="overview"]');
          if (firstLink) firstLink.click();
        }).catch(function () {});
      }).catch(function () {
        // Token invalid, show auth
        window.localStorage.removeItem('preyoneAdminToken');
        token = '';
        showAuth();
      });
    } else {
      showAuth();
    }
  })();

})();
