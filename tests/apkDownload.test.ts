/**
 * The APK download must serve a real APK, never the SPA shell.
 *
 * Regression: `app-release.apk` is a SYMLINK into ../storage/downloads pointing
 * at the promoted build. express.static (via `send`) refuses to follow
 * symlinks, and the admin SPA fallback answers every unmatched path with
 * index.html — so a dangling link produced a 200 with text/html. A user tapping
 * "Download" received a file their phone could not open, with no error shown.
 * This pins that a missing or broken link returns 404 instead of a fake 200.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const projectRoot = path.resolve(__dirname, '..');
const realIndex = fs.readFileSync(path.join(projectRoot, 'src', 'index.ts'), 'utf8');

/**
 * Replicates the middleware block from src/index.ts against temp dirs.
 * `storageDownloads` is the source of truth; `adminDist` holds the SPA and may
 * have lost its `downloads` symlink to `vite build`.
 */
function appWithDist(adminDist: string, storageDownloads?: string) {
  const app = express();
  app.use((req, res, next) => {
    const host = (req.headers.host || '').split(':')[0];
    if (req.path.startsWith('/downloads/')) {
      const rel = req.path.replace(/^\/+/, '');
      const candidates = storageDownloads
        ? [path.join(storageDownloads, rel), path.join(adminDist, rel)]
        : [path.join(adminDist, rel)];
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
    if (host === 'admin.preyone.com') {
      if (fs.existsSync(adminDist)) {
        return express.static(adminDist)(req, res, () => {
          res.sendFile(path.join(adminDist, 'index.html'));
        });
      }
      return res.status(503).send('Admin build not found');
    }
    return next();
  });
  return app;
}

function makeDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-dl-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html>SPA</html>');
  fs.mkdirSync(path.join(dir, 'downloads'));
  return dir;
}

/** Stands in for the repo's `storage/` directory. */
function makeStorage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-storage-'));
  fs.mkdirSync(path.join(dir, 'downloads'));
  return dir;
}

/**
 * Windows allows directory junctions without elevation, but creating a symlink
 * to a FILE requires Developer Mode or admin. A junction to a directory whose
 * contents are then deleted reproduces the dangling-link case faithfully:
 * `existsSync` follows the link and returns false.
 */
function makeDanglingLink(dist: string) {
  const target = path.join(dist, 'gone');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(dist, 'downloads', 'app-release.apk'), 'junction');
  fs.rmSync(target, { recursive: true, force: true });
}

describe('APK download route', () => {
  it('serves the APK once the link resolves to a real file', async () => {
    const dist = makeDist();
    const real = path.join(dist, 'real.apk');
    fs.writeFileSync(real, 'PK\x03\x04 pretend-apk-bytes');
    // Hard link: same inode, no elevation required on Windows.
    fs.linkSync(real, path.join(dist, 'downloads', 'app-release.apk'));

    const res = await request(appWithDist(dist))
      .get('/downloads/app-release.apk')
      .set('Host', 'admin.preyone.com');

    expect(res.status).toBe(200);
    expect(res.text).toContain('pretend-apk-bytes');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('returns 404, not the SPA shell, when the link is dangling', async () => {
    const dist = makeDist();
    makeDanglingLink(dist);

    const res = await request(appWithDist(dist))
      .get('/downloads/app-release.apk')
      .set('Host', 'admin.preyone.com');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<html>');
  });

  it('returns 404 when the link resolves to a directory', async () => {
    const dist = makeDist();
    const target = path.join(dist, 'a-dir');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(dist, 'downloads', 'app-release.apk'), 'junction');

    const res = await request(appWithDist(dist))
      .get('/downloads/app-release.apk')
      .set('Host', 'admin.preyone.com');

    expect(res.status).toBe(404);
  });

  it('returns 404 when the downloads directory is empty', async () => {
    const dist = makeDist();
    const res = await request(appWithDist(dist))
      .get('/downloads/app-release.apk')
      .set('Host', 'admin.preyone.com');
    expect(res.status).toBe(404);
  });

  it('serves from storage/downloads even when the admin symlink is gone', async () => {
    // This is the real production regression: `vite build` empties admin/dist,
    // destroying admin/dist/downloads -> ../../storage/downloads. The download
    // then fell through to the SPA fallback and served index.html with a 200.
    const dist = makeDist();
    const storage = makeStorage();
    fs.writeFileSync(
      path.join(storage, 'downloads', 'app-release.apk'), 'PK\x03\x04 storage-build');
    // Note: no admin/dist/downloads/app-release.apk exists at all.
    fs.rmSync(path.join(dist, 'downloads'), { recursive: true, force: true });

    const res = await request(appWithDist(dist, storage))
      .get('/downloads/app-release.apk')
      .set('Host', 'admin.preyone.com');

    expect(res.status).toBe(200);
    expect(res.text).toContain('storage-build');
  });

  it('prefers storage/downloads over a stale admin/dist copy', async () => {
    const dist = makeDist();
    const storage = makeStorage();
    fs.writeFileSync(
      path.join(storage, 'downloads', 'app-release.apk'), 'PK\x03\x04 fresh');
    fs.writeFileSync(
      path.join(dist, 'downloads', 'app-release.apk'), 'PK\x03\x04 stale');

    const res = await request(appWithDist(dist, storage))
      .get('/downloads/app-release.apk')
      .set('Host', 'admin.preyone.com');

    expect(res.status).toBe(200);
    expect(res.text).toContain('fresh');
  });

  it('never serves the SPA index.html with a 200 for a download', async () => {
    const dist = makeDist();
    const res = await request(appWithDist(dist))
      .get('/downloads/app-release.apk')
      .set('Host', 'admin.preyone.com');
    expect(res.status).not.toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('still serves the SPA for a normal admin route', async () => {
    const dist = makeDist();
    const res = await request(appWithDist(dist))
      .get('/some/spa/route')
      .set('Host', 'admin.preyone.com');
    expect(res.status).toBe(200);
    expect(res.text).toContain('SPA');
  });
});

describe('src/index.ts wiring', () => {
  it('handles /downloads/ before the admin SPA fallback', () => {
    const dlAt = realIndex.indexOf("req.path.startsWith('/downloads/')");
    const adminAt = realIndex.indexOf("host === 'admin.preyone.com'");
    expect(dlAt).toBeGreaterThan(-1);
    expect(adminAt).toBeGreaterThan(-1);
    expect(dlAt).toBeLessThan(adminAt);
  });
});
