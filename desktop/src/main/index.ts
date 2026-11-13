import { app, BrowserWindow, WebContentsView, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
import {
  currentToken,
  fetchMe,
  loadPrinterName,
  login,
  logout,
  probeOnline,
  registerDevice,
  rememberToken,
  type ShellSession,
} from './auth';
import { isAllowedAppUrl, isExternalBrowserUrl, isShellUrl } from '../shared/navigation';
import { isModuleKey, upgradeCopy, MODULE_TILES, type ModuleKey } from '../shared/plans';

const DEV_URL = process.env.ELECTRON_RENDERER_URL || null;
const TOOLBAR_HEIGHT = 56;

let win: BrowserWindow | null = null;
let guest: WebContentsView | null = null;
let profile: ShellSession | null = null;
let printerName: string | null = null;
let online = true;
let moduleOpen: ModuleKey | null = null;

function shellPreload(): string {
  return path.join(__dirname, '../preload/shell.js');
}

function guestPreload(): string {
  return path.join(__dirname, '../preload/guest.js');
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

function layoutGuest(): void {
  if (!win || !guest) return;
  const [width, height] = win.getContentSize();
  const show = moduleOpen !== null && online;
  guest.setVisible(show);
  guest.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width,
    height: Math.max(0, height - TOOLBAR_HEIGHT),
  });
}

function openInBrowser(url: string): void {
  if (!isExternalBrowserUrl(url)) return;
  shell.openExternal(url).catch(() => {});
}

function guardNavigation(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAppUrl(url)) {
      contents.loadURL(url).catch(() => {});
    } else {
      openInBrowser(url);
    }
    return { action: 'deny' };
  });
  const block = (event: Electron.Event, url: string) => {
    if (url === 'about:blank' || isAllowedAppUrl(url)) return;
    event.preventDefault();
    openInBrowser(url);
  };
  contents.on('will-navigate', block);
  contents.on('will-redirect', block);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Preyone',
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: shellPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  guest = new WebContentsView({
    webPreferences: {
      preload: guestPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.contentView.addChildView(guest);
  guest.setVisible(false);
  guardNavigation(guest.webContents);
  guest.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (!isAllowedAppUrl(url)) return;
    online = false;
    moduleOpen = null;
    layoutGuest();
    send('preyone:online', false);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isShellUrl(url, DEV_URL)) event.preventDefault();
  });

  win.on('resize', layoutGuest);
  win.on('closed', () => {
    win = null;
    guest = null;
    moduleOpen = null;
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

async function refreshPrinter(): Promise<void> {
  if (!currentToken()) {
    printerName = null;
    return;
  }
  printerName = await loadPrinterName(session.defaultSession).catch(() => null);
}

async function afterSignIn(next: ShellSession): Promise<ShellSession> {
  profile = next;
  const notice = await registerDevice(session.defaultSession).catch((err: Error) => err.message);
  send('preyone:device-notice', notice);
  await refreshPrinter();
  return next;
}

function printPage(contents: Electron.WebContents, silent: boolean, deviceName?: string): Promise<boolean> {
  return new Promise((resolve) => {
    contents.print(
      { silent, deviceName, printBackground: true },
      (success) => resolve(success)
    );
  });
}
function setupUpdates(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (err) => {
    console.warn('Update check failed:', err.message);
  });
  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Preyone',
        message: 'A new version of Preyone has been downloaded.',
        detail: 'Restart to finish the update.',
        buttons: ['Restart now', 'Later'],
        defaultId: 1,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      })
      .catch(() => {});
  });
  autoUpdater.checkForUpdates().catch((err: Error) => {
    console.warn('Update check failed:', err.message);
  });
}

function registerIpc(): void {
  ipcMain.handle('preyone:login', async (_event, email: string, password: string) => {
    const next = await login(session.defaultSession, String(email || ''), String(password || ''));
    return afterSignIn(next);
  });

  ipcMain.handle('preyone:restore', async () => {
    try {
      const next = await fetchMe(session.defaultSession);
      return afterSignIn(next);
    } catch {
      rememberToken(null);
      profile = null;
      return null;
    }
  });

  ipcMain.handle('preyone:logout', async () => {
    await logout(session.defaultSession);
    profile = null;
    printerName = null;
    moduleOpen = null;
    guest?.webContents.loadURL('about:blank').catch(() => {});
    layoutGuest();
    send('preyone:device-notice', null);
  });

  ipcMain.handle('preyone:open-module', async (_event, key: string) => {
    if (!isModuleKey(key)) {
      return { ok: false, reason: 'upgrade', message: 'That module is not on your plan.' };
    }
    if (!online) {
      return { ok: false, reason: 'offline', message: 'You are offline. Connect and try again.' };
    }
    const allowed = profile?.modules.includes(key);
    if (!allowed) {
      return { ok: false, reason: 'upgrade', message: upgradeCopy(key, profile?.planName ?? null) };
    }
    moduleOpen = key;
    layoutGuest();
    await guest?.webContents.loadURL(MODULE_TILES[key].url);
    return { ok: true };
  });

  ipcMain.handle('preyone:home', async () => {
    moduleOpen = null;
    layoutGuest();
  });

  ipcMain.handle('preyone:retry', async () => {
    online = await probeOnline(session.defaultSession);
    send('preyone:online', online);
    return online;
  });

  ipcMain.handle('preyone:print-receipt', async (event) => {
    const contents = event.sender;
    const printers = await contents.getPrintersAsync();
    const match = printerName ? printers.find((printer) => printer.name === printerName) : undefined;
    const silent = Boolean(match);
    const printed = await printPage(contents, silent, match?.name);
    if (printed) return { ok: true, silent };
    console.warn('Silent print failed, opening the print dialog.');
    const dialogOk = await printPage(contents, false);
    return { ok: dialogOk, silent: false };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
  registerIpc();
  createWindow();
  setupUpdates();
  probeOnline(session.defaultSession).then((up) => {
    online = up;
    send('preyone:online', up);
  });
  setInterval(() => {
    probeOnline(session.defaultSession).then((up) => {
      if (up === online) return;
      online = up;
      if (!up) moduleOpen = null;
      layoutGuest();
      send('preyone:online', up);
    });
  }, 15000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
