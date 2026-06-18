import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { showToast } from '../utils/toast';
import jsPDF from 'jspdf';
import { playVoucherSound, playAlertSound } from '../utils/sound';
import EmptyState from '../components/EmptyState';
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

const APPROVAL_TIERS = ['PreMAX', 'PreULTRA', 'PreEXECUTIVE'];

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

export default function Vouchers() {
  const { user } = useAuth();
  const role = user?.role || 'Staff';
  const isMgmt = role === 'CEO' || role === 'Manager';
  const needsClockIn = role !== 'CEO';

  const [clockStatus, setClockStatus] = useState<ClockStatus | null>(null);
  const [packages, setPackages] = useState<Package[]>([]);
  const [selectedPkg, setSelectedPkg] = useState<Package | null>(null);
  const [vCode, setVCode] = useState('');
  const [vPrice, setVPrice] = useState('');
  const [vUses, setVUses] = useState(1);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [vStatus, setVStatus] = useState<{ type: string; msg: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const [bulkTier, setBulkTier] = useState('');
  const [bulkCount, setBulkCount] = useState(10);
  const [bulkPrice, setBulkPrice] = useState('');
  const [bulkStatus, setBulkStatus] = useState<{ type: string; msg: string } | null>(null);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkResults, setBulkResults] = useState<any>(null);

  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [myApprovals, setMyApprovals] = useState<ApprovalRequest[]>([]);

  const processedApprovalIds = useRef<Set<string>>(new Set());

  const [voucherCardData, setVoucherCardData] = useState<any>(null);
  const [expandedApproval, setExpandedApproval] = useState<string | null>(null);

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
    api.get<Voucher[]>('/vouchers').then(setVouchers).catch(() => {});
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
                code: code || codes?.[0],
                package_tier: a.package_tier,
                price_amount: a.price_amount?.toString() || '',
                max_uses: a.max_uses,
                duration_min: pkg?.duration_min || 60,
                bandwidth_mbps_up: pkg?.bandwidth_mbps_up || 2,
                bandwidth_mbps_down: pkg?.bandwidth_mbps_down || 5,
                data_limit_gb: pkg?.data_limit_gb ?? null,
                is_uncapped: pkg?.is_uncapped ?? false,
              });
              showToast({ title: 'Voucher Approved', message: `"${code || codes?.[0]}" is ready to share`, type: 'success' });
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
    const prefix = tier.slice(0, 4).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return prefix + '-' + rand;
  }, []);

  const selectPackage = useCallback((tier: string) => {
    const pkg = packages.find(p => p.tier_name === tier) || null;
    setSelectedPkg(pkg);
    if (pkg) {
      setVCode(generateCode(pkg.tier_name));
      setVPrice(pkg.price_amount);
      if (!['PreBIZ', 'PreMAX', 'PreULTRA', 'PreEXECUTIVE'].includes(pkg.tier_name)) setVUses(1);
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

    setCreating(true);
    setVStatus(null);
    try {
      const data = await api.post<any>('/vouchers', {
        code: vCode,
        maxUses: vUses,
        packageTier: selectedPkg.tier_name,
        priceAmount: parseFloat(vPrice),
      });
      setVStatus({ type: 'success', msg: `Voucher "${data.code}" created successfully.` });
      setVoucherCardData(data);
      setSelectedPkg(null);
      setVCode('');
      setVPrice('');
      setVUses(1);
      api.get<Voucher[]>('/vouchers').then(setVouchers).catch(() => {});
      showToast({ title: 'Voucher Created', message: `"${data.code}" created successfully`, type: 'success' });
      playVoucherSound();
    } catch (err: any) {
      if (err.requiresApproval) {
        setVStatus({ type: 'approval', msg: err.message || 'Approval required' });
      } else {
        setVStatus({ type: 'error', msg: err.message || 'Failed to create voucher' });
      }
    } finally {
      setCreating(false);
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
    if (bulkCount < 1 || bulkCount > 100) { setBulkStatus({ type: 'error', msg: 'Count must be 1-100' }); return; }
    if (needsClockIn && !isClockedIn) { setBulkStatus({ type: 'error', msg: 'You must clock in before selling vouchers.' }); return; }

    setBulkCreating(true);
    setBulkStatus(null);
    try {
      const data = await api.post<any>('/vouchers/bulk', {
        count: bulkCount,
        packageTier: bulkTier,
        priceAmount: bulkPrice ? parseFloat(bulkPrice) : undefined,
      });
      setBulkStatus({ type: 'success', msg: data.message });
      setBulkResults(data.vouchers);
      api.get<Voucher[]>('/vouchers').then(setVouchers).catch(() => {});
      showToast({ title: 'Bulk Vouchers', message: data.message, type: 'success' });
      playVoucherSound();
    } catch (err: any) {
      if (err.requiresApproval) {
        setBulkStatus({ type: 'approval', msg: err.message || 'Approval required' });
      } else {
        setBulkStatus({ type: 'error', msg: err.message || 'Failed to generate bulk' });
      }
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
      api.get<Voucher[]>('/vouchers').then(setVouchers).catch(() => {});
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

  function voucherSerial(code: string) {
    var d = new Date();
    return (code || 'PREYONE').slice(0, 3).toUpperCase() + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '-' + String(Math.floor(Math.random() * 9000) + 1000);
  }

  const downloadVoucherPNG = () => {
    if (!voucherCardData) return;
    renderVoucherPNG(voucherCardData, user?.fullName || 'Preyone UltraNet');
  };

  const drawVoucherCanvas = async (c: HTMLCanvasElement, data: any, issuedByName: string) => {
    const code = data.code || 'PREYONE-XXXX';
    const tierText = data.package_tier || 'Custom';
    const priceText = data.price_amount ? '$' + parseFloat(data.price_amount).toFixed(2) : '';
    const durShort = fmtDurShort(data.duration_min);
    const validUntil = calcValidUntil(data);
    const dataVal = data.is_uncapped ? 'UNCAPPED DATA' : (data.data_limit_gb != null ? data.data_limit_gb + ' GB' : 'UNLIMITED');
    const bwVal = data.bandwidth_mbps_up ? data.bandwidth_mbps_up + ' Mbps' : '—';
    const serial = voucherSerial(code);

    const W = 800, H = 450;
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;

    // ── Cyberpunk border glow ──
    var bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, '#050604'); bgGrad.addColorStop(0.46, '#020202'); bgGrad.addColorStop(1, '#050506');
    ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);

    // ── Cyberpunk radial glow spots ──
    [[50, 40, 300], [750, 50, 280], [30, 400, 260], [770, 380, 300]].forEach(function (g) {
      var rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]);
      rg.addColorStop(0, 'rgba(113,255,47,0.15)'); rg.addColorStop(0.4, 'rgba(113,255,47,0.15)'); rg.addColorStop(1, 'transparent');
      if (g[0] === 750) { rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]); rg.addColorStop(0, 'rgba(19,216,255,0.15)'); rg.addColorStop(0.4, 'rgba(19,216,255,0.15)'); rg.addColorStop(1, 'transparent'); }
      if (g[0] === 30) { rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]); rg.addColorStop(0, 'rgba(54,124,255,0.12)'); rg.addColorStop(0.4, 'rgba(54,124,255,0.12)'); rg.addColorStop(1, 'transparent'); }
      if (g[0] === 770) { rg = ctx.createRadialGradient(g[0], g[1], 5, g[0], g[1], g[2]); rg.addColorStop(0, 'rgba(139,77,255,0.12)'); rg.addColorStop(0.4, 'rgba(139,77,255,0.12)'); rg.addColorStop(1, 'transparent'); }
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    });

    // ── Voucher logo image (under text, left-aligned) ──
    const logoImg = new Image();
    await new Promise(resolve => { logoImg.onload = resolve; logoImg.onerror = resolve; logoImg.src = '/images/preyone-techy-voucher.png'; });
    var iw = logoImg.naturalWidth, ih = logoImg.naturalHeight, maxH = 90;
    if (ih > maxH) { iw *= maxH / ih; ih = maxH; }
    ctx.drawImage(logoImg, -5, 21, iw, ih);

    // ── LEFT: Logo ──
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

    // ── RIGHT: Voucher Code Box ──
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

    // ── Info row ──
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
    ctx.fillStyle = '#64748b';
    ctx.font = '600 10px Montserrat, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('SN: ' + serial, W - 14, H - 10);
  };

  const renderVoucherPNG = async (data: any, issuedByName: string) => {
    const c = document.createElement('canvas');
    await drawVoucherCanvas(c, data, issuedByName);
    var link = document.createElement('a');
    link.download = 'preyone-voucher-' + data.code + '.png';
    link.href = c.toDataURL('image/png');
    link.click();
  };

  const printVoucherPDF = async () => {
    if (!voucherCardData) return;
    const c = document.createElement('canvas');
    c.width = 800; c.height = 450;
    await drawVoucherCanvas(c, voucherCardData, user?.fullName || 'Preyone UltraNet');
    const doc = new jsPDF('portrait', 'mm', 'a4');
    const imgData = c.toDataURL('image/png');
    const pw = 210, ph = 297, m = 10;
    const iw = pw - m * 2, ih = iw * 450 / 800;
    doc.addImage(imgData, 'PNG', (pw - iw) / 2, (ph - ih) / 2, iw, ih);
    doc.save('preyone-voucher-' + voucherCardData.code + '.pdf');
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
      const imgData = c.toDataURL('image/png');
      const col = i % cols, row = Math.floor(i / cols) % rows;
      const pad = 3;
      let iw = cw - pad * 2, ih = iw * 450 / 800;
      if (ih > ch - pad * 2) { ih = ch - pad * 2; iw = ih * 800 / 450; }
      const x = m + col * cw + (cw - iw) / 2;
      const y = m + row * ch + (ch - ih) / 2;
      doc.setDrawColor(210, 210, 210);
      doc.setLineWidth(0.2);
      doc.rect(m + col * cw + 1, m + row * ch + 1, cw - 2, ch - 2, 'S');
      doc.addImage(imgData, 'PNG', x, y, iw, ih);
    }
    doc.save('preyone-bulk-vouchers.pdf');
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setVStatus({ type: 'success', msg: 'Code copied' });
    setTimeout(() => setVStatus(null), 2000);
  };

  const shareWhatsApp = async () => {
    if (!voucherCardData) return;
    const c = document.createElement('canvas');
    c.width = 800; c.height = 450;
    await drawVoucherCanvas(c, voucherCardData, user?.fullName || 'Preyone UltraNet');
    const blob = await new Promise<Blob | null>(resolve => c.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const file = new File([blob], 'preyone-voucher-' + voucherCardData.code + '.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Preyone Voucher' }); return; } catch {}
    }
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const copyAllVoucher = () => {
    if (!voucherCardData) return;
    navigator.clipboard.writeText(voucherCardData.code);
    setVStatus({ type: 'success', msg: 'Voucher PIN copied to clipboard' });
    setTimeout(() => setVStatus(null), 2000);
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
                <input type="text" value={vCode} onChange={e => setVCode(e.target.value)} placeholder="Select a package" readOnly={!selectedPkg} />
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
                  disabled={!!(selectedPkg && !['PreBIZ', 'PreMAX', 'PreULTRA', 'PreEXECUTIVE'].includes(selectedPkg.tier_name))}>&minus;</button>
                <input type="number" className="stepper-input" value={vUses} min="1" max="100"
                  onChange={e => { const n = parseInt(e.target.value); if (!isNaN(n)) setVUses(Math.max(1, Math.min(100, n))); }}
                  disabled={!!(selectedPkg && !['PreBIZ', 'PreMAX', 'PreULTRA', 'PreEXECUTIVE'].includes(selectedPkg.tier_name))} />
                <button type="button" className="stepper-btn" onClick={() => setVUses(u => Math.min(100, u + 1))}
                  disabled={!!(selectedPkg && !['PreBIZ', 'PreMAX', 'PreULTRA', 'PreEXECUTIVE'].includes(selectedPkg.tier_name))} >+</button>
              </div>
            </div>
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
                  <span className="token-string" style={{ color: '#0284c7', cursor: 'pointer' }} onClick={() => copyCode(voucherCardData.code)}>
                    {voucherCardData.code}
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
            <button className="btn-action btn-action--wa" onClick={shareWhatsApp}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              WhatsApp
            </button>
            <button className="btn-action btn-action--copy" onClick={copyAllVoucher}>
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="13" height="15" rx="2"/><polyline points="2 5 2 18 15 18"/></svg>
              Copy All
            </button>
            <button className="btn-action btn-action--download" onClick={downloadVoucherPNG}>
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
                <button type="button" className="stepper-btn" onClick={() => setBulkCount(c => Math.max(1, c - 5))} disabled={bulkCreating}>&minus;</button>
                <input type="number" className="stepper-input" value={bulkCount} min="1" max="100"
                  onChange={e => { const n = parseInt(e.target.value); if (!isNaN(n)) setBulkCount(Math.max(1, Math.min(100, n))); }} />
                <button type="button" className="stepper-btn" onClick={() => setBulkCount(c => Math.min(100, c + 5))} disabled={bulkCreating}>+</button>
              </div>
            </div>
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
                  <span key={i} className="bulk-code-chip" onClick={() => copyCode(v.code)} title="Click to copy">{v.code}</span>
                ))}
              </div>
              <div className="voucher-card-actions-bar" style={{ marginTop: '0.75rem' }}>
                <button className="btn-action btn-action--wa" onClick={() => {
                  const msg = bulkResults.map((v: any) => {
                    const tier = v.package_tier || 'Custom';
                    const price = v.price_amount ? ' $' + parseFloat(v.price_amount).toFixed(2) : '';
                    return 'Code: ' + v.code + ' | ' + tier + price;
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
                    setTimeout(() => renderVoucherPNG(v, user?.fullName || 'Preyone UltraNet'), i * 500);
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
            <div className="card card-table">
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
                  const codes = a.voucher_data?.codes || (a.voucher_data?.code ? [a.voucher_data.code] : []);
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
                            <span className="code-cell">{a.voucher_data?.code || '—'}</span>
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
                                    setTimeout(() => renderVoucherPNG({
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
      <div className="section-head" style={{ marginTop: '2rem' }}>
        <h2 className="section-head-title">Voucher List</h2>
      </div>
      <div className="card card-table">
        {vouchers.length === 0 ? (
          <div className="table-empty"><p>No vouchers created yet.</p></div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Code</th><th>Price</th><th>Duration</th><th>Bandwidth</th><th>Data</th><th>Max Uses</th><th>Used</th><th>Package</th><th>Created</th></tr></thead>
            <tbody>
              {vouchers.map(v => (
                <tr key={v.id}>
                  <td><span className="code-cell" onClick={() => copyCode(v.code)} title="Click to copy">{v.code}</span></td>
                  <td><span className="money money--sm">{v.price_amount ? '$' + parseFloat(v.price_amount).toFixed(2) : '—'}</span></td>
                  <td>{fmtDur(v.duration_min)}</td>
                  <td>{v.bandwidth_mbps_up}/{v.bandwidth_mbps_down} Mbps</td>
                  <td>{v.is_uncapped ? 'Unlimited' : (v.data_limit_gb ?? 'Unlimited') + ' GB'}</td>
                  <td>{v.max_uses}</td>
                  <td>{v.used_count}/{v.max_uses}</td>
                  <td>{v.package_tier || <span className="muted">—</span>}</td>
                  <td>{fmtDate(v.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Helper functions for PNG generation
function fmtDurShort(m: number): string {
  if (!m) return '—';
  if (m >= 43200) { const vm = Math.round(m / 43200); return vm + ' Month' + (vm > 1 ? 's' : ''); }
  if (m >= 1440) { const vd = Math.round(m / 1440); return vd + ' Day' + (vd > 1 ? 's' : ''); }
  if (m >= 60) { const vh = Math.round(m / 60); return vh + ' Hour' + (vh > 1 ? 's' : ''); }
  return m + ' Min';
}

function calcValidUntil(data: any): string {
  if (data.expires_at) return new Date(data.expires_at).toISOString().split('T')[0];
  const d = new Date();
  d.setMinutes(d.getMinutes() + (data.duration_min || 60));
  return d.toISOString().split('T')[0];
}
