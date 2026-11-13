import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function waitForPort(port) {
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => setTimeout(attempt, 250));
    };
    attempt();
  });
}

function waitForFile(file) {
  return new Promise((resolve) => {
    const attempt = () => {
      if (fs.existsSync(file)) resolve();
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

const children = [];
function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  return child;
}

function stop() {
  for (const child of children) child.kill();
  process.exit();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run('npx', ['vite']);
run('npx', ['tsc', '-p', 'tsconfig.main.json', '--watch', '--preserveWatchOutput']);

await Promise.all([
  waitForPort(5176),
  waitForFile(path.join(root, 'dist', 'main', 'index.js')),
  waitForFile(path.join(root, 'dist', 'preload', 'shell.js')),
]);

const electron = run('npx', ['electron', '.'], { ELECTRON_RENDERER_URL: 'http://127.0.0.1:5176' });
electron.on('exit', (code) => {
  stop();
  process.exit(code ?? 0);
});
