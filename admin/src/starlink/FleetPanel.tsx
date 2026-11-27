import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  FiArrowRight, FiCheck, FiCopy, FiCpu, FiDownload, FiMail, FiMapPin,
  FiPause, FiPlay, FiRefreshCw, FiSearch, FiSettings, FiShield, FiTrash2,
  FiUsers, FiWifi,
} from 'react-icons/fi';
import {
  ApiError, fmtDate, fmtMoney, slFleet, slInvoices, slInviteMember,
  slPatchKit, slRemoveMember, slResendMemberInvite, slSetServiceState,
  slTransferData, slUpdateMember,
  type SlAccountMember, type SlCustomer, type SlFleetResponse,
  type SlInvoice, type SlKit, type SlRole,
} from './api';
import { downloadConsolidatedStatementPdf } from './InvoicesView';

type ToastFn = (kind: 'ok' | 'err' | 'info', title: string, body?: string) => void;

const MODEL_LABEL: Record<string, string> = {
  standard: 'Standard',
  mini: 'Mini',
  high_performance: 'High Performance',
};

function modelLabel(value: string): string {
  return MODEL_LABEL[value] || value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function kitSite(kit: SlKit): string {
  return kit.site_name || kit.nickname || 'Unnamed site';
}

function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function coordinate(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export default function FleetPanel({
  customer,
  kits,
  invoices,
  role,
  selectedKitId,
  onSelectKit,
  onTopUpKit,
  onRefresh,
  onToast,
}: {
  customer: SlCustomer;
  kits: SlKit[];
  invoices: SlInvoice[];
  role: SlRole;
  selectedKitId: string;
  onSelectKit: (kitId: string) => void;
  onTopUpKit: (kitId: string) => void;
  onRefresh: () => Promise<void> | void;
  onToast: ToastFn;
}) {
  const [fleet, setFleet] = useState<SlFleetResponse | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'active' | 'paused'>('ALL');
  const [transferOpen, setTransferOpen] = useState(false);
  const [fromKitId, setFromKitId] = useState('');
  const [toKitId, setToKitId] = useState('');
  const [gb, setGb] = useState('5');
  const [transferKey, setTransferKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [stateTarget, setStateTarget] = useState<{ kit: SlKit; state: 'active' | 'paused' } | null>(null);
  const [effectiveAt, setEffectiveAt] = useState('');
  const [stateNote, setStateNote] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'billing' | 'viewer'>('viewer');
  const [assigned, setAssigned] = useState<string[]>([]);
  const [inviteUrl, setInviteUrl] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [siteTarget, setSiteTarget] = useState<SlKit | null>(null);
  const [siteForm, setSiteForm] = useState({ siteName: '', city: '', gpsLat: '', gpsLng: '', hardwareModel: 'standard' });
  const [accessTarget, setAccessTarget] = useState<SlAccountMember | null>(null);
  const [accessRole, setAccessRole] = useState<'admin' | 'billing' | 'viewer'>('viewer');
  const [accessAssigned, setAccessAssigned] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const next = await slFleet();
      setFleet(next);
      return next;
    } catch {
      /* fleet summary is supplemental — the dashboard already loaded kits */
      return null;
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const allKits = fleet?.kits?.length ? fleet.kits : kits;
  const permissions = fleet?.permissions ?? {
    canBill: role !== 'viewer',
    canManage: role === 'owner' || role === 'admin',
    canInvite: role === 'owner',
  };

  useEffect(() => {
    if (!fromKitId && allKits[0]) setFromKitId(allKits[0].id);
    if (!toKitId && allKits[1]) setToKitId(allKits[1].id);
  }, [allKits, fromKitId, toKitId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), onRefresh()]);
  }, [load, onRefresh]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allKits.filter((kit) => {
      if (statusFilter !== 'ALL' && kit.status !== statusFilter) return false;
      if (!q) return true;
      return [kitSite(kit), kit.nickname, kit.kit_number, kit.city, modelLabel(kit.hardware_model)]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [allKits, query, statusFilter]);

  if (allKits.length < 2) return null;

  const summary = fleet?.summary ?? {
    kitCount: allKits.length,
    activeKits: allKits.filter((k) => k.status === 'active').length,
    pausedKits: allKits.filter((k) => k.status === 'paused').length,
    totalDataUsedGb: allKits.reduce((sum, k) => sum + Number(k.data_usage_gb || 0), 0),
    totalDataCreditGb: allKits.reduce((sum, k) => sum + Number(k.data_credit_gb || 0), 0),
    walletBalance: customer.walletBalance,
    balanceDue: 0,
    nextRenewalDate: customer.planRenewsAt ?? null,
  };

  const refreshAfter = async (message: string) => {
    await refreshAll();
    onToast('ok', message);
  };

  const openTransfer = (kitId?: string) => {
    setFromKitId(kitId || allKits[0]?.id || '');
    setToKitId(allKits.find((kit) => kit.id !== (kitId || allKits[0]?.id))?.id || '');
    setTransferKey(newIdempotencyKey());
    setTransferOpen(true);
  };

  const replaceMember = (updated: SlAccountMember) => {
    setFleet((prev) => prev
      ? { ...prev, members: prev.members.map((m) => m.id === updated.id ? updated : m) }
      : prev);
  };

  const openSite = (kit: SlKit) => {
    setSiteTarget(kit);
    setSiteForm({
      siteName: kit.site_name || '',
      city: kit.city || '',
      gpsLat: kit.gps_lat == null ? '' : String(kit.gps_lat),
      gpsLng: kit.gps_lng == null ? '' : String(kit.gps_lng),
      hardwareModel: kit.hardware_model || 'standard',
    });
  };

  const openAccess = (member: SlAccountMember) => {
    setAccessTarget(member);
    setAccessRole(member.role);
    setAccessAssigned(member.assignedKitIds);
  };

  const toggleAccessAssigned = (kitId: string) => {
    setAccessAssigned((prev) => prev.includes(kitId) ? prev.filter((id) => id !== kitId) : [...prev, kitId]);
  };

  const submitTransfer = async (e: FormEvent) => {
    e.preventDefault();
    if (fromKitId === toKitId) { onToast('err', 'Choose two different kits'); return; }
    const amount = Number(gb);
    if (!Number.isFinite(amount) || amount <= 0) { onToast('err', 'Enter a valid GB amount'); return; }
    setBusy(true);
    const key = transferKey || newIdempotencyKey();
    setTransferKey(key);
    try {
      const result = await slTransferData({ fromKitId, toKitId, gb: amount, idempotencyKey: key });
      setTransferOpen(false);
      setTransferKey('');
      await refreshAfter(
        `${amount.toFixed(2)} GB moved — ${result.fromBalance.toFixed(2)} GB source, ${result.toBalance.toFixed(2)} GB destination.`
      );
    } catch (err) {
      onToast('err', 'Transfer failed', err instanceof ApiError ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitState = async (e: FormEvent) => {
    e.preventDefault();
    if (!stateTarget) return;
    setBusy(true);
    try {
      const result = await slSetServiceState(stateTarget.kit.id, {
        state: stateTarget.state,
        ...(effectiveAt ? { effectiveAt: new Date(effectiveAt).toISOString() } : {}),
        note: stateNote,
      });
      setStateTarget(null);
      setEffectiveAt('');
      setStateNote('');
      await refreshAfter(result.applied
        ? `${kitSite(stateTarget.kit)} is now ${stateTarget.state}.`
        : `${kitSite(stateTarget.kit)} will be ${stateTarget.state} on ${fmtDate(result.request.effective_at)}.`);
    } catch (err) {
      onToast('err', 'Service state update failed', err instanceof ApiError ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const downloadStatement = async () => {
    try {
      const full = await slInvoices();
      downloadConsolidatedStatementPdf(full.invoices, customer, allKits);
      onToast('ok', 'Consolidated statement downloaded', `${full.invoices.length} invoices across ${allKits.length} sites.`);
    } catch {
      downloadConsolidatedStatementPdf(invoices, customer, allKits);
      onToast('info', 'Statement generated', 'Showing the invoices already loaded in this session.');
    }
  };

  const toggleAssigned = (kitId: string) => {
    setAssigned((prev) => prev.includes(kitId) ? prev.filter((id) => id !== kitId) : [...prev, kitId]);
  };

  const submitInvite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setInviteUrl('');
    try {
      const result = await slInviteMember({
        email: inviteEmail,
        name: inviteName,
        role: inviteRole,
        assignedKitIds: inviteRole === 'viewer' ? assigned : [],
      });
      setInviteUrl(result.inviteUrl);
      setEmailSent(result.emailSent);
      setInviteEmail('');
      setInviteName('');
      setAssigned([]);
      await refreshAll();
      onToast('ok', 'Invitation created', result.emailSent ? 'Dark-theme invitation email sent.' : 'Copy the link below — email delivery is unavailable.');
    } catch (err) {
      onToast('err', 'Invitation failed', err instanceof ApiError ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitSite = async (e: FormEvent) => {
    e.preventDefault();
    if (!siteTarget) return;
    setBusy(true);
    try {
      await slPatchKit(siteTarget.id, {
        siteName: siteForm.siteName.trim(),
        city: siteForm.city.trim(),
        gpsLat: coordinate(siteForm.gpsLat),
        gpsLng: coordinate(siteForm.gpsLng),
        hardwareModel: siteForm.hardwareModel,
      });
      const label = siteForm.siteName.trim() || siteTarget.nickname;
      setSiteTarget(null);
      await refreshAfter(`${label} site details saved.`);
    } catch (err) {
      onToast('err', 'Site details failed', err instanceof ApiError ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitAccess = async (e: FormEvent) => {
    e.preventDefault();
    if (!accessTarget) return;
    if (accessRole === 'viewer' && accessAssigned.length === 0) {
      onToast('err', 'Assign at least one kit to this viewer');
      return;
    }
    setBusy(true);
    try {
      const result = await slUpdateMember(accessTarget.id, {
        role: accessRole,
        assignedKitIds: accessRole === 'viewer' ? accessAssigned : [],
      });
      replaceMember(result.member);
      setAccessTarget(null);
      onToast('ok', 'Access updated', `${result.member.name} is now ${result.member.role}.`);
    } catch (err) {
      onToast('err', 'Access update failed', err instanceof ApiError ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const resendMember = async (member: SlAccountMember) => {
    setBusy(true);
    try {
      const result = await slResendMemberInvite(member.id);
      replaceMember(result.member);
      setInviteUrl(result.inviteUrl);
      setEmailSent(result.emailSent);
      onToast('ok', 'Invitation resent', 'The old session and password are no longer valid.');
    } catch (err) {
      onToast('err', 'Resend failed', err instanceof ApiError ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (member: SlAccountMember) => {
    if (!window.confirm(`Remove ${member.name}'s fleet access? Their session ends immediately.`)) return;
    setBusy(true);
    try {
      await slRemoveMember(member.id);
      setFleet((prev) => prev ? { ...prev, members: prev.members.filter((m) => m.id !== member.id) } : prev);
      if (accessTarget?.id === member.id) setAccessTarget(null);
      onToast('ok', 'Member removed', `${member.name} can no longer sign in.`);
    } catch (err) {
      onToast('err', 'Removal failed', err instanceof ApiError ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const members: SlAccountMember[] = fleet?.members ?? [];

  return (
    <section className="sp-panel sp-fleet">
      <div className="sp-fleet-head">
        <div>
          <span className="sp-badge"><span className="sp-badge-dot" /> Fleet overview</span>
          <h2>{allKits.length} sites under one account</h2>
          <p>Data, hardware and team access across every branch — {role === 'viewer' ? 'read-only telemetry scope' : 'full fleet controls'}.</p>
        </div>
        <div className="sp-fleet-head-actions">
          <label className="sp-fleet-switcher">
            <span>Active kit</span>
            <select className="sp-select" value={selectedKitId} onChange={(e) => onSelectKit(e.target.value)}>
              {allKits.map((kit) => (
                <option key={kit.id} value={kit.id}>{kitSite(kit)} — {kit.kit_number}</option>
              ))}
            </select>
          </label>
          <button type="button" className="sp-btn sp-btn--ghost sp-btn--small" onClick={() => void refreshAll()}>
            <FiRefreshCw /> Refresh
          </button>
        </div>
      </div>

      <div className="sp-fleet-cards">
        <div className="sp-fleet-card">
          <FiWifi />
          <span>Total data used</span>
          <b>{summary.totalDataUsedGb.toFixed(2)} GB</b>
          <small>{summary.activeKits} active · {summary.pausedKits} paused</small>
        </div>
        <div className="sp-fleet-card">
          <FiCpu />
          <span>Data credit pool</span>
          <b>{summary.totalDataCreditGb.toFixed(2)} GB</b>
          <small>Across {summary.kitCount} registered kits</small>
        </div>
        <div className="sp-fleet-card">
          <FiShield />
          <span>Wallet balance</span>
          <b>{permissions.canBill ? fmtMoney(summary.walletBalance) : '—'}</b>
          <small>{permissions.canBill ? `${fmtMoney(summary.balanceDue)} due` : 'Billing role required'}</small>
        </div>
        <div className="sp-fleet-card">
          <FiMapPin />
          <span>Next renewal</span>
          <b>{fmtDate(summary.nextRenewalDate)}</b>
          <small>Earliest upcoming plan renewal</small>
        </div>
      </div>

      <div className="sp-fleet-toolbar">
        <label className="sp-fleet-search">
          <FiSearch />
          <input
            className="sp-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search site, city, serial or model…"
          />
        </label>
        <div className="sp-fleet-chips">
          {(['ALL', 'active', 'paused'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={'sp-chip' + (statusFilter === value ? ' is-active' : '')}
              onClick={() => setStatusFilter(value)}
            >
              {value === 'ALL' ? 'All sites' : value === 'active' ? 'Active' : 'Paused'}
            </button>
          ))}
        </div>
        {permissions.canBill && (
          <button type="button" className="sp-btn sp-btn--cyan sp-btn--small" onClick={() => openTransfer()}>
            <FiArrowRight /> Transfer GB
          </button>
        )}
        {permissions.canBill && (
          <button type="button" className="sp-btn sp-btn--purple sp-btn--small" onClick={() => void downloadStatement()}>
            <FiDownload /> Consolidated PDF
          </button>
        )}
      </div>

      <div className="sp-table-wrap">
        <table className="sp-table sp-table--fleet">
          <thead>
            <tr>
              <th>Site / branch</th>
              <th>Model</th>
              <th>Status</th>
              <th>Data used</th>
              <th>Credit</th>
              <th>Location</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="sp-fleet-empty">No sites match this filter.</td></tr>
            )}
            {rows.map((kit) => (
              <tr key={kit.id} className={selectedKitId === kit.id ? 'is-selected' : ''}>
                <td>
                  <button type="button" className="sp-fleet-site" onClick={() => onSelectKit(kit.id)}>
                    <b>{kitSite(kit)}</b>
                    <small>{kit.kit_number}</small>
                  </button>
                </td>
                <td><span className="sp-badge-pill">{modelLabel(kit.hardware_model)}</span></td>
                <td>
                  <span className={'sp-badge-pill ' + (kit.status === 'active' ? 'sp-badge-pill--paid' : 'sp-badge-pill--pending')}>
                    {kit.pending_status && kit.pending_status !== kit.status
                      ? `${kit.status} → ${kit.pending_status}`
                      : kit.status}
                  </span>
                </td>
                <td>{Number(kit.data_usage_gb || 0).toFixed(2)} GB</td>
                <td className="sp-fleet-credit">{Number(kit.data_credit_gb || 0).toFixed(2)} GB</td>
                <td>{[kit.city, kit.gps_lat != null && kit.gps_lng != null ? `${kit.gps_lat}, ${kit.gps_lng}` : ''].filter(Boolean).join(' · ') || '—'}</td>
                <td>
                  <div className="sp-row-actions">
                    {permissions.canBill && (
                      <button type="button" className="sp-icon-btn" title="Top up this kit" onClick={() => onTopUpKit(kit.id)}>
                        <FiWifi />
                      </button>
                    )}
                    {permissions.canBill && (
                      <button type="button" className="sp-icon-btn" title="Transfer GB" onClick={() => openTransfer(kit.id)}>
                        <FiArrowRight />
                      </button>
                    )}
                    {permissions.canManage && (
                      <button type="button" className="sp-icon-btn" title="Edit site details" onClick={() => openSite(kit)}>
                        <FiSettings />
                      </button>
                    )}
                    {permissions.canManage && (
                      <button
                        type="button"
                        className="sp-icon-btn"
                        title={kit.status === 'paused' ? 'Reactivate' : 'Pause service'}
                        onClick={() => setStateTarget({ kit, state: kit.status === 'paused' ? 'active' : 'paused' })}
                      >
                        {kit.status === 'paused' ? <FiPlay /> : <FiPause />}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {permissions.canManage && (
        <div className="sp-fleet-team">
          <div className="sp-fleet-team-head">
            <div>
              <h3><FiUsers /> Branch access</h3>
              <p>Accountants can pay and download invoices. Site technicians only see their assigned kit telemetry.</p>
            </div>
            {permissions.canInvite && (
              <button type="button" className="sp-btn sp-btn--cyan sp-btn--small" onClick={() => setInviteOpen(true)}>
                <FiMail /> Invite member
              </button>
            )}
          </div>
          <div className="sp-fleet-members">
            {members.length === 0 && <span className="sp-hint">No sub-accounts invited yet.</span>}
            {members.map((member) => (
              <div key={member.id} className="sp-fleet-member">
                <span className="sp-avatar">{member.name.slice(0, 2).toUpperCase()}</span>
                <span><b>{member.name}</b><small>{member.email}</small></span>
                <span className="sp-badge-pill sp-badge-pill--paid">{member.role}</span>
                <small>{member.assignedKitIds.length ? `${member.assignedKitIds.length} kit(s)` : 'Fleet-wide'}</small>
                <small>{member.acceptedAt ? `Active ${fmtDate(member.acceptedAt)}` : 'Invitation pending'}</small>
                {permissions.canInvite && (
                  <div className="sp-fleet-member-actions">
                    <button type="button" className="sp-icon-btn" title="Edit access" onClick={() => openAccess(member)}>
                      <FiSettings />
                    </button>
                    <button type="button" className="sp-icon-btn" title="Resend invite / reset password" onClick={() => void resendMember(member)}>
                      <FiRefreshCw />
                    </button>
                    <button type="button" className="sp-icon-btn" title="Remove member" onClick={() => void removeMember(member)}>
                      <FiTrash2 />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {inviteUrl && (
            <div className="sp-alert sp-alert--ok sp-fleet-invite-link">
              <div>
                <b>{emailSent ? 'Invitation emailed.' : 'Copy this one-time invitation link:'}</b>
                <code>{inviteUrl}</code>
              </div>
              <button
                type="button"
                className="sp-btn sp-btn--ghost sp-btn--small"
                onClick={() => { void navigator.clipboard?.writeText(inviteUrl); onToast('ok', 'Invitation link copied'); }}
              >
                <FiCopy /> Copy
              </button>
            </div>
          )}
        </div>
      )}

      {transferOpen && (
        <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label="Transfer data credit">
          <form className="sp-modal" onSubmit={submitTransfer}>
            <div className="sp-modal-head">
              <h3><FiArrowRight /> Transfer data credit</h3>
              <button type="button" className="sp-icon-btn" onClick={() => setTransferOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="sp-modal-body sp-fleet-modal-grid">
              <div className="sp-field">
                <label>From kit</label>
                <select className="sp-select" value={fromKitId} onChange={(e) => { setFromKitId(e.target.value); setTransferKey(newIdempotencyKey()); }}>
                  {allKits.map((kit) => <option key={kit.id} value={kit.id}>{kitSite(kit)} · {Number(kit.data_credit_gb || 0).toFixed(2)} GB</option>)}
                </select>
              </div>
              <div className="sp-field">
                <label>To kit</label>
                <select className="sp-select" value={toKitId} onChange={(e) => { setToKitId(e.target.value); setTransferKey(newIdempotencyKey()); }}>
                  {allKits.map((kit) => <option key={kit.id} value={kit.id}>{kitSite(kit)} · {Number(kit.data_credit_gb || 0).toFixed(2)} GB</option>)}
                </select>
              </div>
              <div className="sp-field">
                <label>Data to move (GB)</label>
                <input className="sp-input" type="number" min="0.01" max="1000" step="0.01" value={gb} onChange={(e) => { setGb(e.target.value); setTransferKey(newIdempotencyKey()); }} required />
              </div>
              <p className="sp-hint">This moves spendable data credit only — no wallet debit and no new payment.</p>
            </div>
            <div className="sp-modal-foot">
              <button type="button" className="sp-btn sp-btn--ghost" onClick={() => setTransferOpen(false)}>Cancel</button>
              <button type="submit" className="sp-btn sp-btn--primary" disabled={busy}>{busy ? 'Moving…' : 'Transfer GB'}</button>
            </div>
          </form>
        </div>
      )}

      {stateTarget && (
        <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label="Service state request">
          <form className="sp-modal" onSubmit={submitState}>
            <div className="sp-modal-head">
              <h3>{stateTarget.state === 'paused' ? <FiPause /> : <FiPlay />} {stateTarget.state === 'paused' ? 'Schedule a pause' : 'Reactivate service'}</h3>
              <button type="button" className="sp-icon-btn" onClick={() => setStateTarget(null)} aria-label="Close">×</button>
            </div>
            <div className="sp-modal-body sp-fleet-modal-grid">
              <p className="sp-hint">{kitSite(stateTarget.kit)} · {stateTarget.kit.kit_number}</p>
              <div className="sp-field">
                <label>Schedule date (optional)</label>
                <input className="sp-input" type="datetime-local" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} />
                <span className="sp-hint">Leave blank for an instant change.</span>
              </div>
              <div className="sp-field">
                <label>Note</label>
                <input className="sp-input" value={stateNote} onChange={(e) => setStateNote(e.target.value)} placeholder="e.g. seasonal closure" />
              </div>
              {effectiveAt && <p className="sp-inline-ok"><FiCheck /> A FLEET notification is created now and the state applies on the chosen date.</p>}
            </div>
            <div className="sp-modal-foot">
              <button type="button" className="sp-btn sp-btn--ghost" onClick={() => setStateTarget(null)}>Cancel</button>
              <button type="submit" className="sp-btn sp-btn--primary" disabled={busy}>{busy ? 'Saving…' : stateTarget.state === 'paused' ? 'Pause service' : 'Reactivate'}</button>
            </div>
          </form>
        </div>
      )}

      {inviteOpen && (
        <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label="Invite fleet member">
          <form className="sp-modal" onSubmit={submitInvite}>
            <div className="sp-modal-head">
              <h3><FiMail /> Invite a team member</h3>
              <button type="button" className="sp-icon-btn" onClick={() => setInviteOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="sp-modal-body sp-fleet-modal-grid">
              <div className="sp-field">
                <label>Name</label>
                <input className="sp-input" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Branch manager" required />
              </div>
              <div className="sp-field">
                <label>Email</label>
                <input className="sp-input" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder=" accountant@company.co.zw " required />
              </div>
              <div className="sp-field">
                <label>Role</label>
                <select className="sp-select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'admin' | 'billing' | 'viewer')}>
                  <option value="viewer">Site technician — assigned telemetry only</option>
                  <option value="billing">Billing — invoices and Preyone Payment</option>
                  <option value="admin">Fleet administrator — full access</option>
                </select>
              </div>
              {inviteRole === 'viewer' && (
                <div className="sp-field">
                  <label>Assigned kits</label>
                  <div className="sp-fleet-checks">
                    {allKits.map((kit) => (
                      <label key={kit.id}>
                        <input type="checkbox" checked={assigned.includes(kit.id)} onChange={() => toggleAssigned(kit.id)} />
                        {kitSite(kit)}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <p className="sp-hint">Invitation links expire in 7 days. Only a hash is stored on the server.</p>
            </div>
            <div className="sp-modal-foot">
              <button type="button" className="sp-btn sp-btn--ghost" onClick={() => setInviteOpen(false)}>Cancel</button>
              <button type="submit" className="sp-btn sp-btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Send invitation'}</button>
            </div>
          </form>
        </div>
      )}

      {siteTarget && (
        <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label="Edit site details">
          <form className="sp-modal" onSubmit={submitSite}>
            <div className="sp-modal-head">
              <h3><FiMapPin /> Site details</h3>
              <button type="button" className="sp-icon-btn" onClick={() => setSiteTarget(null)} aria-label="Close">×</button>
            </div>
            <div className="sp-modal-body sp-fleet-modal-grid">
              <div className="sp-field">
                <label>Site / branch name</label>
                <input className="sp-input" value={siteForm.siteName} onChange={(e) => setSiteForm({ ...siteForm, siteName: e.target.value })} placeholder="Harare North" />
              </div>
              <div className="sp-field">
                <label>City</label>
                <input className="sp-input" value={siteForm.city} onChange={(e) => setSiteForm({ ...siteForm, city: e.target.value })} placeholder="Harare" />
              </div>
              <div className="sp-field">
                <label>GPS latitude</label>
                <input className="sp-input" type="number" min="-90" max="90" step="0.000001" value={siteForm.gpsLat} onChange={(e) => setSiteForm({ ...siteForm, gpsLat: e.target.value })} placeholder="-17.8252" />
              </div>
              <div className="sp-field">
                <label>GPS longitude</label>
                <input className="sp-input" type="number" min="-180" max="180" step="0.000001" value={siteForm.gpsLng} onChange={(e) => setSiteForm({ ...siteForm, gpsLng: e.target.value })} placeholder="31.0335" />
              </div>
              <div className="sp-field">
                <label>Hardware model</label>
                <select className="sp-select" value={siteForm.hardwareModel} onChange={(e) => setSiteForm({ ...siteForm, hardwareModel: e.target.value })}>
                  <option value="standard">Standard</option>
                  <option value="mini">Mini</option>
                  <option value="high_performance">High Performance</option>
                </select>
              </div>
              <p className="sp-hint">Leave GPS fields empty to clear them. Search and the fleet table use these tags.</p>
            </div>
            <div className="sp-modal-foot">
              <button type="button" className="sp-btn sp-btn--ghost" onClick={() => setSiteTarget(null)}>Cancel</button>
              <button type="submit" className="sp-btn sp-btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save site'}</button>
            </div>
          </form>
        </div>
      )}

      {accessTarget && (
        <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label="Edit member access">
          <form className="sp-modal" onSubmit={submitAccess}>
            <div className="sp-modal-head">
              <h3><FiUsers /> Edit access</h3>
              <button type="button" className="sp-icon-btn" onClick={() => setAccessTarget(null)} aria-label="Close">×</button>
            </div>
            <div className="sp-modal-body sp-fleet-modal-grid">
              <p className="sp-hint">{accessTarget.name} · {accessTarget.email}</p>
              <div className="sp-field">
                <label>Role</label>
                <select className="sp-select" value={accessRole} onChange={(e) => setAccessRole(e.target.value as 'admin' | 'billing' | 'viewer')}>
                  <option value="viewer">Site technician — assigned telemetry only</option>
                  <option value="billing">Billing — invoices and Preyone Payment</option>
                  <option value="admin">Fleet administrator — full access</option>
                </select>
              </div>
              {accessRole === 'viewer' ? (
                <div className="sp-field">
                  <label>Assigned kits</label>
                  <div className="sp-fleet-checks">
                    {allKits.map((kit) => (
                      <label key={kit.id}>
                        <input type="checkbox" checked={accessAssigned.includes(kit.id)} onChange={() => toggleAccessAssigned(kit.id)} />
                        {kitSite(kit)}
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="sp-hint">This role sees the whole fleet. Site assignment applies to viewers only.</p>
              )}
            </div>
            <div className="sp-modal-foot">
              <button type="button" className="sp-btn sp-btn--ghost" onClick={() => setAccessTarget(null)}>Cancel</button>
              <button type="submit" className="sp-btn sp-btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save access'}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
