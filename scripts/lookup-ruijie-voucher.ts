import 'dotenv/config';
import { isRuijieCloudConfigured, getRuijieVouchers } from '../src/services/ruijieCloud';

async function main(): Promise<void> {
  const target = (process.argv[2] || 'ebywa6').toLowerCase();
  if (!isRuijieCloudConfigured()) {
    console.log(JSON.stringify({ configured: false }));
    process.exit(2);
  }
  let start = 0;
  const pageSize = 200;
  let pages = 0;
  const found: unknown[] = [];
  while (pages < 30) {
    const list = await getRuijieVouchers({ start, pageSize });
    pages += 1;
    if (!list.length) break;
    for (const v of list) {
      const codes = [v.codeNo, v.voucherCode].filter(Boolean) as string[];
      if (codes.some((c) => c.toLowerCase() === target)) {
        found.push({
          codeNo: v.codeNo,
          voucherCode: v.voucherCode ?? null,
          profile: v.profile ?? null,
          userGroupId: v.userGroupId ?? null,
          expiryTime: v.expiryTime ?? null,
          status: v.status ?? null,
          comment: v.comment ?? null,
        });
      }
    }
    if (found.length || list.length < pageSize) break;
    start += pageSize;
  }
  console.log(JSON.stringify({ configured: true, pages, scannedPages: pages, found }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('LOOKUP_ERROR: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
