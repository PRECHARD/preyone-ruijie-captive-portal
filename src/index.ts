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
import { adminAuthRouter } from './routes/adminAuth';
import { paymentsRouter } from './routes/payments';
import { gatewayRouter } from './routes/gateway';
import { posRouter } from './routes/pos';
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
// CORS: reflect exact trusted origins with credentials (cross-subdomain cookie SSO).
// Same-origin requests carry no Origin header and are untouched; the allowlist
// stops credentials from being returned to arbitrary third-party origins.
const corsOriginPatterns: RegExp[] =
  process.env.NODE_ENV === 'production'
    ? [/^https?:\/\/(([a-z0-9-]+)\.)*preyone\.com$/i]
    : [/^http:\/\/localhost:\d+$/i, /^http:\/\/127\.0\.0\.1:\d+$/i];

app.use(
  cors({
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      if (!origin) return callback(null, false);
      return callback(null, corsOriginPatterns.some((re) => re.test(origin)));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86400,
  })
);
app.use(compression());
app.use(morgan('combined'));
app.use(express.json());
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

const portalLoginUrl = 'http://wifi.preyone.com/login?gw=true';

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

  // app.preyone.com → Universal tenant gateway (Approach B)
  if (host === 'app.preyone.com') {
    const appDist = path.join(__dirname, '..', 'app', 'dist');
    if (fs.existsSync(appDist)) {
      const appStatic = express.static(appDist);
      return appStatic(req, res, () => {
        // SPA fallback: serve index.html for all non-file paths
        res.sendFile(path.join(appDist, 'index.html'));
      });
    }
    return res.status(503).send('Gateway build not found');
  }

  // pos.preyone.com → POS terminal SPA
  if (host === 'pos.preyone.com') {
    const posDist = path.join(__dirname, '..', 'pos', 'dist');
    if (fs.existsSync(posDist)) {
      const posStatic = express.static(posDist);
      return posStatic(req, res, () => {
        res.sendFile(path.join(posDist, 'index.html'));
      });
    }
    return res.status(503).send('POS build not found');
  }

  // wifi.preyone.com → captive portal
  if (host === 'wifi.preyone.com') {
    // Tell OS this is a captive portal (triggers popup on iOS/Android/Windows)
    res.setHeader('X-Captive-Portal', 'true');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    // Let known non-static routes pass through to their route handlers
    if (['/login', '/account', '/forgot-password', '/reset-password'].includes(req.path)) {
      return next();
    }
    return express.static(path.join(__dirname, '..', 'public'))(req, res, () => {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });
  }

  // preyone.com → main site
  if (host === 'preyone.com' || host === 'www.preyone.com') {
    return express.static(path.join(__dirname, '..', 'site'))(req, res, () => {
      res.sendFile(path.join(__dirname, '..', 'site', 'index.html'));
    });
  }

  // Any IP or unknown host → captive portal (with proper static file serving)
  res.setHeader('X-Captive-Portal', 'true');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  return express.static(path.join(__dirname, '..', 'public'))(req, res, () => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
});

// Maintenance mode check (blocks portal routes, skips admin & static)
app.use(maintenanceCheck);

app.use('/api/auth', authRouter);
app.use('/api/admin/auth', adminAuthRouter);
app.use('/api/admin', adminRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/pos', posRouter);

// Standard route aliases
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'account-login.html')));
app.get('/account', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'manage-account.html')));
app.get('/forgot-password', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'forgot-password.html')));
app.get('/reset-password', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'reset-password.html')));

// Fallback for unmatched routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handler (must be last)
app.use(errorHandler);

// Crash in production if JWT_SECRET is insecure default
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'preyone-jwt-secret-change-in-production')) {
  console.error('FATAL: JWT_SECRET must be set to a strong random value in production.');
  process.exit(1);
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
