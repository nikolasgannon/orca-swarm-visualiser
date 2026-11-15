import type { OrcaWorkerApi, Disposable, HostCallError } from 'orca/worker';
import type { HostParams } from 'orca/host';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4319;
const SWARM_DIR = path.join(os.homedir(), '.orca-swarm');
const EVENTS_FILE = path.join(SWARM_DIR, 'events.jsonl');
const BRIDGE_TOKEN_FILE = path.join(SWARM_DIR, 'bridge.token');
const WORKER_IPC_FILE = path.join(SWARM_DIR, 'worker-ipc.json');
const MAX_IPC_BODY_BYTES = 16 * 1024;
const MAX_FIELD_LEN = 2000;

type ResumeParams = HostParams<'agent.resume'>;
type ResumableAgent = ResumeParams['agent'];
type ListSessionsParams = Exclude<HostParams<'agent.listSessions'>, undefined>;

const RESUMABLE_AGENTS = new Set<ResumableAgent>([
  'claude',
  'codebuddy',
  'codex',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'gemini',
  'antigravity',
  'opencode',
  'opencode2',
  'pi',
  'mimo-code',
  'droid',
  'grok',
  'devin',
  'omp',
  'prime-agent',
  'copilot',
  'cursor',
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'kiro',
  'hermes'
]);

let serverProcess: ChildProcess | null = null;
let ipcServer: http.Server | null = null;
let disposables: Disposable[] = [];

/**
 * Ensures ~/.orca-swarm exists with strict 0700 owner-only permissions.
 */
function ensureSwarmDir(): void {
  if (!fs.existsSync(SWARM_DIR)) {
    fs.mkdirSync(SWARM_DIR, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(SWARM_DIR, 0o700); } catch {}
}

/**
 * Scrubs credentials, tokens, private keys, and email addresses from strings.
 */
function redactSensitiveText(str: string): string {
  if (!str) return '';
  return str
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1[redacted]@')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/((?:Authorization\s*:\s*Bearer|Bearer)\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-or-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:xai-|hf_|gsk_|npm_)[A-Za-z0-9_-]{12,})\b/g, '[redacted-token]')
    .replace(/((?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["']?)([^\s"',;]{8,})(["']?)/gi, '$1[redacted]$3');
}

/**
 * Strips prototype-pollution keys and scrubs sensitive fields recursively.
 */
function sanitizePayload<T>(val: T, depth = 0): T {
  if (depth > 6 || val === null || val === undefined) return val;
  if (typeof val === 'string') {
    const scrubbed = redactSensitiveText(val);
    return (scrubbed.length > MAX_FIELD_LEN ? `${scrubbed.slice(0, MAX_FIELD_LEN)}…` : scrubbed) as unknown as T;
  }
  if (Array.isArray(val)) {
    return val.slice(0, 100).map((item) => sanitizePayload(item, depth + 1)) as unknown as T;
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (/^(?:api[_-]?key|secret|token|password|passwd|authorization|private[_-]?key)$/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = sanitizePayload(v, depth + 1);
      }
    }
    return out as T;
  }
  return val;
}

/**
 * Appends a scrubbed event object as a JSON line to ~/.orca-swarm/events.jsonl.
 */
function appendEvent(eventData: Record<string, unknown>): void {
  try {
    ensureSwarmDir();
    const line = JSON.stringify(sanitizePayload(eventData)) + '\n';
    fs.appendFileSync(EVENTS_FILE, line, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(EVENTS_FILE, 0o600); } catch {}
  } catch (err) {
    console.error('[orca-swarm-visualiser] Failed to append event to events.jsonl:', err);
  }
}

/**
 * Reads the bridge auth token from ~/.orca-swarm/bridge.token if present.
 */
function readBridgeToken(): string | null {
  try {
    if (!fs.existsSync(BRIDGE_TOKEN_FILE)) return null;
    const token = fs.readFileSync(BRIDGE_TOKEN_FILE, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Delivers an event directly to the local bridge POST /events endpoint,
 * falling back to ~/.orca-swarm/events.jsonl if the bridge is unreachable or unauthenticated.
 */
function deliverEvent(port: number, eventData: Record<string, unknown>): Promise<void> {
  const cleanEvent = sanitizePayload(eventData);
  const token = readBridgeToken();
  if (!token) {
    appendEvent(cleanEvent);
    return Promise.resolve();
  }

  const body = JSON.stringify(cleanEvent);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/events',
        method: 'POST',
        timeout: 1500,
        headers: {
          Host: `127.0.0.1:${port}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
          'X-Orca-Swarm-Token': token
        }
      },
      (res) => {
        res.resume();
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          appendEvent(cleanEvent);
        }
        resolve();
      }
    );

    req.on('error', () => {
      appendEvent(cleanEvent);
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      appendEvent(cleanEvent);
      resolve();
    });

    req.write(body);
    req.end();
  });
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
        ORCA_SWARM_HOST: '127.0.0.1',
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

function sendIpcJson(res: http.ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function isAllowedLoopbackHost(rawHost: string | undefined, expectedPort: number): boolean {
  if (!rawHost || typeof rawHost !== 'string') return false;
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed || /[\s/@\\]/.test(trimmed)) return false;
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return false;
  const hostname = trimmed.slice(0, colonIdx);
  const portNum = Number(trimmed.slice(colonIdx + 1));
  return (hostname === '127.0.0.1' || hostname === 'localhost') && portNum === expectedPort;
}

function verifyIpcToken(req: http.IncomingMessage, expectedToken: string): boolean {
  const raw = req.headers['x-orca-worker-token'];
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const a = Buffer.from(raw.trim(), 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readIpcJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += buf.length;
      if (totalBytes > MAX_IPC_BODY_BYTES) {
        settled = true;
        req.pause();
        res.setHeader('Connection', 'close');
        sendIpcJson(res, 413, { ok: false, code: 'too_large', error: 'IPC payload exceeds 16 KB limit' });
        res.on('finish', () => {
          try { req.destroy(); } catch {}
        });
        resolve({ ok: false });
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({ ok: true, data: {} });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendIpcJson(res, 400, { ok: false, code: 'invalid_params', error: 'JSON object body required' });
          resolve({ ok: false });
          return;
        }
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          safe[k] = v;
        }
        resolve({ ok: true, data: safe });
      } catch {
        sendIpcJson(res, 400, { ok: false, code: 'invalid_request', error: 'Invalid JSON body' });
        resolve({ ok: false });
      }
    });

    req.on('error', () => {
      if (settled) return;
      settled = true;
      sendIpcJson(res, 400, { ok: false, code: 'invalid_request', error: 'Request stream error' });
      resolve({ ok: false });
    });
  });
}

function validateIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || trimmed.startsWith('-') || /[\0\r\n]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function mapHostErrorStatus(err: unknown): { status: number; code: string; message: string } {
  const hostErr = err as Partial<HostCallError> | null;
  const code = typeof hostErr?.code === 'string' ? hostErr.code : 'action_failed';
  const message = hostErr?.message || 'Orca host call failed';
  switch (code) {
    case 'invalid_request':
    case 'invalid_params':
      return { status: 400, code, message };
    case 'capability_denied':
    case 'consent_required':
    case 'not_permitted':
      return { status: 403, code, message };
    case 'unknown_method':
      return { status: 501, code, message };
    case 'rate_limited':
      return { status: 429, code, message };
    default:
      return { status: 502, code, message };
  }
}

function writeWorkerIpcFile(port: number, token: string, orca: OrcaWorkerApi): void {
  ensureSwarmDir();
  const payload = {
    port,
    token,
    pid: process.pid,
    apiMinor: orca.api.minor,
    capabilities: [...orca.grantedCapabilities],
    updatedAt: Date.now()
  };
  fs.writeFileSync(WORKER_IPC_FILE, JSON.stringify(payload, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600
  });
  try { fs.chmodSync(WORKER_IPC_FILE, 0o600); } catch {}
}

function removeOwnWorkerIpcFile(): void {
  try {
    if (!fs.existsSync(WORKER_IPC_FILE)) return;
    const raw = fs.readFileSync(WORKER_IPC_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (parsed && parsed.pid === process.pid) {
      fs.unlinkSync(WORKER_IPC_FILE);
    }
  } catch {
    try { fs.unlinkSync(WORKER_IPC_FILE); } catch {}
  }
}

/**
 * Starts a loopback-only authenticated HTTP IPC server so bridge/server.mjs can
 * invoke Host API 1.8/1.9 session methods without widening plugin write capabilities.
 */
function startWorkerIpc(orca: OrcaWorkerApi): Promise<void> {
  const ipcToken = crypto.randomBytes(32).toString('hex');
  let boundPort = 0;

  const server = http.createServer(async (req, res) => {
    if (!isAllowedLoopbackHost(req.headers.host, boundPort)) {
      sendIpcJson(res, 403, { ok: false, code: 'not_permitted', error: 'Host header blocked' });
      return;
    }

    if (req.headers.origin !== undefined) {
      sendIpcJson(res, 403, { ok: false, code: 'not_permitted', error: 'Browser origins are not permitted on worker IPC' });
      return;
    }

    const secFetchSite = typeof req.headers['sec-fetch-site'] === 'string'
      ? req.headers['sec-fetch-site'].trim().toLowerCase()
      : '';
    if (secFetchSite && secFetchSite !== 'none') {
      sendIpcJson(res, 403, { ok: false, code: 'not_permitted', error: 'Cross-site request blocked' });
      return;
    }

    if (!verifyIpcToken(req, ipcToken)) {
      sendIpcJson(res, 401, { ok: false, code: 'not_permitted', error: 'Missing or invalid X-Orca-Worker-Token' });
      return;
    }

    let pathname = '/';
    try {
      const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
      pathname = parsedUrl.pathname;
    } catch {
      sendIpcJson(res, 400, { ok: false, code: 'invalid_request', error: 'Invalid request URL' });
      return;
    }

    if (req.method === 'GET' && pathname === '/ipc/health') {
      sendIpcJson(res, 200, {
        ok: true,
        pid: process.pid,
        api: { major: orca.api.major, minor: orca.api.minor },
        methods: {
          readContext: orca.host.has('workspace.readContext'),
          listSessions: orca.host.has('agent.listSessions'),
          resume: orca.host.has('agent.resume')
        }
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/ipc/sessions/list') {
      if (!orca.host.has('agent.listSessions')) {
        sendIpcJson(res, 501, {
          ok: false,
          code: 'unknown_method',
          error: 'agent.listSessions is not available on this Orca version'
        });
        return;
      }

      const bodyRes = await readIpcJsonBody(req, res);
      if (!bodyRes.ok) return;

      const params: ListSessionsParams = {};
      if (bodyRes.data.workspaceId !== undefined && bodyRes.data.workspaceId !== null && bodyRes.data.workspaceId !== '') {
        const cleanWorkspaceId = validateIdentifier(bodyRes.data.workspaceId);
        if (!cleanWorkspaceId) {
          sendIpcJson(res, 400, { ok: false, code: 'invalid_params', error: 'Invalid workspaceId' });
          return;
        }
        params.workspaceId = cleanWorkspaceId;
      }

      if (bodyRes.data.limit !== undefined && bodyRes.data.limit !== null) {
        const limitNum = bodyRes.data.limit;
        if (typeof limitNum !== 'number' || !Number.isInteger(limitNum) || limitNum < 1 || limitNum > 200) {
          sendIpcJson(res, 400, { ok: false, code: 'invalid_params', error: 'limit must be an integer between 1 and 200' });
          return;
        }
        params.limit = limitNum;
      }

      try {
        const hasParams = Object.keys(params).length > 0;
        const result = await orca.host.call('agent.listSessions', hasParams ? params : undefined);
        sendIpcJson(res, 200, {
          ok: true,
          sessions: result.sessions,
          truncated: result.truncated
        });
      } catch (err) {
        const mapped = mapHostErrorStatus(err);
        sendIpcJson(res, mapped.status, { ok: false, code: mapped.code, error: mapped.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/ipc/sessions/resume') {
      if (!orca.host.has('agent.resume')) {
        sendIpcJson(res, 501, {
          ok: false,
          code: 'unknown_method',
          error: 'agent.resume is not available on this Orca version'
        });
        return;
      }

      const bodyRes = await readIpcJsonBody(req, res);
      if (!bodyRes.ok) return;

      const workspaceId = validateIdentifier(bodyRes.data.workspaceId);
      if (!workspaceId) {
        sendIpcJson(res, 400, { ok: false, code: 'invalid_params', error: 'Valid workspaceId is required' });
        return;
      }

      const sessionId = validateIdentifier(bodyRes.data.sessionId);
      if (!sessionId) {
        sendIpcJson(res, 400, { ok: false, code: 'invalid_params', error: 'Valid sessionId is required' });
        return;
      }

      const rawAgent = typeof bodyRes.data.agent === 'string' ? bodyRes.data.agent.trim() : '';
      if (!RESUMABLE_AGENTS.has(rawAgent as ResumableAgent)) {
        sendIpcJson(res, 400, { ok: false, code: 'invalid_params', error: 'Unsupported or invalid resumable agent' });
        return;
      }

      try {
        const result = await orca.host.call('agent.resume', {
          workspaceId,
          agent: rawAgent as ResumableAgent,
          sessionId
        });
        sendIpcJson(res, 200, {
          ok: true,
          terminalId: result.terminalId,
          started: result.started
        });
      } catch (err) {
        const mapped = mapHostErrorStatus(err);
        sendIpcJson(res, mapped.status, { ok: false, code: mapped.code, error: mapped.message });
      }
      return;
    }

    sendIpcJson(res, 404, { ok: false, code: 'unknown_method', error: 'Not found' });
  });

  ipcServer = server;

  return new Promise((resolve) => {
    server.on('error', (err) => {
      console.error('[orca-swarm-visualiser] Worker IPC server error:', err);
      resolve();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object' && addr.port) {
        boundPort = addr.port;
        try {
          writeWorkerIpcFile(boundPort, ipcToken, orca);
        } catch (err) {
          console.error('[orca-swarm-visualiser] Failed to write worker-ipc.json:', err);
        }
      }
      resolve();
    });
  });
}

/**
 * Plugin activation hook called by Orca.
 */
export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const parsedPort = parseInt(process.env.ORCA_SWARM_PORT || String(DEFAULT_PORT), 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT;

  // 1. Start bridge server in the background if not running, and open worker IPC
  await startServerIfNotRunning(port);
  await startWorkerIpc(orca);

  // 2. Forward agent.status.changed (including Host API 1.7-1.9 fields) to bridge / events.jsonl
  const agentStatusSub = orca.events.on('agent.status.changed', (payload) => {
    const eventRecord = {
      type: 'agent.status.changed',
      timestamp: new Date().toISOString(),
      member: payload.title || payload.terminalId || payload.paneKey || 'agent',
      state: payload.state,
      workspaceId: payload.workspaceId ?? null,
      workspaceListId: payload.workspaceListId ?? null,
      paneKey: payload.paneKey,
      terminalId: payload.terminalId ?? null,
      title: payload.title ?? null,
      sessionId: payload.sessionId ?? null,
      mainAgent: payload.mainAgent ?? null,
      outcome: payload.mainAgent?.outcome ?? null,
      receivedAt: payload.receivedAt || Date.now()
    };
    void deliverEvent(port, eventRecord);
  });
  disposables.push(agentStatusSub);

  // 3. Forward workspace lifecycle events so the bridge wakes immediately from idle backoff
  const wsCreatedSub = orca.events.on('workspace.created', (payload) => {
    void deliverEvent(port, {
      type: 'workspace.created',
      timestamp: new Date().toISOString(),
      workspaceId: payload.workspaceId,
      workspaceListId: payload.workspaceListId ?? null,
      kind: payload.kind,
      path: payload.path,
      branch: payload.branch
    });
  });
  disposables.push(wsCreatedSub);

  const wsRemovedSub = orca.events.on('workspace.removed', (payload) => {
    void deliverEvent(port, {
      type: 'workspace.removed',
      timestamp: new Date().toISOString(),
      workspaceId: payload.workspaceId,
      workspaceListId: payload.workspaceListId ?? null,
      kind: payload.kind,
      path: payload.path
    });
  });
  disposables.push(wsRemovedSub);

  const wsChangedSub = orca.events.on('workspace.changed', (payload) => {
    void deliverEvent(port, {
      type: 'workspace.changed',
      timestamp: new Date().toISOString(),
      context: payload.context ?? null
    });
  });
  disposables.push(wsChangedSub);

  // 4. Register 'swarm-visualiser.open' command to run `orca tab create --url http://127.0.0.1:4319`
  const cmdSub = orca.commands.register('swarm-visualiser.open', async () => {
    await startServerIfNotRunning(port);

    let projectParam = '';
    try {
      if (orca.host.has('workspace.readContext')) {
        const ctx = await orca.host.call('workspace.readContext', {});
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

  if (ipcServer) {
    const serverToClose = ipcServer;
    ipcServer = null;
    await new Promise<void>((resolve) => {
      try {
        serverToClose.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  removeOwnWorkerIpcFile();

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
