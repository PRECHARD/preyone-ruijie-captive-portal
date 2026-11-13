/** After a print attempt: open the dialog only when a silent print failed. */
export function printFollowUp(silent: boolean, succeeded: boolean): 'done' | 'dialog' | 'stop' {
  if (succeeded) return 'done';
  if (silent) return 'dialog';
  return 'stop';
}

/** Silent printing is only for the till. Invoice, admin, and the public site cannot drive it. */
export function isPosReceiptUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'pos.preyone.com';
  } catch {
    return false;
  }
}
