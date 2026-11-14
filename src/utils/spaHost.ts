import express from 'express';
import fs from 'fs';
import path from 'path';

/**
 * Resolve a subdomain's SPA bundle directory.
 *
 * The env override wins so a build that lives outside this repo (the standalone
 * invoicing suite, for example) can be served without being copied in. The
 * fallback is the monorepo folder that `vite build` writes to, resolved from
 * the repo root (`src/utils` and `dist/utils` both sit two levels down).
 */
export function spaDistDir(envVar: string, fallbackDir: string): string {
  const override = process.env[envVar];
  if (override && override.trim()) return path.resolve(override.trim());
  return path.resolve(__dirname, '..', '..', fallbackDir);
}

/**
 * Serve a built SPA bundle: hashed assets through express.static, then an
 * index.html fallback so deep links survive a refresh. Returns false when the
 * bundle is missing (or was built without an index.html) so the caller can
 * answer 503 with its own hint instead of silently serving a blank page.
 */
export function serveSpaBundle(
  req: express.Request,
  res: express.Response,
  distDir: string
): boolean {
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) return false;

  // The captive gateway forwards Range headers preserved from media players,
  // and express.static raises RangeNotSatisfiableError when they hit
  // index.html.
  delete req.headers['range'];
  delete req.headers['if-range'];

  const serve = express.static(distDir, {
    setHeaders: (spaRes, filePath) => {
      // Without this, browsers heuristically cache index.html and keep loading
      // the previous build's hashed JS/CSS after a deploy.
      if (filePath.endsWith('.html')) {
        spaRes.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  });

  serve(req, res, () => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(indexPath);
  });
  return true;
}
