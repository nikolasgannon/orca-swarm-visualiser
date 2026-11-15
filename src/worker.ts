import type { OrcaWorkerApi, Disposable } from 'orca/worker';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4319;
const EVENTS_FILE = path.join(os.homedir(), '.orca-swarm', 'events.jsonl');

let serverProcess: ChildProcess | null = null;
let disposables: Disposable[] = [];

/**
 * Ensures ~/.orca-swarm directory exists and appends an event object as a JSON line.
 */
function appendEvent(eventData: Record<string, unknown>): void {
  try {
    const dir = path.dirname(EVENTS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try { fs.chmodSync(dir, 0o700); } catch {}
    const line = JSON.stringify(eventData) + '\n';
    fs.appendFileSync(EVENTS_FILE, line, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(EVENTS_FILE, 0o600); } catch {}
  } catch (err) {
    console.error('[orca-swarm-visualiser] Failed to append event to events.jsonl:', err);
  }
}

/**
 * Searches for bridge/server.mjs across common relative and absolute paths.
 */
function findServerPath(): string {
  let currentDir = '';
  try {
    currentDir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  } catch {
    currentDir = process.cwd();
  }

  const candidates = [
    path.resolve(currentDir, '..', 'bridge', 'server.mjs'),
    path.resolve(currentDir, 'bridge', 'server.mjs'),
    path.join(process.cwd(), 'bridge', 'server.mjs')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * Checks if the bridge server is currently listening on the specified port.
 */
function isServerRunning(port = DEFAULT_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1000 }, (res: http.IncomingMessage) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Starts bridge/server.mjs in the background if it is not already running.
 */
async function startServerIfNotRunning(port = DEFAULT_PORT): Promise<void> {
  const running = await isServerRunning(port);
  if (running) {
    return;
  }

  const serverScript = findServerPath();
  if (!fs.existsSync(serverScript)) {
    console.warn(`[orca-swarm-visualiser] bridge server script not found at ${serverScript}`);
    return;
  }

  try {
    serverProcess = spawn(process.execPath || 'node', [serverScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ORCA_SWARM_HOST: process.env.ORCA_SWARM_HOST || '127.0.0.1',
        ORCA_SWARM_PORT: String(port)
      }
    });
    serverProcess.unref();

    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await isServerRunning(port)) {
        break;
      }
    }
  } catch (err) {
    console.error('[orca-swarm-visualiser] Failed to spawn bridge server:', err);
  }
}

/**
 * Plugin activation hook called by Orca.
 */
export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const parsedPort = parseInt(process.env.ORCA_SWARM_PORT || String(DEFAULT_PORT), 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT;

  // 1. Start bridge server in the background if not running
  await startServerIfNotRunning(port);

  // 2. Listen to orca.events for agent.status.changed and append to ~/.orca-swarm/events.jsonl
  const eventSub = orca.events.on('agent.status.changed', (payload) => {
    const eventRecord = {
      type: 'agent.status.changed',
      timestamp: new Date().toISOString(),
      member: payload.title || payload.terminalId || payload.paneKey || 'agent',
      state: payload.state,
      workspaceId: payload.workspaceId,
      paneKey: payload.paneKey,
      terminalId: payload.terminalId,
      title: payload.title,
      mainAgent: payload.mainAgent,
      receivedAt: payload.receivedAt || Date.now()
    };
    appendEvent(eventRecord);
  });
  disposables.push(eventSub);

  // 3. Register 'swarm-visualiser.open' command to run `orca tab create --url http://127.0.0.1:4319`
  const cmdSub = orca.commands.register('swarm-visualiser.open', async () => {
    await startServerIfNotRunning(port);

    let projectParam = '';
    try {
      if (orca.host.has('workspace.readContext')) {
        const ctx = (await orca.host.call('workspace.readContext', {})) as
          | { displayName?: string; branch?: string }
          | null
          | undefined;
        const label = ctx?.displayName || ctx?.branch;
        if (label) {
          projectParam = `?project=${encodeURIComponent(label)}`;
        }
      }
    } catch {
      // Optional context hint; ignore if host denies or omits it.
    }

    const url = `http://127.0.0.1:${port}${projectParam}`;
    const orcaBin = ['/usr/local/bin/orca', '/opt/homebrew/bin/orca'].find((p) => fs.existsSync(p)) || 'orca';

    return new Promise((resolve) => {
      execFile(
        orcaBin,
        ['tab', 'create', '--url', url],
        {
          env: {
            ...process.env,
            PATH: `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`
          }
        },
        (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            console.error('[orca-swarm-visualiser] Failed to create orca tab:', error);
            resolve({ ok: false, error: error.message, stderr });
          } else {
            resolve({ ok: true, stdout: stdout.trim() });
          }
        }
      );
    });
  });
  disposables.push(cmdSub);
}

/**
 * Plugin deactivation hook called by Orca when unloading or disabling the plugin.
 */
export async function deactivate(): Promise<void> {
  for (const d of disposables) {
    try {
      d.dispose();
    } catch {
      // Ignore disposal errors
    }
  }
  disposables = [];

  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch {
      // Ignore process termination errors
    }
    serverProcess = null;
  }
}

export { activate };
