import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'path';

import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { errorHandler } from './middleware/errorHandler';
import { scheduleSessionCleanup } from './services/sessionCleanup';
import { scheduleAccessLogCleanup } from './services/accessLogCleanup';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  })
);
app.use(compression());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);

// Captive portal detection probes
app.get('/generate_204', (_req, res) => res.status(204).send());
app.get('/hotspot-detect.html', (_req, res) => res.redirect('/'));
app.get('/ncsi.txt', (_req, res) => res.send('Microsoft NCSI'));
app.get('/connecttest.txt', (_req, res) => res.send('Microsoft Connect Test'));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(errorHandler);

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
