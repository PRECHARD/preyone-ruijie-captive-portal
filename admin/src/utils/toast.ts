interface ToastEvent {
  title: string;
  message: string;
  type?: 'success' | 'info' | 'warning' | 'error';
  section?: string;
}

export function showToast(detail: ToastEvent): void {
  window.dispatchEvent(new CustomEvent('app-toast', { detail }));
}
