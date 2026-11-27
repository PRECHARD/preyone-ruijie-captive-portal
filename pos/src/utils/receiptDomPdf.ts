import jsPDF from 'jspdf';
import { getFontEmbedCSS, toCanvas } from 'html-to-image';

/**
 * Capture the exact receipt card shown in the modal. Print already targets
 * this same DOM node; using it for PDF too removes any chance of the download
 * drifting from the preview (fonts, wrapping, emerald rules, PAID stamp and
 * the full-width Code 128 strip are all painted by the browser once).
 *
 * The vector generator in receiptPdf.ts remains as a compatibility fallback
 * for callers that have no DOM, so existing integrations are unchanged.
 */
export async function buildReceiptPdfFromElement(element: HTMLElement): Promise<jsPDF> {
  await document.fonts?.ready?.catch(() => undefined);

  const fontEmbedCSS = await withTimeout(getFontEmbedCSS(element), 10_000, 'font embed timeout')
    .catch(() => '');

  const rect = element.getBoundingClientRect();
  const cssWidth = rect.width || element.scrollWidth || 302;

  // ~300 DPI at 80mm roll width keeps the vector barcode path crisp when the
  // SVG is rasterised into the PDF page.
  const pixelRatio = Math.min(4, Math.max(2, 900 / Math.max(cssWidth, 1)));
  const canvas = await withTimeout(
    toCanvas(element, {
      pixelRatio,
      backgroundColor: '#ffffff',
      fontEmbedCSS,
      cacheBust: true,
    }),
    45_000,
    'PDF capture timed out. Try again or use Print.'
  );

  const widthMm = 80;
  const heightMm = widthMm * (canvas.height / Math.max(canvas.width, 1));
  const pdf = new jsPDF({ unit: 'mm', format: [widthMm, heightMm], compress: true });
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, widthMm, heightMm, undefined, 'FAST');
  return pdf;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    void promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}
