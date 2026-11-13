import { contextBridge, ipcRenderer } from 'electron';
import type { ModuleKey } from '../shared/plans';
import type { ShellSession } from '../shared/session';

const api = {
  login: (email: string, password: string) => ipcRenderer.invoke('preyone:login', email, password) as Promise<ShellSession>,
  logout: () => ipcRenderer.invoke('preyone:logout') as Promise<void>,
  restore: () => ipcRenderer.invoke('preyone:restore') as Promise<ShellSession | null>,
  openModule: (key: ModuleKey) =>
    ipcRenderer.invoke('preyone:open-module', key) as Promise<{ ok: true } | { ok: false; reason: 'upgrade' | 'offline'; message: string }>,
  goHome: () => ipcRenderer.invoke('preyone:home') as Promise<void>,
  retry: () => ipcRenderer.invoke('preyone:retry') as Promise<boolean>,
  onOnline: (cb: (online: boolean) => void) => {
    const listener = (_event: unknown, online: boolean) => cb(online);
    ipcRenderer.on('preyone:online', listener);
    return () => ipcRenderer.removeListener('preyone:online', listener);
  },
  onDeviceNotice: (cb: (message: string | null) => void) => {
    const listener = (_event: unknown, message: string | null) => cb(message);
    ipcRenderer.on('preyone:device-notice', listener);
    return () => ipcRenderer.removeListener('preyone:device-notice', listener);
  },
};

contextBridge.exposeInMainWorld('preyone', api);

export type PreyoneShellApi = typeof api;
