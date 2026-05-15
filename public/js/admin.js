(function () {
  'use strict';

  const adminKeyInput = document.getElementById('admin-key');
  const saveKeyBtn = document.getElementById('save-key');
  const clearKeyBtn = document.getElementById('clear-key');
  const adminStatus = document.getElementById('admin-status');
  const tablesSection = document.getElementById('tables-section');
  const voucherForm = document.getElementById('voucher-form');
  const voucherStatus = document.getElementById('voucher-status');
  const voucherList = document.getElementById('voucher-list');
  const userList = document.getElementById('user-list');
  const accessLog = document.getElementById('access-log');

  function getAdminKey() {
    return window.localStorage.getItem('preyoneAdminKey') || '';
  }

  function setAdminKey(value) {
    if (value) {
      window.localStorage.setItem('preyoneAdminKey', value);
    } else {
      window.localStorage.removeItem('preyoneAdminKey');
    }
  }

  function showStatus(message, isError = true) {
    if (!adminStatus) return;
    adminStatus.textContent = message;
    adminStatus.classList.toggle('hidden', false);
    adminStatus.style.color = isError ? '#c62828' : '#1f7a23';
  }

  function hideStatus() {
    if (!adminStatus) return;
    adminStatus.textContent = '';
    adminStatus.classList.add('hidden');
  }

  function getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-admin-key': getAdminKey(),
    };
  }

  function handleResponse(response) {
    if (!response.ok) return response.json().then((data) => Promise.reject(data));
    return response.json();
  }

  async function fetchJson(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        ...getHeaders(),
        ...(options.headers || {}),
      },
    });
    return handleResponse(res);
  }

  function formatTable(columns, rows) {
    if (!rows || rows.length === 0) return '<p>No records found.</p>';

    const header = columns.map((col) => `<th>${col.label}</th>`).join('');
    const body = rows
      .map((row) => {
        const cells = columns
          .map((col) => `<td>${col.render ? col.render(row) : String(row[col.key] ?? '')}</td>`)
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');

    return `<table class="admin-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
  }

  async function reloadVouchers() {
    try {
      const data = await fetchJson('/api/admin/vouchers');
      voucherList.innerHTML = formatTable(
        [
          { label: 'Code', key: 'code' },
          { label: 'Duration', key: 'duration_min', render: (row) => `${row.duration_min} min` },
          { label: 'Max uses', key: 'max_uses' },
          { label: 'Used', key: 'used_count' },
          { label: 'Expires', key: 'expires_at', render: (row) => row.expires_at || 'None' },
          { label: 'Created', key: 'created_at' },
        ],
        data
      );
    } catch (err) {
      showStatus(err.error || 'Unable to load vouchers.');
    }
  }

  async function reloadUsers() {
    try {
      const data = await fetchJson('/api/admin/users');
      userList.innerHTML = formatTable(
        [
          { label: 'Name', key: 'full_name' },
          { label: 'Phone', key: 'phone' },
          { label: 'Voucher', key: 'voucher_code' },
          { label: 'Accepted TOS', key: 'accepted_tos', render: (row) => row.accepted_tos ? 'Yes' : 'No' },
          { label: 'Expires', key: 'session_expires_at' },
          { label: 'Created', key: 'created_at' },
        ],
        data
      );
    } catch (err) {
      showStatus(err.error || 'Unable to load users.');
    }
  }

  async function reloadLogs() {
    try {
      const data = await fetchJson('/api/admin/access-log');
      accessLog.innerHTML = formatTable(
        [
          { label: 'Event', key: 'event' },
          { label: 'User', key: 'full_name' },
          { label: 'MAC', key: 'mac_address' },
          { label: 'IP', key: 'ip_address' },
          { label: 'Detail', key: 'detail' },
          { label: 'Created', key: 'created_at' },
        ],
        data
      );
    } catch (err) {
      showStatus(err.error || 'Unable to load access log.');
    }
  }

  function enableControls(enabled) {
    tablesSection.classList.toggle('hidden', !enabled);
  }

  async function testAdminKey() {
    try {
      await reloadVouchers();
      await reloadUsers();
      await reloadLogs();
      showStatus('Admin key loaded successfully.', false);
      enableControls(true);
    } catch (err) {
      showStatus(err.error || 'Invalid admin key or API unavailable.');
      enableControls(false);
    }
  }

  saveKeyBtn.addEventListener('click', function (event) {
    event.preventDefault();
    const value = adminKeyInput.value.trim();
    if (!value) {
      showStatus('Enter a valid admin key.');
      return;
    }
    setAdminKey(value);
    testAdminKey();
  });

  clearKeyBtn.addEventListener('click', function (event) {
    event.preventDefault();
    setAdminKey('');
    adminKeyInput.value = '';
    hideStatus();
    enableControls(false);
  });

  voucherForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    hideStatus();
    const code = document.getElementById('voucher-code').value.trim();
    const durationMin = Number(document.getElementById('voucher-duration').value);
    const maxUses = Number(document.getElementById('voucher-uses').value);
    const expiresAtInput = document.getElementById('voucher-expires').value;

    const payload = { code, durationMin, maxUses };
    if (expiresAtInput) {
      payload.expiresAt = new Date(expiresAtInput).toISOString();
    }

    try {
      const data = await fetchJson('/api/admin/vouchers', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      voucherStatus.textContent = `Voucher ${data.code} created.`;
      voucherStatus.style.color = '#1f7a23';
      voucherStatus.classList.remove('hidden');
      reloadVouchers();
    } catch (err) {
      voucherStatus.textContent = err.error || 'Unable to create voucher.';
      voucherStatus.style.color = '#c62828';
      voucherStatus.classList.remove('hidden');
    }
  });

  async function init() {
    const savedKey = getAdminKey();
    if (savedKey) {
      adminKeyInput.value = savedKey;
      await testAdminKey();
    } else {
      enableControls(false);
    }
  }

  init();
})();
