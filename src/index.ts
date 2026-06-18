import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';

import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { adminAuthRouter } from './routes/adminAuth';
import { paymentsRouter } from './routes/payments';
import { errorHandler } from './middleware/errorHandler';
import { maintenanceCheck } from './middleware/maintenanceMode';
import { scheduleSessionCleanup } from './services/sessionCleanup';
import { scheduleAccessLogCleanup } from './services/accessLogCleanup';

const app = express();
const PORT = process.env.PORT ?? 3000;

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
      },
    },
  })
);
app.use(cors());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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

  // wifi.preyone.com → captive portal
  if (host === 'wifi.preyone.com') {
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

  // localhost / 127.0.0.1 → captive portal at root
  if (host === 'localhost' || host === '127.0.0.1') {
    return express.static(path.join(__dirname, '..', 'public'))(req, res, () => {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });
  }

  // Fallback for unknown hosts
  next();
});

// Maintenance mode check (blocks portal routes, skips admin & static)
app.use(maintenanceCheck);

app.use('/api/auth', authRouter);
app.use('/api/admin/auth', adminAuthRouter);
app.use('/api/admin', adminRouter);
app.use('/api/payments', paymentsRouter);

// Captive portal detection probes (respond on any host)
app.get('/generate_204', (_req, res) => res.status(204).send());
app.get('/hotspot-detect.html', (_req, res) => res.redirect('/'));
app.get('/ncsi.txt', (_req, res) => res.send('Microsoft NCSI'));
app.get('/connecttest.txt', (_req, res) => res.send('Microsoft Connect Test'));

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
