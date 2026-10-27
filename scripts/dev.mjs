#!/usr/bin/env node
/**
 * Starts every Rook service for local development, in one terminal.
 *
 *   pnpm dev
 *
 * Runs the API, the realtime gateway and the media worker as child processes,
 * prefixing each line of output with the service name so one scrollback is
 * readable. The desktop app is started separately (`pnpm dev:desktop` or
 * `pnpm desktop:tauri`), because Tauri wants its own terminal.
 *
 * Deliberately not a process manager: no restart-on-crash, no dependency
 * ordering beyond "start them all". Each service already waits for its own
 * dependencies and exits with a clear message if the database or Redis is
 * unreachable, so supervising them here would only hide that.
 *
 * Ctrl-C stops everything: SIGINT is forwarded to the children, and each
 * service drains via its own shutdown manager.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const services = [
  { name: 'api', filter: '@rook/api', colour: '\u001b[36m' },
  { name: 'realtime', filter: '@rook/realtime', colour: '\u001b[35m' },
  { name: 'worker', filter: '@rook/media-worker', colour: '\u001b[33m' },
];

const reset = '\u001b[0m';
const dim = '\u001b[2m';
const width = Math.max(...services.map((service) => service.name.length));

const children = [];
let shuttingDown = false;

function prefix(service) {
  return `${service.colour}${service.name.padEnd(width)}${reset} ${dim}|${reset} `;
}

for (const service of services) {
  // `pnpm --filter <pkg> dev` so each service's own dev script stays the
  // single definition of how it runs.
  const child = spawn('pnpm', ['--filter', service.filter, 'dev'], {
    // pnpm is a shell script on Windows; without this it is not executable.
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  children.push({ service, child });

  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue;
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => {
      // pnpm's own banner lines add noise without adding information.
      if (line.startsWith('> ') || line.trim().length === 0) return;
      process.stdout.write(`${prefix(service)}${line}\n`);
    });
  }

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    process.stdout.write(
      `${prefix(service)}exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})\n`,
    );

    // One service dying usually means a shared dependency is unreachable, and
    // leaving the others running makes the cause harder to see.
    stopAll(code ?? 1);
  });
}

function stopAll(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGINT');
  }

  // Give each service its shutdown grace period, then exit regardless.
  setTimeout(() => process.exit(exitCode), 5000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write(`\n${dim}stopping services...${reset}\n`);
    stopAll(0);
  });
}

process.stdout.write(
  `${dim}starting ${services.map((s) => s.name).join(', ')} — Ctrl-C to stop${reset}\n`,
);
