import type { ModuleKey } from '../shared/plans';
import type { ShellSession } from '../shared/session';

export interface PreyoneShellApi {
  login(email: string, password: string): Promise<ShellSession>;
  logout(): Promise<void>;
  restore(): Promise<ShellSession | null>;
  openModule(key: ModuleKey): Promise<{ ok: true } | { ok: false; reason: 'upgrade' | 'offline'; message: string }>;
  goHome(): Promise<void>;
  retry(): Promise<boolean>;
  onOnline(cb: (online: boolean) => void): () => void;
  onDeviceNotice(cb: (message: string | null) => void): () => void;
}

declare global {
  interface Window {
    preyone: PreyoneShellApi;
  }
}

export {};
