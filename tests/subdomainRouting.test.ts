/**
 * Subdomain hardening: pos / app / invoice / homeautomate must each resolve to
 * their own SPA bundle, and a missing bundle must fail loudly (503) instead of
 * silently serving a blank page or someone else's shell.
 *
 * The router lives in the middleware inside src/index.ts, which cannot be
 * imported by a unit test (it boots the server and every background worker), so
 * the behavioural cases exercise the shared helper in src/utils/spaHost.ts and
 * the source-level cases pin the host wiring itself.
 */
import { describe, expect, it, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { serveSpaBundle, spaDistDir } from '../src/utils/spaHost';

const projectRoot = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(projectRoot, 'src', 'index.ts'), 'utf8');

const tempDirs: string[] = [];

function makeDist(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preyone-spa-'));
  tempDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function appFor(dist: string) {
  const app = express();
  app.use((req, res) => {
    if (serveSpaBundle(req, res, dist)) return;
    res.status(503).send('build not found');
  });
  return app;
}

describe('spaHost helper', () => {
  it('serves the SPA shell for a deep link instead of a 404', async () => {
    const dist = makeDist({ 'index.html': '<!doctype html><div id="root"></div>' });
    const res = await request(appFor(dist)).get('/invoices/42');

    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('serves hashed assets without forcing them to be revalidated', async () => {
    const dist = makeDist({
      'index.html': '<!doctype html>',
      'assets/app-abc123.js': 'console.log(1)',
    });
    const res = await request(appFor(dist)).get('/assets/app-abc123.js');

    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log(1)');
    expect(res.headers['cache-control'] ?? '').not.toContain('no-store');
  });

  it('reports a missing bundle so the caller can answer 503', async () => {
    const dist = makeDist({});
    const res = await request(appFor(dist)).get('/');

    expect(res.status).toBe(503);
    expect(res.text).toContain('build not found');
  });

  it('resolves the bundle from an env override when one is set', () => {
    const dist = makeDist({ 'index.html': '<!doctype html>' });
    const previous = process.env.INVOICE_DIST;
    process.env.INVOICE_DIST = dist;
    try {
      expect(spaDistDir('INVOICE_DIST', path.join('invoice', 'dist'))).toBe(path.resolve(dist));
    } finally {
      if (previous === undefined) delete process.env.INVOICE_DIST;
      else process.env.INVOICE_DIST = previous;
    }
  });

  it('falls back to the monorepo folder when the override is unset', () => {
    const previous = process.env.HOMEAUTOMATE_DIST;
    delete process.env.HOMEAUTOMATE_DIST;
    try {
      expect(spaDistDir('HOMEAUTOMATE_DIST', path.join('homeautomate', 'dist'))).toBe(
        path.join(projectRoot, 'homeautomate', 'dist')
      );
    } finally {
      if (previous !== undefined) process.env.HOMEAUTOMATE_DIST = previous;
    }
  });
});

describe('src/index.ts host wiring', () => {
  const hosts: Array<[string, string]> = [
    ['pos.preyone.com', 'pos'],
    ['app.preyone.com', 'app'],
    ['invoice.preyone.com', 'invoice'],
    ['homeautomate.preyone.com', 'homeautomate'],
  ];

  it.each(hosts)('maps %s to its own bundle', (host, folder) => {
    expect(indexSource).toContain(`host === '${host}'`);
    expect(indexSource).toContain(`'${folder}', 'dist'`);
  });

  it('gives the external-build hosts an env override', () => {
    expect(indexSource).toContain("spaDistDir('INVOICE_DIST'");
    expect(indexSource).toContain("spaDistDir('HOMEAUTOMATE_DIST'");
  });

  it('routes every new host before the unknown-host captive-portal fallback', () => {
    const fallback = indexSource.indexOf('Any IP or unknown host');
    expect(fallback).toBeGreaterThan(0);
    for (const [host] of hosts) {
      expect(indexSource.indexOf(`host === '${host}'`)).toBeLessThan(fallback);
    }
  });
});
