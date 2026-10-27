import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { showToast } from '../utils/toast';
import { drawVoucherCanvas, voucherSerial } from '../utils/voucherCard';
import { shareVoucherJpeg } from '../utils/voucherShare';
import jsPDF from 'jspdf';
import { playVoucherSound, playAlertSound } from '../utils/sound';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';
import './Vouchers.css';

interface Package {
  tier_name: string;
  display_name: string;
  price_amount: string;
  billing_period: string;
  duration_min: number;
  bandwidth_mbps_up: number;
  bandwidth_mbps_down: number;
  data_limit_gb: number | null;
  is_uncapped: boolean;
}

  interface Voucher {
    id: string;
    code: string;
    price_amount: string;
    duration_min: number;
    bandwidth_mbps_up: number;
    bandwidth_mbps_down: number;
    data_limit_gb: number | null;
    is_uncapped: boolean;
    max_uses: number;
    used_count: number;
    expires_at: string;
    created_at: string;
    package_tier: string | null;
    // Returned by GET /admin/vouchers (admin.ts, the LATERAL joins) but not part
    // of the core row. Optional so the create/bulk flows, which build partial
    // voucher objects, stay type-compatible.
    status?: string | null;
    first_redeemed_at?: string | null;
    activated_at?: string | null;
    last_seen_at?: string | null;
    ruijie_sync_status?: string | null;
    ruijie_voucher_id?: string | null;
    max_devices?: number | null;
    effective_max_devices?: number | null;
    device_count?: number;
    bound_macs?: string[] | null;
    devices?: Array<{
      mac_address: string;
      label: string | null;
      is_active: boolean;
      bound_at: string | null;
      last_seen_at: string | null;
      unbound_at: string | null;
    }> | null;
    phone?: string | null;
    mac_address?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    alias?: string | null;
    redemption_name?: string | null;
    redemption_mac?: string | null;
    redemption_ip?: string | null;
    redemption_at?: string | null;
    redemptions?: Array<{
      full_name: string | null;
      mac_address: string | null;
      ip_address: string | null;
      redeemed_at: string;
    }> | null;
    traffic_used_bytes?: number;
    traffic_total_bytes?: number | null;
    // Captured by the >=$4.99 holder modal (POST /vouchers) and editable via
    // PATCH /vouchers/:id. Rendered on the voucher canvas when present.
    holder_name?: string | null;
    holder_phone?: string | null;
    // Returned by the list query (admin.ts SELECT) and /vouchers/:id/renew.
    is_disabled?: boolean;
    deleted_at?: string | null;
  }

interface ApprovalRequest {
  id: string;
  request_type: string;
  package_tier: string;
  price_amount: number;
  voucher_code: string;
  max_uses: number;
  count: number;
  voucher_count: number;
  status: string;
  requested_by_name: string;
  created_at: string;
  approved_at: string | null;
  approved_by_name: string | null;
  voucher_data: { code?: string; codes?: string[] } | null;
}

interface ClockStatus {
  clockedIn: boolean;
  log: { clock_in: string } | null;
}

const APPROVAL_TIERS = ['PreMax', 'PreUltra', 'PreExecutive'];

function fmtDur(m: number): string {
  if (!m) return '—';
  if (m >= 43200) return Math.round(m / 43200) + 'mo';
  if (m >= 1440) return Math.round(m / 1440) + 'd';
  if (m >= 60) return Math.round(m / 60) + 'h';
  return m + 'min';
}

function fmtDate(d: string): string {
  try { return new Date(d).toLocaleString(); } catch { return d || '—'; }
}

const PAYMENT_METHODS = ['Cash', 'EcoCash', 'OneMoney', 'Omari', 'InnBucks'];
const IS_MOBILE_MONEY = (m: string) => m !== 'Cash';

// One mapping for every status badge so the list and the detail sheet can
// never disagree. Only a live or a disabled code earns colour; `Expired` and
// anything unexpected fall through to a quiet grey.
const statusTone = (status?: string | null) =>
  status === 'Active' ? 'yes'
    : status === 'Disabled' ? 'no'
    : status === 'Unused' ? 'idle'
    : 'muted';
const lc = (s?: string) => (s || '').toLowerCase();

export default function Vouchers() {
  const { user } = useAuth();
  const role = user?.role || 'Staff';
  const isMgmt = role === 'CEO' || role === 'Manager';
  const needsClockIn = role !== 'CEO';
  // admin.ts puts company.admin on renew/reset-mac/disable/delete. It is seeded
  // for CEO, Manager, SUPER_ADMIN and COMPANY_ADMIN — never Staff — so without
  // this gate Staff would see the buttons and only ever get a 403 back.
  const canManageVoucher =
    user?.permissions?.includes('company.admin') ||
    ['CEO', 'Manager', 'SUPER_ADMIN', 'COMPANY_ADMIN'].includes(role);

  const [clockStatus, setClockStatus] = useState<ClockStatus | null>(null);
  const [packages, setPackages] = useState<Package[]>([]);
  const [selectedPkg, setSelectedPkg] = useState<Package | null>(null);
  const [vCode, setVCode] = useState('');
  const [vPrice, setVPrice] = useState('');
  const [vUses, setVUses] = useState(1);
  const [vPayMethod, setVPayMethod] = useState('Cash');
  const [vPayRef, setVPayRef] = useState('');
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [vStatus, setVStatus] = useState<{ type: string; msg: string } | null>(null);
  const [sharingWa, setSharingWa] = useState(false);
  const [creating, setCreating] = useState(false);

  const [bulkTier, setBulkTier] = useState('');
  const [bulkCount, setBulkCount] = useState(2);
  const [bulkPrice, setBulkPrice] = useState('');
  const [bulkPayMethod, setBulkPayMethod] = useState('Cash');
  const [bulkPayRef, setBulkPayRef] = useState('');
  const [bulkStatus, setBulkStatus] = useState<{ type: string; msg: string } | null>(null);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkResults, setBulkResults] = useState<any>(null);

  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [myApprovals, setMyApprovals] = useState<ApprovalRequest[]>([]);

  const processedApprovalIds = useRef<Set<string>>(new Set());

  const [voucherCardData, setVoucherCardData] = useState<any>(null);
  const [expandedApproval, setExpandedApproval] = useState<string | null>(null);
  const [detailVoucher, setDetailVoucher] = useState<Voucher | null>(null);
  const [releasingMac, setReleasingMac] = useState(false);

  // ── Renew / Resell ──
  // Re-arms an expired or spent voucher under the same PIN. The backend books a
  // sale_type='renewal' row on every call, so the revenue always lands in the
  // reports — the price field therefore defaults from the voucher but is never
  // blanked out to a zero.
  const [renewTarget, setRenewTarget] = useState<Voucher | null>(null);
  const [renewDuration, setRenewDuration] = useState(60);
  const [renewPrice, setRenewPrice] = useState('');
  const [renewPayMethod, setRenewPayMethod] = useState('Cash');
  const [renewPayRef, setRenewPayRef] = useState('');
  const [renewResetQuota, setRenewResetQuota] = useState(true);
  // '' = keep the voucher on its current package. Any other value is a tier
  // swap the backend applies alongside the renewal (speed, quota, validity).
  const [renewPackageTier, setRenewPackageTier] = useState('');
  const [renewSaving, setRenewSaving] = useState(false);
  const [renewError, setRenewError] = useState('');
  // Stamp of the last successful list sync, surfaced as the "Live" pill so an
  // operator can tell at a glance whether what they are reading is current.
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [listStatus, setListStatus] = useState('all');
  const [syncingStatuses, setSyncingStatuses] = useState(false);

  const [toggleBusy, setToggleBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Voucher | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // ── High-stakes (>= $4.99) customer capture + inline holder editing ──
  // The modal intercepts generation so no >=$4.99 voucher can be created
  // without a customer name; Edit Holder patches holder_name/holder_phone via
  // PATCH /vouchers/:id (backend allowlists those two fields only).
  const HOLDER_THRESHOLD = 4.99;
  const [holderModal, setHolderModal] = useState<'single' | 'bulk' | null>(null);
  const [holderName, setHolderName] = useState('');
  const [holderPhone, setHolderPhone] = useState('');
  const [holderSaving, setHolderSaving] = useState(false);
  const [holderError, setHolderError] = useState('');
  const [editHolderVoucher, setEditHolderVoucher] = useState<Voucher | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const loadClockStatus = useCallback(() => {
    if (needsClockIn) {
      api.get<ClockStatus>('/clock-status').then(setClockStatus).catch(() => {});
    }
  }, [needsClockIn]);

  useEffect(() => {
    loadClockStatus();
    const interval = setInterval(loadClockStatus, 30000);
    return () => clearInterval(interval);
  }, [loadClockStatus]);

  useEffect(() => {
    api.get<Package[]>('/packages').then(setPackages).catch(() => {});
    if (isMgmt) {
      api.get<ApprovalRequest[]>('/vouchers/pending-approvals').then(setPendingApprovals).catch(() => {});
    }
    // Initial myApprovals fetch — record already-approved IDs so they don't trigger
    api.get<ApprovalRequest[]>('/vouchers/my-approvals').then(approvals => {
      setMyApprovals(approvals);
      for (const a of approvals) {
        if (a.status === 'approved') processedApprovalIds.current.add(a.id);
      }
    }).catch(() => {});
  }, [isMgmt]);

  // The list is the operator's live view of the network: a client redeems, a
  // handset binds, an expiry passes — none of that waits for someone to refresh
  // this screen. So it re-reads itself:
  //   1. Every page is walked. The endpoint defaults to 25 rows and this UI has
  //      no pager, so a single call silently hid everything older than the
  //      newest page — which is why already-bound codes looked like they had
  //      vanished from the list.
  //   2. On an interval, merging into any open detail sheet so the drawer never
  //      contradicts the row behind it.
  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      try {
        const all: Voucher[] = [];
        // 200 is the server's cap; loop until a short page ends the walk.
        for (let page = 1; page <= 20; page++) {
          const data = await api.get<{ vouchers: Voucher[] }>(`/vouchers?pageSize=200&page=${page}`);
          const rows = data?.vouchers ?? [];
          all.push(...rows);
          if (rows.length < 200) break;
        }
        if (cancelled) return;
        setVouchers(all);
        setLastSyncedAt(new Date());
        setDetailVoucher(prev => (prev ? all.find(r => r.id === prev.id) ?? prev : prev));
      } catch {
        // A dropped request keeps the last good snapshot on screen rather than
        // blanking a list the operator is part-way through reading.
      }
    };

    sync();
    const interval = setInterval(sync, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Poll myApprovals to detect newly-approved items and show card/bulk results
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const approvals = await api.get<ApprovalRequest[]>('/vouchers/my-approvals');
        setMyApprovals(approvals);
        for (const a of approvals) {
          if (a.status === 'approved' && !processedApprovalIds.current.has(a.id)) {
            processedApprovalIds.current.add(a.id);
const codes = a.voucher_data?.codes;
              const code = a.voucher_data?.code;
              if (a.request_type === 'single' && (code || codes?.[0])) {
                const pkg = packages.find(p => p.tier_name === a.package_tier);
                setVoucherCardData({
                  code: lc(code || codes?.[0]),
                package_tier: a.package_tier,
                price_amount: a.price_amount?.toString() || '',
                max_uses: a.max_uses,
                duration_min: pkg?.duration_min || 60,
                bandwidth_mbps_up: pkg?.bandwidth_mbps_up || 2,
                bandwidth_mbps_down: pkg?.bandwidth_mbps_down || 5,
                data_limit_gb: pkg?.data_limit_gb ?? null,
                is_uncapped: pkg?.is_uncapped ?? false,
              });
              showToast({ title: 'Voucher Approved', message: `"${lc(code || codes?.[0])}" is ready to share`, type: 'success' });
              playVoucherSound();
            } else if (a.request_type === 'bulk' && codes?.length) {
              const pkg = packages.find(p => p.tier_name === a.package_tier);
              setBulkResults(codes.map((c: string) => ({
                code: c,
                package_tier: a.package_tier,
                price_amount: a.price_amount?.toString() || '',
                duration_min: pkg?.duration_min || 60,
                bandwidth_mbps_up: pkg?.bandwidth_mbps_up || 2,
                bandwidth_mbps_down: pkg?.bandwidth_mbps_down || 5,
                data_limit_gb: pkg?.data_limit_gb ?? null,
                is_uncapped: pkg?.is_uncapped ?? false,
                max_uses: a.max_uses,
              })));
              showToast({ title: 'Bulk Vouchers Approved', message: `${codes.length} voucher(s) ready to share`, type: 'success' });
              playVoucherSound();
            }
          }
        }
      } catch {}
    }, 15000);
    return () => clearInterval(interval);
  }, [packages]);

  const generateCode = useCallback((tier: string) => {
    const prefix = tier.slice(0, 4);
    const rand = Math.random().toString(36).substring(2, 8);
    return (prefix + '-' + rand).toLowerCase();
  }, []);

  const selectPackage = useCallback((tier: string) => {
    const pkg = packages.find(p => p.tier_name === tier) || null;
    setSelectedPkg(pkg);
    if (pkg) {
      setVCode(generateCode(pkg.tier_name));
      setVPrice(pkg.price_amount);
      if (!['PreCore', 'PreBizPlus', 'PreFam', 'PreBizPro', 'PreMax', 'PreUltra', 'PreExecutive'].includes(pkg.tier_name)) setVUses(1);
    }
  }, [packages, generateCode]);

  const isClockedIn = !needsClockIn || clockStatus?.clockedIn === true;

  const handleClockIn = async () => {
    try {
      await api.post('/clock-in');
      await loadClockStatus();
      setVStatus({ type: 'success', msg: 'Clocked in successfully' });
    } catch (err: any) {
      setVStatus({ type: 'error', msg: err.message || 'Failed to clock in' });
    }
  };

  const handleClockOut = async () => {
    try {
      await api.post('/clock-out');
      await loadClockStatus();
      setVStatus({ type: 'success', msg: 'Clocked out' });
    } catch (err: any) {
      setVStatus({ type: 'error', msg: err.message || 'Failed to clock out' });
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPkg) { setVStatus({ type: 'error', msg: 'Select a package tier' }); return; }
    if (!vCode) { setVStatus({ type: 'error', msg: 'Code required' }); return; }
    if (!vPrice) { setVStatus({ type: 'error', msg: 'Sale price required' }); return; }
    if (vUses < 1) { setVStatus({ type: 'error', msg: 'Max uses must be at least 1' }); return; }
    if (needsClockIn && !isClockedIn) { setVStatus({ type: 'error', msg: 'You must clock in before selling vouchers.' }); return; }

    // High-stakes gate: >= $4.99 intercepts and demands customer details
    // BEFORE the voucher is generated.
    if (parseFloat(vPrice) >= HOLDER_THRESHOLD) {
      setHolderError('');
      setHolderModal('single');
      return;
    }
    await submitCreate('', '');
  };

  // Generation half of handleCreate — runs only after the holder gate (or for
  // sub-threshold sales, which skip the modal entirely).
  const submitCreate = async (hName: string, hPhone: string): Promise<boolean> => {
    if (!selectedPkg) return false;
    setCreating(true);
    setVStatus(null);
    try {
      const data = await api.post<any>('/vouchers', {
        code: vCode,
        maxUses: vUses,
        packageTier: selectedPkg.tier_name,
        priceAmount: parseFloat(vPrice),
        paymentMethod: vPayMethod,
        paymentReference: IS_MOBILE_MONEY(vPayMethod) ? vPayRef.trim() : undefined,
        holderName: hName.trim() || undefined,
        holderPhone: hPhone.trim() || undefined,
      });
      setVStatus({ type: 'success', msg: `Voucher "${lc(data.code)}" created successfully.` });
      setVoucherCardData(data);
      setSelectedPkg(null);
      setVCode('');
      setVPrice('');
      setVUses(1);
      setVPayMethod('Cash');
      setVPayRef('');
      api.get<{ vouchers: Voucher[] }>('/vouchers').then(data => setVouchers(data.vouchers)).catch(() => {});
      showToast({ title: 'Voucher Created', message: `"${lc(data.code)}" created successfully`, type: 'success' });
      playVoucherSound();
      return true;
    } catch (err: any) {
      if (err.requiresApproval) {
        setVStatus({ type: 'approval', msg: err.message || 'Approval required' });
      } else {
        setVStatus({ type: 'error', msg: err.message || 'Failed to create voucher' });
      }
      return false;
    } finally {
      setCreating(false);
    }
  };

  // Modal confirm: validates, then generates with the captured customer.
  const submitHolderModal = async () => {
    if (!holderName.trim()) { setHolderError('Customer full name is required for this sale.'); return; }
    if (holderPhone.trim() && !/^\+?[0-9\s-]{7,20}$/.test(holderPhone.trim())) {
      setHolderError('Enter a valid phone number, e.g. +263771234567.');
      return;
    }
    setHolderSaving(true);
    setHolderError('');
    const ok = holderModal === 'single'
      ? await submitCreate(holderName, holderPhone)
      : await submitBulk(holderName, holderPhone);
    setHolderSaving(false);
    if (ok) {
      setHolderModal(null);
      setHolderName('');
      setHolderPhone('');
    }
  };

  // Inline holder edit — PATCH allowlists holderName/holderPhone server-side,
  // so PIN, price and expiry can never be touched from here.
  const saveEditHolder = async () => {
    if (!editHolderVoucher) return;
    setEditSaving(true);
    setEditError('');
    try {
      const id = editHolderVoucher.id;
      const name = editName.trim();
      const phone = editPhone.trim();
      await api.patch(`/vouchers/${id}`, { holderName: name, holderPhone: phone });
      setEditHolderVoucher(null);
      setVouchers(prev => prev.map(x => (x.id === id ? { ...x, holder_name: name || null, holder_phone: phone || null } : x)));
      setDetailVoucher(prev => (prev && prev.id === id ? { ...prev, holder_name: name || null, holder_phone: phone || null } : prev));
      showToast({ title: 'Holder Updated', message: `"${lc(editHolderVoucher.code)}" holder details saved`, type: 'success' });
    } catch (err: any) {
      setEditError(err.message || 'Failed to update holder');
    } finally {
      setEditSaving(false);
    }
  };

  const handleApprovalRequest = async () => {
    if (!selectedPkg) return;
    try {
      const data = await api.post<any>('/vouchers/request-approval', {
        requestType: 'single',
        packageTier: selectedPkg.tier_name,
        priceAmount: vPrice ? parseFloat(vPrice) : undefined,
        code: vCode,
        maxUses: vUses,
        paymentMethod: vPayMethod,
        paymentReference: IS_MOBILE_MONEY(vPayMethod) ? vPayRef.trim() : undefined,
      });
      setVStatus({ type: 'success', msg: '✓ ' + data.message });
      api.get<ApprovalRequest[]>('/vouchers/my-approvals').then(setMyApprovals).catch(() => {});
    } catch (err: any) {
      setVStatus({ type: 'error', msg: err.message || 'Failed to submit request' });
    }
  };

  const handleBulk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bulkTier) { setBulkStatus({ type: 'error', msg: 'Select a package tier' }); return; }
    if (bulkCount < 2 || bulkCount > 100) { setBulkStatus({ type: 'error', msg: 'Count must be 2-100' }); return; }
    if (needsClockIn && !isClockedIn) { setBulkStatus({ type: 'error', msg: 'You must clock in before selling vouchers.' }); return; }

    // High-stakes gate (unit price: custom price, else package price)
    const bulkPkg = packages.find(p => p.tier_name === bulkTier);
    const unitPrice = bulkPrice ? parseFloat(bulkPrice) : parseFloat(bulkPkg?.price_amount || '0');
    if (unitPrice >= HOLDER_THRESHOLD) {
      setHolderError('');
      setHolderModal('bulk');
      return;
    }
    await submitBulk('', '');
  };

  const submitBulk = async (hName: string, hPhone: string): Promise<boolean> => {
    setBulkCreating(true);
    setBulkStatus(null);
    try {
      const data = await api.post<any>('/vouchers/bulk', {
        count: bulkCount,
        packageTier: bulkTier,
        priceAmount: bulkPrice ? parseFloat(bulkPrice) : undefined,
        paymentMethod: bulkPayMethod,
        paymentReference: IS_MOBILE_MONEY(bulkPayMethod) ? bulkPayRef.trim() : undefined,
        holderName: hName.trim() || undefined,
        holderPhone: hPhone.trim() || undefined,
      });
      setBulkStatus({ type: 'success', msg: data.message });
      setBulkResults(data.vouchers);
      api.get<{ vouchers: Voucher[] }>('/vouchers').then(data => setVouchers(data.vouchers)).catch(() => {});
      showToast({ title: 'Bulk Vouchers', message: data.message, type: 'success' });
      playVoucherSound();
      return true;
    } catch (err: any) {
      if (err.requiresApproval) {
        setBulkStatus({ type: 'approval', msg: err.message || 'Approval required' });
      } else {
        setBulkStatus({ type: 'error', msg: err.message || 'Failed to generate bulk' });
      }
      return false;
    } finally {
      setBulkCreating(false);
    }
  };

  const handleBulkApprovalRequest = async () => {
    try {
      const data = await api.post<any>('/vouchers/request-approval', {
        requestType: 'bulk',
        packageTier: bulkTier,
        priceAmount: bulkPrice ? parseFloat(bulkPrice) : undefined,
        count: bulkCount,
        paymentMethod: bulkPayMethod,
        paymentReference: IS_MOBILE_MONEY(bulkPayMethod) ? bulkPayRef.trim() : undefined,
      });
      setBulkStatus({ type: 'success', msg: '✓ ' + data.message });
      api.get<ApprovalRequest[]>('/vouchers/my-approvals').then(setMyApprovals).catch(() => {});
    } catch (err: any) {
      setBulkStatus({ type: 'error', msg: err.message || 'Failed' });
    }
  };

  const handleApprove = async (id: string) => {
    try {
      const data = await api.post<any>(`/vouchers/approvals/${id}/approve`);
      setPendingApprovals(prev => prev.filter(a => a.id !== id));
      setVStatus({ type: 'success', msg: data.message || 'Approved' });
      api.get<{ vouchers: Voucher[] }>('/vouchers').then(data => setVouchers(data.vouchers)).catch(() => {});
      showToast({ title: 'Approved', message: data.message || 'Voucher request approved', type: 'success' });
      playAlertSound();
    } catch (err: any) {
      setVStatus({ type: 'error', msg: err.message || 'Failed to approve' });
    }
  };

  const handleReject = async (id: string) => {
    try {
      const data = await api.post<any>(`/vouchers/approvals/${id}/reject`);
      setPendingApprovals(prev => prev.filter(a => a.id !== id));
      setVStatus({ type: 'success', msg: data.message || 'Rejected' });
      showToast({ title: 'Rejected', message: data.message || 'Voucher request rejected', type: 'warning' });
      playAlertSound();
    } catch (err: any) {
      setVStatus({ type: 'error', msg: err.message || 'Failed to reject' });
    }
  };

  // Releases every active device binding. The endpoint deactivates rather than
  // deletes, so the redemption history survives and re-binding the same MAC later
  // stays idempotent. It is gated on COMPANY_ADMIN server-side -- a 403 lands in
  // the catch below rather than failing silently.
  const handleReleaseMac = async (voucher: Voucher) => {
    if (releasingMac) return;
    setReleasingMac(true);
    try {
      const data = await api.post<any>(`/vouchers/${voucher.id}/reset-mac`);
      const released = Number(data?.released ?? 0);
      showToast({
        title: 'MAC bindings released',
        message: data?.message || `Released ${released} device slot(s) on ${lc(voucher.code)}`,
        type: 'success',
      });
      setDetailVoucher(prev => (prev ? { ...prev, bound_macs: [], device_count: 0, devices: [] } : prev));
      api.get<{ vouchers: Voucher[] }>('/vouchers').then(data => setVouchers(data.vouchers)).catch(() => {});
    } catch (err: any) {
      showToast({ title: 'Could not release bindings', message: err.message || 'Please try again.', type: 'error' });
    } finally {
      setReleasingMac(false);
    }
  };

  const refreshVouchers = () => {
    api.get<{ vouchers: Voucher[] }>('/vouchers').then(d => setVouchers(d.vouchers)).catch(() => {});
  };

  const syncVoucherStatuses = async () => {
    setSyncingStatuses(true);
    try {
      const result = await api.post<any>('/vouchers/sync-status');
      if (result?.errors?.length) throw new Error(result.errors[0]);
      const all: Voucher[] = [];
      for (let page = 1; page <= 20; page++) {
        const data = await api.get<{ vouchers: Voucher[] }>(`/vouchers?pageSize=200&page=${page}`);
        const rows = data?.vouchers ?? [];
        all.push(...rows);
        if (rows.length < 200) break;
      }
      setVouchers(all);
      setLastSyncedAt(new Date());
      showToast({
        title: 'Voucher statuses synced',
        message: result?.skipped
          ? 'Ruijie sync is not configured or is already running.'
          : `${result?.updated ?? 0} of ${result?.matched ?? 0} matched vouchers refreshed.`,
        type: 'success',
      });
    } catch (err: any) {
      showToast({
        title: 'Status sync failed',
        message: err?.message || 'Please try again.',
        type: 'error',
      });
    } finally {
      setSyncingStatuses(false);
    }
  };

  // Seeds the renew modal. Duration comes from the voucher's own package so a
  // renewal buys exactly what the client bought the first time; price is
  // pre-filled but editable, since a renewal is a real cash transaction.
  const openRenew = (v: Voucher) => {
    setRenewTarget(v);
    setRenewDuration(v.duration_min || 60);
    setRenewPrice(v.price_amount ? parseFloat(v.price_amount).toFixed(2) : '');
    setRenewPayMethod('Cash');
    setRenewPayRef('');
    setRenewResetQuota(true);
    setRenewPackageTier('');
    setRenewError('');
  };

  // Selecting a package pulls its validity, price, data quota and speed onto
  // the form in one go, so swapping tiers is a single choice rather than four
  // separate edits. Duration and amount stay editable afterwards.
  const applyRenewPackage = (tier: string) => {
    setRenewPackageTier(tier);
    if (!tier) return;
    const pkg = packages.find(p => p.tier_name === tier);
    if (!pkg) return;
    if (pkg.duration_min) setRenewDuration(pkg.duration_min);
    if (pkg.price_amount) setRenewPrice(parseFloat(String(pkg.price_amount)).toFixed(2));
  };
  const renewSelectedPkg = renewPackageTier
    ? packages.find(p => p.tier_name === renewPackageTier) ?? null
    : null;

  const submitRenew = async () => {
    if (!renewTarget || renewSaving) return;
    const price = parseFloat(renewPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setRenewError('Enter the amount the client paid for this renewal.');
      return;
    }
    setRenewSaving(true);
    setRenewError('');
    try {
      const data = await api.post<any>(`/vouchers/${renewTarget.id}/renew`, {
        durationMin: renewDuration,
        priceAmount: price,
        paymentMethod: renewPayMethod,
        paymentReference: renewPayRef.trim() || undefined,
        resetDataQuota: renewResetQuota,
        packageTier: renewPackageTier || undefined,
      });
      showToast({
        title: 'Voucher renewed',
        message: data?.message || `${lc(renewTarget.code)} resold for $${price.toFixed(2)} — sale recorded`,
        type: 'success',
      });
      setRenewTarget(null);
      const id = renewTarget.id;
      setVouchers(prev => prev.map(x => (x.id === id ? { ...x, ...data, sale: undefined } : x)));
      setDetailVoucher(prev => (prev && prev.id === id ? { ...prev, ...data, sale: undefined } : prev));
      refreshVouchers();
    } catch (err: any) {
      setRenewError(err.message || 'Could not renew this voucher.');
    } finally {
      setRenewSaving(false);
    }
  };

  // Disabling is reversible (the endpoint takes {disabled:false} to re-enable),
  // unlike Delete which soft-deletes and turns the code off in the same breath.
  const toggleDisable = async (v: Voucher) => {
    if (toggleBusy) return;
    const next = !v.is_disabled;
    setToggleBusy(true);
    try {
      await api.post(`/vouchers/${v.id}/disable`, { disabled: next });
      showToast({
        title: next ? 'Voucher disabled' : 'Voucher enabled',
        message: `${lc(v.code)} is now ${next ? 'blocked from redemption' : 'redeemable again'}`,
        type: next ? 'warning' : 'success',
      });
      setDetailVoucher(prev => (prev && prev.id === v.id ? { ...prev, is_disabled: next, status: next ? 'Disabled' : prev.status } : prev));
      setVouchers(prev => prev.map(x => (x.id === v.id ? { ...x, is_disabled: next, status: next ? 'Disabled' : x.status } : x)));
    } catch (err: any) {
      showToast({ title: 'Could not update voucher', message: err.message || 'Please try again.', type: 'error' });
    } finally {
      setToggleBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      const data = await api.del<any>(`/vouchers/${deleteTarget.id}`);
      showToast({ title: 'Voucher deleted', message: data?.message || `${lc(deleteTarget.code)} removed`, type: 'warning' });
      const id = deleteTarget.id;
      setDeleteTarget(null);
      setDetailVoucher(prev => (prev && prev.id === id ? null : prev));
      setVouchers(prev => prev.filter(x => x.id !== id));
    } catch (err: any) {
      showToast({ title: 'Could not delete voucher', message: err.message || 'Please try again.', type: 'error' });
    } finally {
      setDeleteBusy(false);
    }
  };

  const downloadVoucherJPEG = () => {
    if (!voucherCardData) return;
    renderVoucherJPEG(voucherCardData, user?.fullName || 'Preyone UltraNet');
  };

  const renderVoucherJPEG = async (data: any, issuedByName: string) => {
    const c = document.createElement('canvas');
    c.width = 800; c.height = 450;
    await drawVoucherCanvas(c, data, issuedByName);
    const blob = await new Promise<Blob | null>(resolve => c.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = 'voucher-' + lc(data.code) + '.jpeg';
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    setVStatus({ type: 'success', msg: `Downloaded ${lc(data.code) || 'voucher'}.jpeg` });
    setTimeout(() => setVStatus(null), 2000);
  };

  // High-quality JPEG export of a single voucher's canvas card. The PIN is
  // lowercased inside drawVoucherCanvas, so the filename uses the lowercased
  // code to keep them strict and consistent.
  const generateVoucherJpegBlob = async (voucher: Voucher): Promise<{ url: string; blob: Blob; fileName: string }> => {
    const c = document.createElement('canvas');
    c.width = 800; c.height = 450;
    await drawVoucherCanvas(c, voucher, user?.fullName || 'Preyone UltraNet');
    const blob = await new Promise<Blob | null>(resolve => c.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) throw new Error('Could not render voucher image');
    return { url: URL.createObjectURL(blob), blob, fileName: 'voucher-' + (voucher.code || 'PREYONE-XXXX').toLowerCase() + '.jpeg' };
  };

  const handleDownloadJpeg = async (voucher: Voucher) => {
    try {
      const { url, fileName } = await generateVoucherJpegBlob(voucher);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (err: any) {
      showToast({ title: 'Download failed', message: err?.message || 'Could not create the voucher JPEG.', type: 'error' });
    }
  };

  const printVoucherPdf = async (voucher: Voucher) => {
    const c = document.createElement('canvas');
    c.width = 800; c.height = 450;
    await drawVoucherCanvas(c, voucher, user?.fullName || 'Preyone UltraNet');
    const doc = new jsPDF('portrait', 'mm', 'a4');
    const imgData = c.toDataURL('image/jpeg', 0.95);
    const pw = 210, ph = 297, m = 10;
    const iw = pw - m * 2, ih = iw * 450 / 800;
    doc.addImage(imgData, 'JPEG', (pw - iw) / 2, (ph - ih) / 2, iw, ih);
    const url = URL.createObjectURL(doc.output('blob'));
    const w = window.open('', '_blank', 'width=900,height=600');
    if (!w) {
      URL.revokeObjectURL(url);
      showToast({ title: 'Pop-up blocked', message: 'Allow pop-ups, then try printing again.', type: 'error' });
      return;
    }
    w.document.write(
      '<!doctype html><html><head><title>Preyone Voucher</title>' +
      '<style>html,body{margin:0;padding:0;height:100%;}embed{display:block;width:100%;height:100%;border:0;}</style>' +
      '</head><body><embed src="' + url + '" type="application/pdf" />' +
      '<script>window.addEventListener("load",function(){setTimeout(function(){window.focus();window.print();},500);});</scr' + 'ipt>' +
      '</body></html>'
    );
    w.document.close();
  };

  const printVoucherPDF = async () => {
    if (!voucherCardData) return;
    const c = document.createElement('canvas');
    c.width = 800; c.height = 450;
    await drawVoucherCanvas(c, voucherCardData, user?.fullName || 'Preyone UltraNet');
    const doc = new jsPDF('portrait', 'mm', 'a4');
    const imgData = c.toDataURL('image/jpeg', 0.95);
    const pw = 210, ph = 297, m = 10;
    const iw = pw - m * 2, ih = iw * 450 / 800;
    doc.addImage(imgData, 'JPEG', (pw - iw) / 2, (ph - ih) / 2, iw, ih);
    doc.save('preyone-voucher-' + (voucherCardData.code || '').toLowerCase() + '.pdf');
  };

  const printBulkPDFs = async () => {
    if (!bulkResults || bulkResults.length === 0) return;
    const doc = new jsPDF('portrait', 'mm', 'a4');
    const pw = 210, ph = 297, m = 8, cols = 3, rows = 2, perPage = cols * rows;
    const cw = (pw - m * 2) / cols, ch = (ph - m * 2) / rows;
    for (let i = 0; i < bulkResults.length; i++) {
      if (i > 0 && i % perPage === 0) doc.addPage();
      const c = document.createElement('canvas');
      c.width = 800; c.height = 450;
      await drawVoucherCanvas(c, bulkResults[i], user?.fullName || 'Preyone UltraNet');
      const imgData = c.toDataURL('image/jpeg', 0.95);
      const col = i % cols, row = Math.floor(i / cols) % rows;
      const pad = 3;
      let iw = cw - pad * 2, ih = iw * 450 / 800;
      if (ih > ch - pad * 2) { ih = ch - pad * 2; iw = ih * 800 / 450; }
      const x = m + col * cw + (cw - iw) / 2;
      const y = m + row * ch + (ch - ih) / 2;
      doc.setDrawColor(210, 210, 210);
      doc.setLineWidth(0.2);
      doc.rect(m + col * cw + 1, m + row * ch + 1, cw - 2, ch - 2, 'S');
      doc.addImage(imgData, 'JPEG', x, y, iw, ih);
    }
    doc.save('preyone-bulk-vouchers.pdf');
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setVStatus({ type: 'success', msg: 'Code copied' });
    setTimeout(() => setVStatus(null), 2000);
  };

  /**
   * "Copy All" copies the voucher PIN and nothing else. Staff paste it straight
   * into WhatsApp/usernames, and the old behaviour (full multi-line voucher
   * blurb) put the package, price and URL on the clipboard instead of the code.
   */
  const copyVoucherPin = (code?: string | null) => {
    const pin = lc(code ?? '');
    if (!pin) {
      setVStatus({ type: 'error', msg: 'No voucher PIN to copy' });
      setTimeout(() => setVStatus(null), 2500);
      return;
    }
    navigator.clipboard.writeText(pin);
    setVStatus({ type: 'success', msg: `PIN ${pin} copied` });
    setTimeout(() => setVStatus(null), 2000);
  };

  const buildVoucherWaText = (v: Voucher) => [
    '*Preyone Voucher*',
    '',
    `Code: ${lc(v.code)}`,
    `Package: ${v.package_tier || 'Standard'}`,
    `Price: ${v.price_amount ? '$' + parseFloat(v.price_amount).toFixed(2) : '—'}`,
    `Duration: ${fmtDur(v.duration_min)}`,
    `Speed: ${v.bandwidth_mbps_up}/${v.bandwidth_mbps_down} Mbps`,
    `Data: ${v.is_uncapped ? 'Unlimited' : (v.data_limit_gb ?? 'Unlimited') + ' GB'}`,
    `Valid until: ${fmtDate(v.expires_at)}`,
    'Connect: https://wifi.preyone.com',
    '',
    '_Thank you for choosing Preyone_',
  ].join('\n');

  const shareWhatsApp = async (target?: Voucher) => {
    const data: any = target || voucherCardData;
    if (!data || sharingWa) return;
    const code = lc(data.code);
    if (!code) return;
    setSharingWa(true);
    setVStatus({ type: 'success', msg: 'Preparing the voucher image…' });
    try {
      // Renders the same canvas card as Download/Print and hands WhatsApp a real
      // JPEG File via the native share sheet; desktop falls back to download +
      // clipboard + WhatsApp Web (see utils/voucherShare.ts).
      const result = await shareVoucherJpeg({
        data: {
          code: data.code,
          package_tier: data.package_tier,
          price_amount: data.price_amount,
          duration_min: data.duration_min,
          is_uncapped: data.is_uncapped,
          data_limit_gb: data.data_limit_gb,
          bandwidth_mbps_up: data.bandwidth_mbps_up,
          bandwidth_mbps_down: data.bandwidth_mbps_down,
          holder_name: [data.first_name, data.last_name].filter(Boolean).join(' ') || data.alias || data.redemption_name || null,
          expires_at: data.expires_at,
          activated_at: data.activated_at,
          created_at: data.created_at,
        },
        code,
        issuedByName: user?.fullName || 'Preyone UltraNet',
        text: buildVoucherWaText(data),
      });
      setVStatus({ type: result.method === 'failed' ? 'error' : 'success', msg: result.message });
    } catch {
      setVStatus({ type: 'error', msg: 'Could not prepare the voucher image.' });
    } finally {
      setSharingWa(false);
      setTimeout(() => setVStatus(null), 6000);
    }
  };

  const copyAllVoucher = () => {
    if (!voucherCardData) return;
    copyVoucherPin(voucherCardData.code);
  };

  function buildBarcodeHtml() {
    var bars = '';
    var seq = [3, 6, 2, 7, 4];
    for (var bi = 0; bi < 32; bi++) {
      var bw = seq[bi % 5];
      bars += '<span style="width:' + (bw * 2) + 'px"></span>';
    }
    return bars;
  }

  const voucherSerialNum = voucherCardData ? voucherSerial(voucherCardData.code) : '';

  const isRestrictedTier = selectedPkg && APPROVAL_TIERS.includes(selectedPkg.tier_name);
  const createDisabled = creating || (needsClockIn && !isClockedIn && !isRestrictedTier);
  const listStatuses = ['all', 'Unused', 'Active', 'Expired', 'Disabled'];
  const filteredVouchers = listStatus === 'all'
    ? vouchers
    : vouchers.filter(v => (v.status || 'Unknown') === listStatus);

  return (
    <div className="vouchers-page">
      <div className="section-head">
        <div>
          <h2 className="section-head-title">Create Voucher</h2>
          <p className="section-head-desc">Issue new access vouchers for clients</p>
        </div>
      </div>

      {/* Clock-in / Clock-out Banner */}
      {needsClockIn && clockStatus !== null && (
        <div className={'clock-banner ' + (isClockedIn ? 'clocked-in' : 'clocked-out')}>
          <span className="clock-status-icon">{isClockedIn ? '✓' : '✕'}</span>
          <span>
            {isClockedIn
              ? 'Clocked In' + (clockStatus?.log ? ' since ' + new Date(clockStatus.log.clock_in).toLocaleTimeString() : '')
              : 'You are clocked out. You must clock in before selling vouchers.'}
          </span>
          <button className="clock-toggle-btn" onClick={isClockedIn ? handleClockOut : handleClockIn}>
            {isClockedIn ? 'Clock Out' : 'Clock In'}
          </button>
        </div>
      )}

      {/* Create Voucher Form */}
      <div className="card">
        <form onSubmit={handleCreate} className="voucher-form">
          <div className="section-head" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
            <h3 className="section-head-title" style={{ fontSize: '0.8rem' }}>Select Package Tier</h3>
            <p className="section-head-desc">Choose a plan to auto-generate voucher parameters</p>
          </div>

          <div className="package-grid">
            {packages.map(pkg => (
              <div
                key={pkg.tier_name}
                className={'package-card' + (selectedPkg?.tier_name === pkg.tier_name ? ' package-card--selected' : '')}
                onClick={() => selectPackage(pkg.tier_name)}
              >
                <div className="pkg-check"><svg viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2" fill="none" /></svg></div>
                <div className="pkg-display">{pkg.display_name}</div>
                <div className="pkg-tier">{pkg.tier_name}</div>
                <div className="pkg-price-row">
                  <span className="pkg-price money">${parseFloat(pkg.price_amount).toFixed(2)}</span>
                  <span className="pkg-currency">{pkg.billing_period}</span>
                </div>
                <div className="pkg-badges">
                  <span className="pkg-badge"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="6" cy="6" r="5" /><path d="M6 3v3l2 2" /></svg>{fmtDur(pkg.duration_min)}</span>
                  <span className="pkg-badge"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 4h10M1 8h10" /><rect x="1" y="2" width="10" height="8" rx="1" /></svg>{pkg.bandwidth_mbps_up}/{pkg.bandwidth_mbps_down} Mbps</span>
                  <span className="pkg-badge"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="1" width="8" height="10" rx="1" /><path d="M2 5h8" /></svg>{pkg.is_uncapped ? 'Unlim' : (pkg.data_limit_gb ?? '—') + 'GB'}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="voucher-code-bar">
            <div className="vcb-selected">
              <span className="vcb-pkg-badge">{selectedPkg?.tier_name || '—'}</span>
            </div>
            <div className="vcb-code">
              <label>Voucher Code</label>
              <div className="input-with-btn">
                <input type="text" value={vCode} onChange={e => setVCode(e.target.value.toLowerCase())} placeholder="Select a package" readOnly={!selectedPkg} />
                {selectedPkg && (
                  <button type="button" className="btn-icon" onClick={() => setVCode(generateCode(selectedPkg.tier_name))} title="Generate new code">
                    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 10a7 7 0 1 1-2-5" /><polyline points="17 3 17 7 13 7" /></svg>
                  </button>
                )}
              </div>
            </div>
            <div className="vcb-meta vcb-meta--price">
              <label>Sale Price</label>
              <div className="stepper">
                <button type="button" className="stepper-btn" onClick={() => setVPrice(p => Math.max(0, parseFloat(p || '0') - 0.5).toFixed(2))} disabled={!selectedPkg || createDisabled}>&minus;</button>
                <input type="text" className="stepper-input" value={vPrice || ''} placeholder="0.00" onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setVPrice(v); }} />
                <button type="button" className="stepper-btn" onClick={() => setVPrice(p => (parseFloat(p || '0') + 0.5).toFixed(2))} disabled={!selectedPkg || createDisabled}>+</button>
              </div>
            </div>
            <div className="vcb-meta vcb-meta--uses">
              <label>Max Users</label>
              <div className="stepper">
                <button type="button" className="stepper-btn" onClick={() => setVUses(u => Math.max(1, u - 1))}
                  disabled={!!(selectedPkg && !['PreCore', 'PreBizPlus', 'PreFam', 'PreBizPro', 'PreMax', 'PreUltra', 'PreExecutive'].includes(selectedPkg.tier_name))}>&minus;</button>
                <input type="number" className="stepper-input" value={vUses} min="1" max="100"
                  onChange={e => { const n = parseInt(e.target.value); if (!isNaN(n)) setVUses(Math.max(1, Math.min(100, n))); }}
                  disabled={!!(selectedPkg && !['PreCore', 'PreBizPlus', 'PreFam', 'PreBizPro', 'PreMax', 'PreUltra', 'PreExecutive'].includes(selectedPkg.tier_name))} />
                <button type="button" className="stepper-btn" onClick={() => setVUses(u => Math.min(100, u + 1))}
                  disabled={!!(selectedPkg && !['PreCore', 'PreBizPlus', 'PreFam', 'PreBizPro', 'PreMax', 'PreUltra', 'PreExecutive'].includes(selectedPkg.tier_name))} >+</button>
              </div>
            </div>
            <div className="vcb-meta">
              <label>Payment Method</label>
              <select className="form-select" style={{ height: '2.3rem', padding: '0 0.6rem' }} value={vPayMethod} onChange={e => { setVPayMethod(e.target.value); if (e.target.value === 'Cash') setVPayRef(''); }} disabled={createDisabled || !selectedPkg}>
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            {IS_MOBILE_MONEY(vPayMethod) && (
              <div className="vcb-meta" style={{ minWidth: 150 }}>
                <label>Pesepay Reference</label>
                <input type="text" className="stepper-input" value={vPayRef} placeholder="e.g. MP2609... or txn id" onChange={e => setVPayRef(e.target.value)} />
              </div>
            )}
            <button type="submit" className="btn-primary" disabled={createDisabled}>
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>

          {vStatus && (
            <div className={'form-status form-status--' + (vStatus.type === 'approval' ? 'cyan' : vStatus.type)} style={{ marginTop: '0.75rem' }}>
              {vStatus.type === 'approval' ? (
                <>
                  <strong>{vStatus.msg}</strong>
                  <br /><br />
                  <button className="btn-primary" style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }} onClick={handleApprovalRequest}>
                    Submit for Management Approval
                  </button>
                </>
              ) : vStatus.msg}
            </div>
          )}
        </form>
      </div>

      {/* Voucher Card + Download */}
      {voucherCardData && (
        <div className="voucher-card-wrap">
          <div className="preyone-voucher">
            <div className="brand-ribbon"><div className="ribbon-text">PREYONE WI-FI</div></div>
            <div className="voucher-content">
              <div className="voucher-header">
                <div className="logo-group">
                  <h1 style={{ color: '#000' }}>PREYONE</h1>
                  <p className="subtitle" style={{ color: '#000', fontWeight: 700 }}>ULTRANET WIFI CONNECTIVITY</p>
                </div>
                <div className="badge-container"><div className="access-badge">PREMIUM ACCESS</div></div>
              </div>
              <div className="specs-grid">
                <div className="spec-block" style={{ background: '#f1f5f9' }}><span className="spec-label" style={{ color: '#64748b' }}>DATA PROFILE</span><span className="spec-value" style={{ color: '#0f172a' }}>{voucherCardData.is_uncapped ? 'Unlimited' : (voucherCardData.data_limit_gb ?? 'Unlimited') + ' GB'}</span></div>
                <div className="spec-block text-right" style={{ background: '#f1f5f9' }}><span className="spec-label" style={{ color: '#64748b' }}>BANDWIDTH PROFILE</span><span className="spec-value" style={{ color: '#0f172a' }}>{voucherCardData.bandwidth_mbps_up} Mbps</span></div>
                <div className="spec-block" style={{ background: '#f1f5f9' }}><span className="spec-label" style={{ color: '#64748b' }}>SALE PRICE</span><span className="spec-value" style={{ color: '#0f172a' }}><span className="money money--sm" style={{ color: '#059669' }}>{voucherCardData.price_amount ? '$' + parseFloat(voucherCardData.price_amount).toFixed(2) : ''}</span></span></div>
                <div className="spec-block text-right" style={{ background: '#f1f5f9' }}><span className="spec-label" style={{ color: '#64748b' }}>VALIDITY TIMELINE</span><span className="spec-value highlight-blue" style={{ color: '#0284c7' }}>{fmtDur(voucherCardData.duration_min)}</span></div>
              </div>
              <div className="token-container">
                <span className="token-title" style={{ color: '#64748b' }}>WI-FI VOUCHER PIN</span>
                <div className="token-box" style={{ background: '#f8fafc', borderColor: '#cbd5e1' }}>
                  <span className="token-string" style={{ color: '#0284c7', cursor: 'pointer' }} onClick={() => copyCode(lc(voucherCardData.code))}>
                    {lc(voucherCardData.code)}
                  </span>
                </div>
              </div>
              <div className="voucher-footer">
                <div className="meta-terms">
                  <p className="infrastructure">Starlink Business Infrastructure Optimized</p>
                  <p className="support">Support Helpdesk: +263 771 327 202</p>
                </div>
                <div className="barcode-wrapper">
                  <div className="simulated-barcode" aria-hidden="true" dangerouslySetInnerHTML={{ __html: buildBarcodeHtml() }} />
                  <span className="serial-no">{voucherSerialNum}</span>
                </div>
              </div>
        </div>
      </div>

      <div className="voucher-card-actions-bar">
            <button className="btn-action btn-action--wa" onClick={() => { void shareWhatsApp(); }} disabled={sharingWa}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              {sharingWa ? 'Preparing…' : 'WhatsApp'}
            </button>
            <button className="btn-action btn-action--copy" onClick={copyAllVoucher}>
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="13" height="15" rx="2"/><polyline points="2 5 2 18 15 18"/></svg>
              Copy All
            </button>
            <button className="btn-action btn-action--download" onClick={downloadVoucherJPEG}>
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 3v12M5 10l5 5 5-5" /><path d="M3 16v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" /></svg>
              Download Voucher
            </button>
            <button className="btn-action btn-action--download" onClick={printVoucherPDF}>
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h12v12H4z"/><path d="M7 10h6M10 7v6"/></svg>
              Download PDF
            </button>
          </div>
        </div>
      )}

      {/* Bulk Section */}
      <div style={{ marginTop: '2rem' }}>
        <div className="section-head">
          <h2 className="section-head-title">Bulk Voucher Creation</h2>
          <p className="section-head-desc">Generate multiple vouchers at once (up to 100)</p>
        </div>
        <div className="card" style={{ padding: '1rem' }}>
          <form onSubmit={handleBulk} className="bulk-form">
            <div className="form-field">
              <label>Package Tier</label>
              <select value={bulkTier} onChange={e => { const t = e.target.value; setBulkTier(t); const pkg = packages.find(p => p.tier_name === t); if (pkg) setBulkPrice(pkg.price_amount); }} className="form-select">
                <option value="">Select package...</option>
                {packages.map(p => (
                  <option key={p.tier_name} value={p.tier_name}>{p.display_name} ({p.tier_name}) - ${parseFloat(p.price_amount).toFixed(2)}</option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ maxWidth: 200 }}>
              <label>Sale Price</label>
              <div className="stepper stepper--wide">
                <button type="button" className="stepper-btn" onClick={() => setBulkPrice(p => Math.max(0, parseFloat(p || '0') - 0.5).toFixed(2))} disabled={bulkCreating}>&minus;</button>
                <input type="text" className="stepper-input" value={bulkPrice || ''} placeholder="0.00" onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setBulkPrice(v); }} />
                <button type="button" className="stepper-btn" onClick={() => setBulkPrice(p => (parseFloat(p || '0') + 0.5).toFixed(2))} disabled={bulkCreating}>+</button>
              </div>
            </div>
            <div className="form-field" style={{ maxWidth: 130 }}>
              <label>Users</label>
              <div className="stepper">
                <button type="button" className="stepper-btn" onClick={() => setBulkCount(c => Math.max(2, c - 1))} disabled={bulkCreating}>&minus;</button>
                <input type="number" className="stepper-input" value={bulkCount} min="2" max="100"
                  onChange={e => { const n = parseInt(e.target.value); if (!isNaN(n)) setBulkCount(Math.max(2, Math.min(100, n))); }} />
                <button type="button" className="stepper-btn" onClick={() => setBulkCount(c => Math.min(100, c + 1))} disabled={bulkCreating}>+</button>
              </div>
            </div>
            <div className="form-field" style={{ maxWidth: 190 }}>
              <label>Payment Method</label>
              <select className="form-select" value={bulkPayMethod} onChange={e => { setBulkPayMethod(e.target.value); if (e.target.value === 'Cash') setBulkPayRef(''); }} disabled={bulkCreating}>
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            {IS_MOBILE_MONEY(bulkPayMethod) && (
              <div className="form-field" style={{ maxWidth: 200 }}>
                <label>Pesepay Reference</label>
                <input type="text" className="stepper-input" value={bulkPayRef} placeholder="e.g. MP2609... or txn id" onChange={e => setBulkPayRef(e.target.value)} />
              </div>
            )}
            <button type="submit" className="btn-primary" disabled={bulkCreating || (needsClockIn && !isClockedIn && !bulkTier)} style={{ flexShrink: 0, height: '2.3rem' }}>
              {bulkCreating ? 'Generating...' : 'Generate Bulk'}
            </button>
          </form>

          {bulkStatus && (
            <div className={'form-status form-status--' + (bulkStatus.type === 'approval' ? 'cyan' : bulkStatus.type)} style={{ marginTop: '0.75rem' }}>
              {bulkStatus.type === 'approval' ? (
                <>
                  <strong>{bulkStatus.msg}</strong><br /><br />
                  <button className="btn-primary" style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }} onClick={handleBulkApprovalRequest}>
                    Submit for Management Approval
                  </button>
                </>
              ) : bulkStatus.msg}
            </div>
          )}

          {bulkResults && (
            <div className="card" style={{ padding: '1rem', marginTop: '1rem' }}>
              <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                {bulkResults.map((v: any, i: number) => (
                  <span key={i} className="bulk-code-chip" onClick={() => copyCode(lc(v.code))} title="Click to copy">{lc(v.code)}</span>
                ))}
              </div>
              <div className="voucher-card-actions-bar" style={{ marginTop: '0.75rem' }}>
                <button className="btn-action btn-action--wa" onClick={() => {
                  const msg = bulkResults.map((v: any) => {
                    const tier = v.package_tier || 'Custom';
                    const price = v.price_amount ? ' $' + parseFloat(v.price_amount).toFixed(2) : '';
                    return 'Code: ' + lc(v.code) + ' | ' + tier + price;
                  }).join('%0A');
                  window.open('https://wa.me/?text=' + '*Preyone Bulk Vouchers*%0A%0A' + msg + '%0A%0A_Thank you for choosing Preyone_', '_blank');
                }}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                  WhatsApp
                </button>
                <button className="btn-action btn-action--copy" onClick={() => {
                  const all = bulkResults.map((v: any) => v.code).join('\n');
                  navigator.clipboard.writeText(all);
                  setBulkStatus({ type: 'success', msg: 'All codes copied' });
                }}>
                  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="13" height="15" rx="2"/><polyline points="2 5 2 18 15 18"/></svg>
                  Copy All
                </button>
                <button className="btn-action btn-action--download" onClick={() => {
                  bulkResults.forEach((v: any, i: number) => {
                    setTimeout(() => renderVoucherJPEG(v, user?.fullName || 'Preyone UltraNet'), i * 500);
                  });
                  setBulkStatus({ type: 'success', msg: 'Downloading ' + bulkResults.length + ' vouchers...' });
                }}>
                  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 3v12M5 10l5 5 5-5" /><path d="M3 16v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" /></svg>
                  Download Vouchers
                </button>
                <button className="btn-action btn-action--download" onClick={() => { printBulkPDFs(); setBulkStatus({ type: 'success', msg: 'Generating PDF with ' + bulkResults.length + ' vouchers...' }); }}>
                  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h12v12H4z"/><path d="M7 10h6M10 7v6"/></svg>
                  Download PDFs
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Pending Approvals (Manager/CEO) */}
      {isMgmt && (
        <div style={{ marginTop: '2rem' }}>
          <div className="section-head">
            <h2 className="section-head-title">Pending Voucher Approvals</h2>
            <p className="section-head-desc">Staff requests awaiting your authorization</p>
          </div>
          {pendingApprovals.length > 0 ? (
            <div className="card card-table approvals-scroll">
              <table className="data-table">
                <thead><tr><th>Staff</th><th>Type</th><th>Package</th><th>Amount</th><th>Count</th><th>Requested</th><th>Actions</th></tr></thead>
                <tbody>
                  {pendingApprovals.map(a => (
                    <tr key={a.id}>
                      <td style={{ color: '#fff', fontWeight: 600 }}>{a.requested_by_name}</td>
                      <td>{a.request_type}</td>
                      <td>{a.package_tier}</td>
                      <td><span className="money money--sm">{a.price_amount ? '$' + Number(a.price_amount).toFixed(2) : '—'}</span></td>
                      <td>{a.voucher_count ?? 1}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-dim)' }}>{a.created_at ? new Date(a.created_at).toLocaleString() : ''}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn-sm btn-approve" onClick={() => handleApprove(a.id)}>
                            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 4L6 12l-3-3"/></svg>
                            Approve
                          </button>
                          <button className="btn-sm btn-reject" onClick={() => handleReject(a.id)}>
                            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="🕐" title="No Pending Approvals" message="No approval requests at the moment." />
          )}
        </div>
      )}

      {/* My Approval Requests */}
      {!isMgmt && (
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>My Approval Requests</div>
        {myApprovals.length > 0 ? (
          <div className="card-table">
            <table className="data-table">
              <thead><tr><th>Code</th><th>Package</th><th>Type</th><th>Amount</th><th>Status</th><th>Created</th><th>Approved By</th></tr></thead>
              <tbody>
                {myApprovals.map((a: ApprovalRequest) => {
                  const isExpanded = expandedApproval === a.id;
                  const codes = (a.voucher_data?.codes || (a.voucher_data?.code ? [a.voucher_data.code] : [])).map(c => lc(c));
                  const isApproved = a.status === 'approved' && codes.length > 0;
                  const pkg = packages.find(p => p.tier_name === a.package_tier);
                  return (
                    <Fragment key={a.id}>
                      <tr className={isExpanded ? 'row-selected' : ''}>
                        <td>
                          {isApproved ? (
                            <span className="code-cell clickable" onClick={() => setExpandedApproval(isExpanded ? null : a.id)} style={{ cursor: 'pointer', borderBottom: '1px dashed var(--text-muted)' }}>
                              {codes.length === 1 ? codes[0] : codes[0] + ' +' + (codes.length - 1) + ' more'}
                            </span>
                          ) : (
                            <span className="code-cell">{lc(a.voucher_data?.code) || '—'}</span>
                          )}
                        </td>
                        <td>{a.package_tier || '—'}</td>
                        <td style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-dim)' }}>{a.request_type || '—'}</td>
                        <td><span className="money money--sm">{a.price_amount ? '$' + Number(a.price_amount).toFixed(2) : '—'}</span></td>
                        <td><span className={'badge badge--' + (a.status === 'approved' ? 'yes' : a.status === 'rejected' ? 'no' : 'warn')}>{a.status}</span></td>
                        <td>{fmtDate(a.created_at)}</td>
                        <td>{a.approved_by_name || '—'}</td>
                      </tr>
                      {isExpanded && (
                        <tr className="expand-row">
                          <td colSpan={7}>
                            <div style={{ padding: '1rem 1.25rem' }}>
                              {codes.length > 1 && (
                                <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                                  {codes.map((c, i) => (
                                    <span key={i} className="bulk-code-chip" onClick={() => copyCode(c)} title="Click to copy">{c}</span>
                                  ))}
                                </div>
                              )}
                              <div className="voucher-card-actions-bar" style={{ marginTop: 0 }}>
                                <button className="btn-action btn-action--wa" onClick={() => {
                                  const msg = codes.map((c: string) => {
                                    const tier = a.package_tier || 'Custom';
                                    const price = a.price_amount ? ' $' + Number(a.price_amount).toFixed(2) : '';
                                    return 'Code: ' + c + ' | ' + tier + price;
                                  }).join('%0A');
                                  window.open('https://wa.me/?text=' + '*Preyone Vouchers*%0A%0A' + msg + '%0A%0A_Thank you for choosing Preyone_', '_blank');
                                }}>
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                                  WhatsApp
                                </button>
                                <button className="btn-action btn-action--copy" onClick={() => {
                                  navigator.clipboard.writeText(codes.join('\n'));
                                  showToast({ title: 'Copied', message: 'All codes copied', type: 'success' });
                                }}>
                                  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="13" height="15" rx="2"/><polyline points="2 5 2 18 15 18"/></svg>
                                  Copy All
                                </button>
                                <button className="btn-action btn-action--download" onClick={() => {
                                  codes.forEach((c: string, i: number) => {
                                    setTimeout(() => renderVoucherJPEG({
                                      code: c,
                                      package_tier: a.package_tier,
                                      price_amount: a.price_amount?.toString() || '',
                                      max_uses: a.max_uses,
                                      duration_min: pkg?.duration_min || 60,
                                      bandwidth_mbps_up: pkg?.bandwidth_mbps_up || 2,
                                      bandwidth_mbps_down: pkg?.bandwidth_mbps_down || 5,
                                      data_limit_gb: pkg?.data_limit_gb ?? null,
                                      is_uncapped: pkg?.is_uncapped ?? false,
                                    }, user?.fullName || 'Preyone UltraNet'), i * 500);
                                  });
                                  showToast({ title: 'Downloading', message: 'Downloading ' + codes.length + ' voucher(s)...', type: 'success' });
                                }}>
                                  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 3v12M5 10l5 5 5-5" /><path d="M3 16v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" /></svg>
                                  {codes.length > 1 ? 'Download Vouchers' : 'Download Voucher'}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>No approval requests yet.</div>
        )}
      </div>
      )}

      {/* Voucher List */}
      <div className="section-head" style={{ marginTop: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <h2 className="section-head-title" style={{ margin: 0 }}>Voucher List</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <select
            className="form-select"
            aria-label="Filter vouchers by status"
            value={listStatus}
            onChange={e => setListStatus(e.target.value)}
            style={{ width: 140, padding: '0.35rem 0.5rem', fontSize: '0.8rem' }}
          >
            {listStatuses.map(status => (
              <option key={status} value={status}>{status === 'all' ? 'All statuses' : status}</option>
            ))}
          </select>
          {canManageVoucher && (
            <button
              type="button"
              className="btn-sm"
              onClick={syncVoucherStatuses}
              disabled={syncingStatuses}
              title="Pull the latest usage, online state and expiry from Ruijie Cloud for online and staff-issued vouchers."
            >
              {syncingStatuses ? 'Syncing…' : 'Sync Statuses'}
            </button>
          )}
          <span
            className="live-pill"
            title="Re-reads every 10 seconds, so redemptions, bound devices and statuses stay current without a manual reload."
          >
            <span className="live-dot" />
            <span className="live-pill__label">Live</span>
            <span className="live-pill__time">{lastSyncedAt ? `synced ${lastSyncedAt.toLocaleTimeString()}` : 'syncing…'}</span>
          </span>
        </div>
      </div>
      <div className="card card-table">
        {vouchers.length === 0 ? (
          <div className="table-empty"><p>No vouchers created yet.</p></div>
        ) : filteredVouchers.length === 0 ? (
          <div className="table-empty"><p>No vouchers match this status.</p></div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Code</th><th>Status</th><th>Price</th><th>Duration</th><th>Bandwidth</th><th>Data</th><th>Max Uses</th><th>Used</th><th>Devices</th><th>Package</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>
              {filteredVouchers.map(v => {
                const bound = (v.device_count ?? 0) > 0;
                const maxDevices = v.effective_max_devices ?? v.max_devices;
                const uses = v.used_count || 0;
                const maxUses = Math.max(1, v.max_uses || 1);
                const usedPct = Math.min(100, Math.round((uses / maxUses) * 100));
                return (
                <tr key={v.id}>
                  <td><span className="code-cell" onClick={() => copyCode(lc(v.code))} title="Click to copy">{lc(v.code)}</span></td>
                  <td>
                    <span className="cell-badges">
                      <span className={`badge badge--${statusTone(v.status)}`}>{v.status || 'Unknown'}</span>
                      {bound && (
                        <span className="badge badge--live" title="Bound to at least one device right now">
                          <span className="live-dot" />In use
                        </span>
                      )}
                    </span>
                  </td>
                  <td><span className="money money--sm">{v.price_amount ? '$' + parseFloat(v.price_amount).toFixed(2) : '—'}</span></td>
                  <td>{fmtDur(v.duration_min)}</td>
                  <td>{v.bandwidth_mbps_up}/{v.bandwidth_mbps_down} Mbps</td>
                  <td>{v.is_uncapped ? 'Unlimited' : (v.data_limit_gb ?? 'Unlimited') + ' GB'}</td>
                  <td>{v.max_uses}</td>
                  <td>
                    <span className="used-cell">
                      <span className="used-bar"><span className="used-bar__fill" style={{ width: `${usedPct}%` }} /></span>
                      <span className="used-cell__n">{uses}/{v.max_uses}</span>
                    </span>
                  </td>
                  <td>
                    <span
                      className={`dev-chip ${bound ? 'dev-chip--live' : 'dev-chip--idle'}`}
                      title={`${v.device_count ?? 0} of ${maxDevices ?? '—'} device slots in use`}
                    >
                      {bound && <span className="live-dot" />}
                      {v.device_count ?? 0}/{maxDevices ?? '—'}
                    </span>
                  </td>
                  <td>{v.package_tier || <span className="muted">—</span>}</td>
                  <td>{fmtDate(v.created_at)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="btn-sm"
                        onClick={() => setDetailVoucher(v)}
                        aria-label={`View details for voucher ${lc(v.code)}`}
                      >
                        Details
                      </button>
                      <button
                        className="btn-sm"
                        onClick={() => {
                          setEditHolderVoucher(v);
                          setEditName(v.holder_name || '');
                          setEditPhone(v.holder_phone || '');
                          setEditError('');
                        }}
                        aria-label={`Edit holder for voucher ${lc(v.code)}`}
                      >
                        Edit Holder
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── High-stakes (>= $4.99) customer capture — gates generation ── */}
      {holderModal && (() => {
        const gatePrice = holderModal === 'single'
          ? parseFloat(vPrice || '0')
          : (bulkPrice ? parseFloat(bulkPrice) : parseFloat(packages.find(p => p.tier_name === bulkTier)?.price_amount || '0'));
        return (
          <Modal
            open
            onClose={() => { if (!holderSaving) setHolderModal(null); }}
            title={holderModal === 'single' ? 'Customer Details Required' : 'Batch Customer Details'}
          >
            <div className="holder-capture">
              <p className="holder-capture__lead">
                This sale is <strong>${gatePrice.toFixed(2)}</strong>{holderModal === 'bulk' ? ' per voucher' : ''} — record the customer before the voucher{holderModal === 'bulk' ? 's are' : ' is'} generated.
              </p>
              <label className="holder-capture__label" htmlFor="holder-name-input">Customer Full Name / Holder Name *</label>
              <input
                id="holder-name-input"
                className="holder-capture__input"
                value={holderName}
                onChange={e => setHolderName(e.target.value)}
                placeholder="e.g. Tendai Moyo"
                maxLength={120}
                autoFocus
              />
              <label className="holder-capture__label" htmlFor="holder-phone-input">Phone Number</label>
              <input
                id="holder-phone-input"
                className="holder-capture__input"
                value={holderPhone}
                onChange={e => setHolderPhone(e.target.value)}
                placeholder="+263 77 123 4567"
                inputMode="tel"
                maxLength={32}
              />
              {holderError && <p className="holder-capture__error" role="alert">{holderError}</p>}
              <div className="holder-capture__actions">
                <button className="btn-sm" onClick={() => setHolderModal(null)} disabled={holderSaving}>Cancel</button>
                <button
                  className="btn-action btn-action--download"
                  onClick={submitHolderModal}
                  disabled={holderSaving || !holderName.trim()}
                >
                  {holderSaving ? 'Generating…' : 'Confirm & Generate'}
                </button>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* ── Edit Holder (row action → PATCH /vouchers/:id) ── */}
      {editHolderVoucher && (
        <Modal
          open
          onClose={() => { if (!editSaving) setEditHolderVoucher(null); }}
          title={`Edit Holder — ${lc(editHolderVoucher.code)}`}
        >
          <div className="holder-capture">
            <p className="holder-capture__lead">
              Updates <strong>holder name</strong> and <strong>phone</strong> only. PIN, price, expiry and uses stay locked.
            </p>
            <label className="holder-capture__label" htmlFor="edit-holder-name">Customer Full Name / Holder Name</label>
            <input
              id="edit-holder-name"
              className="holder-capture__input"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              placeholder="e.g. Tendai Moyo"
              maxLength={120}
              autoFocus
            />
            <label className="holder-capture__label" htmlFor="edit-holder-phone">Phone Number</label>
            <input
              id="edit-holder-phone"
              className="holder-capture__input"
              value={editPhone}
              onChange={e => setEditPhone(e.target.value)}
              placeholder="+263 77 123 4567"
              inputMode="tel"
              maxLength={32}
            />
            {editError && <p className="holder-capture__error" role="alert">{editError}</p>}
            <div className="holder-capture__actions">
              <button className="btn-sm" onClick={() => setEditHolderVoucher(null)} disabled={editSaving}>Cancel</button>
              <button
                className="btn-action btn-action--download"
                onClick={saveEditHolder}
                disabled={editSaving || (!editName.trim() && !editPhone.trim())}
              >
                {editSaving ? 'Saving…' : 'Save Holder'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {detailVoucher && (() => {
        const v = detailVoucher;
        const maxDevices = v.effective_max_devices ?? v.max_devices ?? null;
        const macs = Array.isArray(v.bound_macs) ? v.bound_macs : [];
        const gb = (b?: number | null) => (b == null ? null : (b / (1024 ** 3)).toFixed(2) + ' GB');
        const trafficUsed = gb(v.traffic_used_bytes);
        const trafficTotal = v.traffic_total_bytes == null ? null : gb(v.traffic_total_bytes);
        const holderName = [v.first_name, v.last_name].filter(Boolean).join(' ') || v.alias || null;
        // Redemption row is the source of truth for the person + MAC + login time;
        // the users account (if any) only supplements it.
        const redemptionName = v.redemption_name || holderName || null;
        const redemptionMac = v.redemption_mac || v.mac_address || null;
        const redemptionAt = v.redemption_at || v.first_redeemed_at || null;
        const theRedemptions = Array.isArray(v.redemptions) ? v.redemptions : [];
        const devices = (Array.isArray(v.devices) && v.devices.length > 0)
          ? v.devices
          : macs.map(m => ({ mac_address: m, label: null, is_active: true, bound_at: null, last_seen_at: null, unbound_at: null }));

        return (
          <Modal open onClose={() => setDetailVoucher(null)} title={`Voucher ${lc(v.code)}`} wide>
            <div className="voucher-detail">
              <div className="vd-head">
                <div className="vd-code" onClick={() => copyCode(lc(v.code))} title="Click to copy">{lc(v.code)}</div>
                <span className="vd-badges">
                  <span className={`badge badge--${statusTone(v.status)}`}>{v.status || 'Unknown'}</span>
                  {(v.device_count ?? 0) > 0 && (
                    <span className="badge badge--live"><span className="live-dot" />In use</span>
                  )}
                </span>
              </div>

              <div className="vd-grid">
                <div className="vd-cell"><span className="vd-label">Price</span><span className="vd-value">{v.price_amount ? '$' + parseFloat(v.price_amount).toFixed(2) : '—'}</span></div>
                <div className="vd-cell"><span className="vd-label">Duration</span><span className="vd-value">{fmtDur(v.duration_min)}</span></div>
                <div className="vd-cell"><span className="vd-label">Bandwidth</span><span className="vd-value">{v.bandwidth_mbps_up}/{v.bandwidth_mbps_down} Mbps</span></div>
                <div className="vd-cell"><span className="vd-label">Data</span><span className="vd-value">{v.is_uncapped ? 'Unlimited' : (v.data_limit_gb ?? 'Unlimited') + ' GB'}</span></div>
                <div className="vd-cell"><span className="vd-label">Uses</span><span className="vd-value">{v.used_count}/{v.max_uses}</span></div>
                <div className="vd-cell"><span className="vd-label">Devices</span><span className="vd-value">{(v.device_count ?? 0)}/{maxDevices ?? '—'}</span></div>
                <div className="vd-cell"><span className="vd-label">Package</span><span className="vd-value">{v.package_tier || '—'}</span></div>
                <div className="vd-cell"><span className="vd-label">Created</span><span className="vd-value">{fmtDate(v.created_at)}</span></div>
                <div className="vd-cell"><span className="vd-label">Activated</span><span className="vd-value">{v.activated_at ? fmtDate(v.activated_at) : '—'}</span></div>
                <div className="vd-cell"><span className="vd-label">Last seen</span><span className="vd-value">{v.last_seen_at ? fmtDate(v.last_seen_at) : '—'}</span></div>
                <div className="vd-cell"><span className="vd-label">First redeemed</span><span className="vd-value">{v.first_redeemed_at ? fmtDate(v.first_redeemed_at) : '—'}</span></div>
                <div className="vd-cell"><span className="vd-label">Expires</span><span className="vd-value">{fmtDate(v.expires_at)}</span></div>
              </div>

              {(redemptionName || v.phone || redemptionMac || redemptionAt || trafficUsed || theRedemptions.length > 0) && (
                <section className="vd-section">
                  <h4 className="vd-section-title">Redemption</h4>
                  <div className="vd-grid">
                    <div className="vd-cell"><span className="vd-label">Holder</span><span className="vd-value">{redemptionName || '—'}</span></div>
                    <div className="vd-cell"><span className="vd-label">Phone</span><span className="vd-value">{v.phone || '—'}</span></div>
                    <div className="vd-cell"><span className="vd-label">MAC</span><span className="vd-value vd-mono">{redemptionMac || '—'}</span></div>
                    <div className="vd-cell"><span className="vd-label">Redeemed on</span><span className="vd-value">{redemptionAt ? fmtDate(redemptionAt) : '—'}</span></div>
                    <div className="vd-cell"><span className="vd-label">Traffic</span><span className="vd-value">{trafficUsed ? `${trafficUsed}${trafficTotal ? ' / ' + trafficTotal : ''}` : '—'}</span></div>
                  </div>
                  {theRedemptions.length > 0 && (
                    <>
                      <p className="vd-count">{theRedemptions.length} activation{theRedemptions.length === 1 ? '' : 's'} recorded</p>
                      <ul className="vd-macs">
                        {theRedemptions.map((red, i) => (
                          <li key={i}>
                            {red.full_name || 'Unknown person'}
                            {red.mac_address ? ` · ${red.mac_address}` : ''}
                            {red.ip_address ? ` · ${red.ip_address}` : ''}
                            {red.redeemed_at ? ` · ${fmtDate(red.redeemed_at)}` : ''}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}

              <section className="vd-section">
                <h4 className="vd-section-title">Device bindings</h4>
                <p className="vd-count">{(v.device_count ?? macs.length)} of {maxDevices ?? '—'} device slot{(maxDevices ?? 2) === 1 ? '' : 's'} in use</p>
                {devices.length > 0 ? (
                  <ul className="vd-macs">
                    {devices.map(d => (
                      <li key={d.mac_address}>
                        <span className="vd-mono">{d.mac_address}</span>
                        {d.label ? ` · ${d.label}` : ''}
                        {d.bound_at ? ` · bound ${fmtDate(d.bound_at)}` : ''}
                        {d.last_seen_at ? ` · last seen ${fmtDate(d.last_seen_at)}` : ''}
                        {!d.is_active ? ' · released' : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No devices currently bound.</p>
                )}
                {canManageVoucher && (
                  <button
                    className="btn-sm btn-reject"
                    onClick={() => handleReleaseMac(v)}
                    disabled={releasingMac || (v.device_count ?? macs.length) === 0}
                  >
                    {releasingMac ? 'Releasing…' : 'Release all bindings'}
                  </button>
                )}
              </section>

              <section className="vd-section">
                <h4 className="vd-section-title">Share &amp; Notify</h4>
                <p className="vd-count">Download, print, or send this voucher as an image.</p>
                <div className="vd-actions">
                  <button className="btn-sm" onClick={() => copyVoucherPin(v.code)} title="Copy the voucher PIN only">
                    Copy All
                  </button>
                  <button className="btn-action btn-action--download" onClick={() => handleDownloadJpeg(v)}>
                    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 3v12M5 10l5 5 5-5" /><path d="M3 16v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1" /></svg>
                    Download JPEG
                  </button>
                  <button className="btn-action btn-action--print" onClick={() => printVoucherPdf(v)}>
                    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h12v12H4z" /><path d="M7 10h6M10 7v6" /></svg>
                    Print
                  </button>
                  <button className="btn-action btn-action--wa" onClick={() => { void shareWhatsApp(v); }} aria-label="Share voucher on WhatsApp" title="Share on WhatsApp" disabled={sharingWa}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                    <span className="vd-action-label">{sharingWa ? 'Preparing…' : 'Send via WhatsApp'}</span>
                  </button>
                </div>
              </section>

              {canManageVoucher && (
                <section className="vd-section">
                  <h4 className="vd-section-title">Manage</h4>
                  <p className="vd-count">
                    Renew keeps this PIN, buys the client another period and books the payment as a new sale.
                    Disable blocks redemption but keeps the voucher (and its history) intact.
                  </p>
                  <div className="vd-actions">
                    <button className="btn-sm btn-approve" onClick={() => openRenew(v)}>
                      Renew / Resell
                    </button>
                    <button
                      className={`btn-sm ${v.is_disabled ? 'btn-approve' : 'btn-reject'}`}
                      disabled={toggleBusy}
                      onClick={() => toggleDisable(v)}
                    >
                      {toggleBusy ? '…' : v.is_disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button className="btn-sm btn-danger" onClick={() => setDeleteTarget(v)}>
                      Delete
                    </button>
                  </div>
                </section>
              )}
            </div>
          </Modal>
        );
      })()}

      {/* ── Renew / Resell (POST /vouchers/:id/renew) ──
          Same PIN, new period, and the payment is written to `sales` as
          sale_type='renewal', so resale revenue counts towards every report. */}
      {renewTarget && (
        <Modal
          open
          onClose={() => { if (!renewSaving) setRenewTarget(null); }}
          title={`Renew / Resell — ${lc(renewTarget.code)}`}
        >
          <div className="holder-capture">
            <p className="holder-capture__lead">
              Issues <strong>{lc(renewTarget.code)}</strong> for another period instead of minting a new PIN.
              The client keeps their code, bound devices stay attached, and this payment is booked as a
              <strong> new sale</strong>.
            </p>

            <label className="holder-capture__label" htmlFor="renew-package">Package</label>
            <select
              id="renew-package"
              className="holder-capture__input"
              value={renewPackageTier}
              onChange={e => applyRenewPackage(e.target.value)}
            >
              <option value="">
                Keep {renewTarget.package_tier ? `${renewTarget.package_tier} (current)` : 'the current package'}
              </option>
              {packages.map(p => (
                <option key={p.tier_name} value={p.tier_name}>
                  {p.display_name || p.tier_name} — ${parseFloat(String(p.price_amount || 0)).toFixed(2)} · {fmtDur(p.duration_min)} · {p.is_uncapped ? 'Unlimited' : `${p.data_limit_gb ?? 'Unlimited'} GB`} · {p.bandwidth_mbps_up}/{p.bandwidth_mbps_down} Mbps
                </option>
              ))}
            </select>

            {renewSelectedPkg && (
              <>
                <div className="vd-grid" style={{ marginTop: 8 }}>
                  <div className="vd-cell"><span className="vd-label">Speed</span><span className="vd-value">{renewSelectedPkg.bandwidth_mbps_up}/{renewSelectedPkg.bandwidth_mbps_down} Mbps</span></div>
                  <div className="vd-cell"><span className="vd-label">Data quota</span><span className="vd-value">{renewSelectedPkg.is_uncapped ? 'Unlimited' : `${renewSelectedPkg.data_limit_gb ?? 'Unlimited'} GB`}</span></div>
                  <div className="vd-cell"><span className="vd-label">Validity</span><span className="vd-value">{fmtDur(renewSelectedPkg.duration_min)}</span></div>
                  <div className="vd-cell"><span className="vd-label">Price</span><span className="vd-value">${parseFloat(String(renewSelectedPkg.price_amount || 0)).toFixed(2)}</span></div>
                </div>
                <p className="renew-hint">
                  Swaps {renewTarget.package_tier || 'custom'} → {renewSelectedPkg.tier_name}: speed, data quota,
                  validity and device cap are copied onto the voucher. PIN, bound devices and history are untouched.
                </p>
              </>
            )}

            <label className="holder-capture__label" htmlFor="renew-duration">Additional duration (minutes)</label>
            <input
              id="renew-duration"
              className="holder-capture__input"
              type="number"
              min={1}
              max={525600}
              value={renewDuration}
              onChange={e => setRenewDuration(parseInt(e.target.value || '0', 10))}
            />
            <p className="renew-hint">{fmtDur(renewDuration)} of access{renewTarget.expires_at ? ` on top of ${fmtDate(renewTarget.expires_at)}` : ''}</p>

            <label className="holder-capture__label" htmlFor="renew-price">Amount paid (USD) *</label>
            <input
              id="renew-price"
              className="holder-capture__input"
              type="number"
              min="0.01"
              step="0.5"
              inputMode="decimal"
              value={renewPrice}
              onChange={e => setRenewPrice(e.target.value)}
              placeholder="0.00"
              autoFocus
            />

            <label className="holder-capture__label" htmlFor="renew-pay-method">Payment method</label>
            <select
              id="renew-pay-method"
              className="holder-capture__input"
              value={renewPayMethod}
              onChange={e => { setRenewPayMethod(e.target.value); if (e.target.value === 'Cash') setRenewPayRef(''); }}
            >
              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>

            {IS_MOBILE_MONEY(renewPayMethod) && (
              <>
                <label className="holder-capture__label" htmlFor="renew-pay-ref">Payment reference</label>
                <input
                  id="renew-pay-ref"
                  className="holder-capture__input"
                  value={renewPayRef}
                  onChange={e => setRenewPayRef(e.target.value)}
                  placeholder="Transaction / approval code"
                  maxLength={64}
                />
              </>
            )}

            <label className="renew-check">
              <input
                type="checkbox"
                checked={renewResetQuota}
                onChange={e => setRenewResetQuota(e.target.checked)}
              />
              <span>Reset the data quota so the new period starts fresh</span>
            </label>
            <p className="renew-hint">Uncheck to carry the client's remaining data over. Redemption uses are always reset.</p>

            {renewError && <p className="holder-capture__error" role="alert">{renewError}</p>}
            <div className="holder-capture__actions">
              <button className="btn-sm" onClick={() => setRenewTarget(null)} disabled={renewSaving}>Cancel</button>
              <button className="btn-action btn-action--download" onClick={submitRenew} disabled={renewSaving}>
                {renewSaving ? 'Recording…' : `Renew for $${(parseFloat(renewPrice) || 0).toFixed(2)}`}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Delete (DELETE /vouchers/:id) — soft delete, reverses nothing ── */}
      {deleteTarget && (
        <Modal
          open
          onClose={() => { if (!deleteBusy) setDeleteTarget(null); }}
          title={`Delete ${lc(deleteTarget.code)}?`}
        >
          <div className="holder-capture">
            <p className="holder-capture__lead">
              This <strong>soft-deletes</strong> <strong>{lc(deleteTarget.code)}</strong> and disables it so the code
              can no longer be redeemed. Redemption and device history are kept, but the voucher will no longer appear
              in your active lists.
            </p>
            <p className="holder-capture__lead">
              Already received money for it? Use <strong>Renew / Resell</strong> instead — that re-arms the same PIN
              and records the payment.
            </p>
            <div className="holder-capture__actions">
              <button className="btn-sm" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>Keep voucher</button>
              <button
                className="btn-sm btn-danger"
                onClick={confirmDelete}
                disabled={deleteBusy}
              >
                {deleteBusy ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
