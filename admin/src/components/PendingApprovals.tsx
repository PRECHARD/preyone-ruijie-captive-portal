import './PendingApprovals.css';

/**
 * Compact "no pending approvals" indicator.
 *
 * Replaces the large emoji/graphic empty state with a 24px neon-cyan radar
 * badge inside a glass pill, so the approvals section costs one line of
 * vertical space instead of a whole block. When requests do exist the same
 * badge turns into a live pulse and the count is appended.
 */
export default function PendingApprovals({
  pending = 0,
  title = 'No Pending Approvals',
  message = 'No approval requests at the moment.',
}: {
  pending?: number;
  title?: string;
  message?: string;
}) {
  const active = pending > 0;
  return (
    <div className="pending-approvals" role="status" aria-live="polite">
      <span
        className={'pending-approvals__badge' + (active ? ' is-active' : '')}
        aria-hidden="true"
      >
        <span className="pending-approvals__sweep" />
        <span className="pending-approvals__dot" />
      </span>
      <span className="pending-approvals__copy">
        <span className="pending-approvals__title">{title}</span>
        <span className="pending-approvals__msg">{message}</span>
      </span>
      {active && (
        <span className="pending-approvals__count" aria-label={`${pending} pending`}>
          {pending > 99 ? '99+' : pending}
        </span>
      )}
    </div>
  );
}
