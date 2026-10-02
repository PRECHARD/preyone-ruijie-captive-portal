import ExcelJS from 'exceljs';
import { getCompanyBrand, money, BRAND_PALETTE } from './companyBrand';

const C = BRAND_PALETTE;

async function loadLogoBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } catch {
    return null;
  }
}

async function brandBanner(
  ws: ExcelJS.Worksheet,
  brand: { name: string; support_phone: string; website: string; email: string },
  sheetTitle: string,
  from: string,
  to: string,
  colCount: number,
  logo?: string | null
): Promise<number> {
  const lastCol = String.fromCharCode(64 + colCount);
  let row = 1;

  if (logo) {
    const img = ws.workbook.addImage({ base64: logo, extension: 'png' });
    ws.addImage(img, { tl: { col: 0, row: 0 }, ext: { width: 200, height: 112 } });
    for (let i = 1; i <= 4; i++) ws.getRow(i).height = 28;
    row = 5;
  }

  ws.mergeCells(`A${row}:${lastCol}${row}`);
  const r1 = ws.getCell(`A${row}`);
  r1.value = brand.name;
  r1.font = { name: 'Copperplate Gothic', size: 18, bold: true, color: { argb: C.NV } };
  ws.getRow(row).height = 26;
  row++;

  ws.mergeCells(`A${row}:${lastCol}${row}`);
  const r2 = ws.getCell(`A${row}`);
  r2.value = `${sheetTitle}  ·  Period: ${from} to ${to}`;
  r2.font = { name: 'Calibri', size: 12, bold: true, color: { argb: C.NP } };
  ws.getRow(row).height = 20;
  row++;

  const contact = [brand.support_phone, brand.website, brand.email].filter(Boolean).join('  ·  ');
  if (contact) {
    ws.mergeCells(`A${row}:${lastCol}${row}`);
    const r3 = ws.getCell(`A${row}`);
    r3.value = contact;
    r3.font = { name: 'Calibri', size: 9, italic: true, color: { argb: C.DPB } };
    ws.getRow(row).height = 16;
    row++;
  }

  ws.mergeCells(`A${row}:${lastCol}${row}`);
  const r4 = ws.getCell(`A${row}`);
  r4.value = `Generated: ${new Date().toLocaleString()}`;
  r4.font = { name: 'Calibri', size: 9, italic: true, color: { argb: C.DPB } };
  ws.getRow(row).height = 16;

  return row + 2;
}

function neonTable(
  ws: ExcelJS.Worksheet,
  opts: {
    startRow: number;
    headers: string[];
    data: Array<Array<string | number>>;
    firstColStyle?: 'code';
    alignRight?: number[];
  }
) {
  const { startRow, headers, data, firstColStyle, alignRight = [] } = opts;
  const hr = ws.getRow(startRow);
  hr.height = 24;
  headers.forEach((h, i) => {
    const c = hr.getCell(i + 1);
    c.value = h;
    c.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.WH } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.DPB } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = { left: { style: 'thin', color: { argb: C.DPB } }, right: { style: 'thin', color: { argb: C.DPB } } };
  });

  let row = startRow + 1;
  data.forEach((vals, ri) => {
    const dRow = ws.getRow(row);
    dRow.height = 20;
    const isAlt = ri % 2 === 0;
    vals.forEach((v, i) => {
      const c = dRow.getCell(i + 1);
      c.value = v;
      c.font = {
        name: firstColStyle && i === 0 ? 'Consolas' : 'Calibri',
        size: 10,
        bold: true,
        color: { argb: firstColStyle && i === 0 ? C.NP : C.DPB },
      };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isAlt ? C.LP : C.WH } };
      c.alignment = { horizontal: alignRight.includes(i + 1) ? 'right' : 'left', vertical: 'middle' };
      c.border = {
        left: { style: 'thin', color: { argb: C.DPB } },
        right: { style: 'thin', color: { argb: C.DPB } },
      };
    });
    row++;
  });
}

async function saveWorkbook(wb: ExcelJS.Workbook, fileName: string) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function brandFile(name: string): string {
  return name.replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, '_') || 'Preyone';
}

export async function exportReportExcel(data: any, from: string, to: string, presetLabel?: string) {
  const brand = await getCompanyBrand();
  const cur = brand.currency;
  const t = data.totals;
  const wb = new ExcelJS.Workbook();
  wb.creator = brand.name;

  const logo = await loadLogoBase64('/images/staff-excel-preyonelogo.png');
  const title = presetLabel ? `${presetLabel} Sales Report` : 'Sales Report';

  const ws = wb.addWorksheet('Summary');
  ws.columns = [{ width: 22 }, { width: 18 }];
  const startRow = await brandBanner(ws, brand, title, from, to, 2, logo);
  neonTable(ws, {
    startRow,
    headers: ['METRIC', 'VALUE'],
    firstColStyle: 'code',
    alignRight: [2],
    data: [
      ['Revenue', money(t?.revenue || 0, cur)],
      ['Collected', money(t?.collected || 0, cur)],
      ['Balance Due', money((t?.revenue || 0) - (t?.collected || 0), cur)],
      ['Profit', money(t?.profit || 0, cur)],
      [
        'Margin %',
        Number(t?.revenue) > 0 ? `${((Number(t?.profit) / Number(t?.revenue)) * 100).toFixed(1)}%` : '0%',
      ],
      ['VAT / Tax', money(t?.vat || 0, cur)],
      ['Documents', String(Number(t?.docs || 0))],
    ],
  });

  const matrix: Array<{
    name: string;
    headers: string[];
    cols: number[];
    rows: Array<Array<string | number>>;
  }> = [];

  if (data.byMethod?.length) {
    matrix.push({
      name: 'By Payment Method',
      headers: ['METHOD', 'COUNT', 'TOTAL'],
      cols: [24, 14, 18],
      rows: data.byMethod.map((r: any) => [
        r.method?.charAt(0).toUpperCase() + r.method?.slice(1),
        String(Number(r.count)),
        money(Number(r.total), cur),
      ]),
    });
  }
  if (data.bestSellers?.length) {
    matrix.push({
      name: 'Best Sellers',
      headers: ['ITEM', 'QTY SOLD', 'REVENUE', 'PROFIT'],
      cols: [30, 14, 18, 18],
      rows: data.bestSellers.map((r: any) => [
        r.description,
        String(Number(r.qty_sold)),
        money(Number(r.revenue), cur),
        money(Number(r.profit), cur),
      ]),
    });
  }
  if (data.byCashier?.length) {
    matrix.push({
      name: 'Staff Performance',
      headers: ['CASHIER', 'DOCUMENTS', 'REVENUE', 'COLLECTED'],
      cols: [22, 14, 18, 18],
      rows: data.byCashier.map((r: any) => [
        r.cashier,
        String(Number(r.docs)),
        money(Number(r.revenue), cur),
        money(Number(r.collected), cur),
      ]),
    });
  }
  if (data.byDay?.length) {
    matrix.push({
      name: 'Daily Revenue',
      headers: ['DAY', 'DOCUMENTS', 'REVENUE'],
      cols: [14, 14, 18],
      rows: data.byDay.map((r: any) => [String(r.day), String(Number(r.docs)), money(Number(r.revenue), cur)]),
    });
  }
  if (data.lowStock?.length) {
    matrix.push({
      name: 'Low Stock Alerts',
      headers: ['PRODUCT', 'STOCK QTY'],
      cols: [30, 14],
      rows: data.lowStock.map((r: any) => [r.name, String(Number(r.stock_qty))]),
    });
  }

  for (const m of matrix) {
    const s = wb.addWorksheet(m.name);
    s.columns = m.cols.map((c: number) => ({ width: c }));
    const sr = await brandBanner(s, brand, title, from, to, m.headers.length, undefined);
    neonTable(s, {
      startRow: sr,
      headers: m.headers,
      data: m.rows,
      alignRight: m.headers.map((_, i) => i + 1).filter((i) => i > 1),
    });
  }

  await saveWorkbook(wb, `${brandFile(brand.name)}-POS-Report-${from}-to-${to}.xlsx`);
}