import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import fs from 'fs';

import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { posRouter } from './routes/pos';
import { adminAuthRouter } from './routes/adminAuth';
import { paymentsRouter } from './routes/payments';
import { gatewayRouter } from './routes/gateway';
import { transitRouter } from './routes/transit';
import { transitWebRouter } from './routes/transitWeb';
import { systemAdminRouter } from './routes/systemAdmin';
import { errorHandler } from './middleware/errorHandler';
import { maintenanceCheck } from './middleware/maintenanceMode';
import { scheduleSessionCleanup } from './services/sessionCleanup';
import { scheduleAccessLogCleanup } from './services/accessLogCleanup';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.set('trust proxy', 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["*"],
        connectSrc: ["'self'", 'http://192.168.1.216:2060', 'http://192.168.100.1:2060'],
        upgradeInsecureRequests: null,
      },
    },
  })
);
// Cross-subdomain CORS: reflect only Preyone origins so the SSO cookie can be
// sent (credentials) without opening the API up to third-party sites.
const PREYONE_ORIGIN_RE = /^https:\/\/(?:[a-z0-9-]+\.)*preyone\.com(\/|$)/i;
const isDevOrigin = (origin: string) => /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/|$)/.test(origin);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      if (PREYONE_ORIGIN_RE.test(origin) || isDevOrigin(origin)) return callback(null, origin);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86400,
  })
);
app.use(compression());
app.use(morgan('combined'));
app.use(
  express.json({
    limit: '5mb',
    verify: (req: any, _res: any, buf: Buffer) => {
      // Preserve the raw body so the payment webhook can hash it.
      (req as any).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Gateway routes (work on any host, registered before subdomain routing) ──
app.use(gatewayRouter);

// WISPr XML helper — tells Apple/iOS that this is a captive portal
function wisprXml(loginUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<WISPAccessGatewayParam xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.wi-fi.org/files/wispr/WISPr-1.0.xsd">
  <Redirect>
    <AccessProcedure>1.0</AccessProcedure>
    <AccessLocation>Preyone UltraNet Wi-Fi</AccessLocation>
    <LoginURL>${escapeXml(loginUrl)}</LoginURL>
    <MessageType>100</MessageType>
    <ResponseCode>0</ResponseCode>
  </Redirect>
</WISPAccessGatewayParam>`;
}
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const optimizedImageStaticOptions = {
  setHeaders: (res: express.Response, filePath: string) => {
    if (/\.(png|jpe?g|gif|webp|avif|ico|svg|bmp|tiff?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
};

// ── SEO routes ────────────────────────────────────────────────
// Registered BEFORE the subdomain router and the `app.get('*')`
// catch-all so crawlers always receive the raw XML / plain text.

const SITEMAP_URLS = [
  { loc: 'https://preyone.com/', changefreq: 'weekly', priority: '1.0' },
  { loc: 'https://preyone.com/about', changefreq: 'monthly', priority: '0.8' },
  { loc: 'https://preyone.com/services', changefreq: 'monthly', priority: '0.8' },
  { loc: 'https://preyone.com/portfolio', changefreq: 'monthly', priority: '0.8' },
];

app.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml');
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_URLS.map(
    (u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
  ).join('\n');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
});

app.get('/robots.txt', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('User-agent: *\nAllow: /\n\nSitemap: https://preyone.com/sitemap.xml\n');
});

// Advertise /connect (voucher form) rather than /login (account sign-in), so OS
// captive-portal detection drops a phone straight onto the redemption page.
const portalLoginUrl = 'http://wifi.preyone.com/connect?gw=true';

// Captive portal detection — serves WISPr XML so Apple/Android/Windows
// devices detect the captive portal and show the OS-level login popup.
// These must be BEFORE the subdomain middleware so they're not caught by static serving.
app.get('/generate_204', (_req, res) => {
  res.redirect('/login?gw=true');
});
app.get('/hotspot-detect.html', (_req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(wisprXml(portalLoginUrl));
});
app.get('/ncsi.txt', (_req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(wisprXml(portalLoginUrl));
});
app.get('/connecttest.txt', (_req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(wisprXml(portalLoginUrl));
});
app.get('/wispr', (_req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(wisprXml(portalLoginUrl));
});

// ── Subdomain-based routing ──
app.use((req, res, next) => {
  const host = req.hostname;

  // API routes always work regardless of subdomain
  if (req.path.startsWith('/api/')) return next();

  // APK download at /downloads/*.
  //
  // `app-release.apk` is a SYMLINK into ../storage/downloads, pointing at the
  // currently promoted build. express.static (via `send`) refuses to follow
  // symlinks, and the admin SPA fallback answers every unmatched path with
  // index.html — so a broken or missing link silently served the SPA shell with
  // a 200 and text/html. A user tapping "Download" then got an unopenable file
  // with no error. This resolves the real path and, crucially, verifies the
  // target is a real file before serving it, so a dangling link now returns 404
  // instead of a fake 200.
  if (req.path.startsWith('/downloads/')) {
    const rel = req.path.replace(/^\/+/, '');
    // storage/downloads is the source of truth; admin/dist/downloads is a
    // symlink into it. The symlink is NOT relied upon because `vite build`
    // empties admin/dist, silently destroying it — that is how the live
    // download regressed to serving index.html. Both are checked, storage
    // first, so a rebuild cannot break the download.
    const candidates = [
      path.join(__dirname, '..', 'storage', rel),
      path.join(__dirname, '..', 'admin', 'dist', rel),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const real = fs.realpathSync(candidate);
      if (fs.existsSync(real) && fs.statSync(real).isFile()) {
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(real);
      }
    }
    res.status(404).type('text/plain').send('Download not available.');
    return;
  }

  // admin.preyone.com → serve admin SPA static + fallback
  if (host === 'admin.preyone.com') {
    const adminDist = path.join(__dirname, '..', 'admin', 'dist');
    if (fs.existsSync(adminDist)) {
      const adminStatic = express.static(adminDist);
      return adminStatic(req, res, () => {
        // SPA fallback: serve index.html for all non-file paths
        res.sendFile(path.join(adminDist, 'index.html'));
      });
    }
    return res.status(503).send('Admin build not found');
  }

  // wifi.preyone.com → captive portal
  if (host === 'wifi.preyone.com') {
    // Tell OS this is a captive portal (triggers popup on iOS/Android/Windows)
    res.setHeader('X-Captive-Portal', 'true');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    // Let known non-static routes pass through to their route handlers
    if (['/login', '/account', '/forgot-password', '/reset-password', '/connect'].includes(req.path)) {
      return next();
    }
    // Strip Range header — the gateway preserves original request headers (e.g. from video streaming)
    // and express.static throws RangeNotSatisfiableError on index.html
    delete req.headers['range'];
    delete req.headers['if-range'];
    return express.static(path.join(__dirname, '..', 'public'), optimizedImageStaticOptions)(req, res, () => {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });
  }

  // preyone.com → main site (React SPA build)
  if (host === 'preyone.com' || host === 'www.preyone.com') {
    const siteDist = path.join(__dirname, '..', 'site', 'dist');
    if (fs.existsSync(siteDist)) {
      // The APK is also downloadable from the main site, so the download must
      // resolve against admin/dist (where the symlink lives) rather than the
      // site bundle. The block above already handled it; this is the fallback
      // for the case where a reverse proxy routed it here with the path intact.
      if (req.path.startsWith('/downloads/')) {
        res.status(404).type('text/plain').send('Download not available.');
        return;
      }
      return express.static(siteDist, optimizedImageStaticOptions)(req, res, () => {
        // SPA fallback: serve index.html for all non-file paths
        res.sendFile(path.join(siteDist, 'index.html'));
      });
    }
    return res.status(503).send('Preyone site build not found. Run `cd site && npm run build`.');
  }

  // pos.preyone.com → POS terminal SPA (self-serve ordering / till)
  if (host === 'pos.preyone.com') {
    const posDist = path.join(__dirname, '..', 'pos', 'dist');
    if (fs.existsSync(posDist)) {
      delete req.headers['range'];
      delete req.headers['if-range'];
      return express.static(posDist)(req, res, () => {
        res.sendFile(path.join(posDist, 'index.html'));
      });
    }
    return res.status(503).send('POS build not found. Run `cd pos && npm run build`.');
  }

  // app.preyone.com → enterprise gateway (single-login module launcher)
  if (host === 'app.preyone.com') {
    const appDist = path.join(__dirname, '..', 'app', 'dist');
    if (fs.existsSync(appDist)) {
      delete req.headers['range'];
      delete req.headers['if-range'];
      return express.static(appDist)(req, res, () => {
        res.sendFile(path.join(appDist, 'index.html'));
      });
    }
    return res.status(503).send('Gateway build not found. Run `cd app && npm run build`.');
  }

  // Any IP or unknown host → captive portal (with proper static file serving)
  res.setHeader('X-Captive-Portal', 'true');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  // Strip Range header — the gateway preserves original request headers (e.g. from video streaming)
  // and express.static throws RangeNotSatisfiableError on index.html
  delete req.headers['range'];
  delete req.headers['if-range'];
  return express.static(path.join(__dirname, '..', 'public'), optimizedImageStaticOptions)(req, res, () => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
});

// Maintenance mode check (blocks portal routes, skips admin & static)
app.use(maintenanceCheck);

app.use('/api/auth', authRouter);
app.use('/api/admin/auth', adminAuthRouter);
app.use('/api/admin', adminRouter);
app.use('/api/v1/admin', systemAdminRouter);
app.use('/api/v1/transit', transitWebRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/transit', transitRouter);
app.use('/api/pos', posRouter);

// Standard route aliases
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'account-login.html')));
app.get('/account', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'manage-account.html')));
app.get('/forgot-password', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'forgot-password.html')));
app.get('/reset-password', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'reset-password.html')));

// Self-service connect. This is the URL the gateway's "Portal URL" should point
// at: the customer lands straight on the voucher box instead of the account
// sign-in form at /login. Any gateway query string (?client_mac=…&login_url=…&ssid=…)
// is preserved because the page forwards location.search to /api/auth/signup,
// which needs those params to build the ext_login authorization URL.
app.get('/connect', (_req, res) => {
  res.setHeader('X-Captive-Portal', 'true');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Fallback for unmatched routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handler (must be last)
app.use(errorHandler);

// Crash in production if JWT secrets are unset or insecure defaults.
// No fallbacks — refuse boot until valid strong secrets are configured.
function failProdSecret(label: string): void {
  console.error(`FATAL: ${label} must be set to a strong random value in production. Refusing to boot.`);
  console.error('Set it in the server .env file and restart. Do not use a default/fallback value.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  const secStrictLabel = (v?: string) => v && String(v).length >= 24 && v !== 'preyone-jwt-secret-change-in-production' && v !== 'preyone-transit-jwt-secret-change-in-production';

  if (!secStrictLabel(process.env.JWT_SECRET)) {
    failProdSecret('JWT_SECRET');
  }
  const transitSecret = process.env.TRANSIT_JWT_SECRET || process.env.JWT_SECRET;
  if (!secStrictLabel(transitSecret)) {
    failProdSecret('TRANSIT_JWT_SECRET');
  }
  // NOTE: there is deliberately no PAYMENTS_WEBHOOK_SECRET guard here.
  // Requiring an out-of-band signature made us 401 every real payment callback:
  // a payment on 2026-09-22 was retried 24 times and rejected every time, so the
  // customer was charged and never received a voucher.
  // Pesepay callbacks are instead authenticated by AES-CBC decryption with the
  // pre-shared PESEPAY_ENCRYPTION_KEY, backed by a per-payment 32-byte secret
  // token embedded in the resultUrl we hand Pesepay — see payments.ts.
}

// Also warn loudly (without blocking dev) when falling back to a default.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'preyone-jwt-secret-change-in-production') {
  console.warn('WARNING: JWT_SECRET not set or using the insecure default. Set a strong JWT_SECRET in .env.');
}

// Start server
app.listen(PORT, () => {
  console.log(`Captive portal running on http://0.0.0.0:${PORT}`);

  if (process.env.ENABLE_SESSION_CLEANUP !== 'false') {
    const intervalMinutes = Number(process.env.SESSION_CLEANUP_INTERVAL_MIN ?? 15);
    scheduleSessionCleanup(intervalMinutes);
    console.log(`Session cleanup scheduled every ${intervalMinutes} minute(s).`);
  }

  if (process.env.ENABLE_ACCESS_LOG_CLEANUP !== 'false') {
    const intervalMinutes = Number(process.env.ACCESS_LOG_CLEANUP_INTERVAL_MIN ?? 60);
    const retentionDays = Number(process.env.ACCESS_LOG_RETENTION_DAYS ?? 30);
    scheduleAccessLogCleanup(intervalMinutes, retentionDays);
    console.log(`Access log cleanup scheduled every ${intervalMinutes} minute(s), retaining ${retentionDays} day(s).`);
  }
});

export default app;
