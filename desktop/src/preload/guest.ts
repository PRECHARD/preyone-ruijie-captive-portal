import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge a POS or Invoice page receives.
 * Same call shape as the Android till: printReceipt(json).
 */
contextBridge.exposeInMainWorld('PreyoneDesktop', {
  printReceipt: (json: string) => {
    const payload = typeof json === 'string' ? json : JSON.stringify(json);
    return ipcRenderer.invoke('preyone:print-receipt', payload);
  },
});
