/** After a print attempt: open the dialog only when a silent print failed. */
export function printFollowUp(silent: boolean, succeeded: boolean): 'done' | 'dialog' | 'stop' {
  if (succeeded) return 'done';
  if (silent) return 'dialog';
  return 'stop';
}
