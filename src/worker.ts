import type { OrcaWorkerApi, Disposable, HostCallError, HostErrorCode, JsonValue } from 'orca/worker';
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
const MAX_RPC_INPUT_BYTES = 64 * 1024;
const MAX_RPC_RESPONSE_BYTES = 960 * 1024;
const MAX_SSE_POST_BYTES = 180 * 1024;
const POST_RATE_WINDOW_MS = 10_000;
const POST_RATE_SOFT_LIMIT = 150;
const STATUS_BURST_DEBOUNCE_MS = 120;
const ORCA_UPDATE_COALESCE_MS = 150;
const SSE_INITIAL_BACKOFF_MS = 500;
const SSE_MAX_BACKOFF_MS = 15_000;
const BRIDGE_RPC_TIMEOUT_MS = 25_000;
const MAX_FIELD_LEN = 2000;

const ALLOWED_GET_QUERY_PARAMS: Record<string, ReadonlySet<string>> = {
  '/api/health': new Set(),
  '/api/snapshot': new Set(['compact']),
  '/api/models': new Set(['refresh']),
  '/api/sessions': new Set(['workspaceId', 'limit', 'q']),
  '/api/presets': new Set(),
  '/api/files': new Set(['project']),
  '/api/members': new Set()
};

const ALLOWED_POST_PATHS = new Set<string>([
  '/api/dispatch-mentions',
  '/api/handoff',
  '/api/terminal/send',
  '/api/terminal/focus',
  '/api/sessions/resume',
  '/api/files/open-diff',
  '/api/open-diff',
  '/api/custom-agents',
  '/api/members',
  '/api/presets',
  '/events'
]);

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
let startServerPromise: Promise<void> | null = null;
let ipcServer: http.Server | null = null;
let disposables: Disposable[] = [];

// Resilient worker SSE subscriber state
let sseActive = false;
let sseReq: http.ClientRequest | null = null;
let sseRes: http.IncomingMessage | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sseBackoffMs = SSE_INITIAL_BACKOFF_MS;

// Rate-limiting & burst-throttling state for orca.panels.post (256 KiB / 200 per 10s cap)
let postTimestamps: number[] = [];
let pendingPingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPingSource = 'orca_update';
let pendingOrcaUpdateData: JsonValue | null = null;
let pendingOrcaUpdateTimer: ReturnType<typeof setTimeout> | null = null;
const pendingAgentStatusByKey = new Map<string, Record<string, unknown>>();
let pendingAgentStatusTimer: ReturnType<typeof setTimeout> | null = null;

// Status bar state tracker
const knownAgentStates = new Map<string, string>();
let lastStatusBarSignature = '';

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
 * Creates an Error carrying a host error code recognized by Orca's panel RPC bridge.
 */
function createHostError(code: HostErrorCode, message: string): HostCallError {
  const err = new Error(message) as HostCallError;
  err.code = code;
  err.retryable = code === 'rate_limited' || code === 'unavailable' || code === 'timeout';
  return err;
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
 * Strips prototype-pollution keys from arbitrary JSON objects without redacting/truncating user prompt bodies.
 */
function stripUnsafeKeys(val: unknown, depth = 0): unknown {
  if (depth > 16 || val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.map((item) => stripUnsafeKeys(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = stripUnsafeKeys(v, depth + 1);
  }
  return out;
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
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/health',
        timeout: 1000,
        headers: {
          Host: `127.0.0.1:${port}`
        }
      },
      (res: http.IncomingMessage) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      }
    );
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
 * Starts bridge/server.mjs in the background if it is not already running, coalescing concurrent callers.
 */
async function startServerIfNotRunning(port = DEFAULT_PORT, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;

  if (!startServerPromise) {
    startServerPromise = (async () => {
      try {
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
            if (signal?.aborted) break;
            await new Promise((r) => setTimeout(r, 200));
            if (await isServerRunning(port)) {
              break;
            }
          }
        } catch (err) {
          console.error('[orca-swarm-visualiser] Failed to spawn bridge server:', err);
        }
      } finally {
        startServerPromise = null;
      }
    })();
  }

  await startServerPromise;
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

type ValidatedBridgeRpc = {
  method: 'GET' | 'POST';
  pathname: string;
  targetPath: string;
  bodyStr: string | null;
};

/**
 * Validates `bridge.rpc` panel request parameters strictly, throwing `invalid_params` on any violation.
 */
export function validateBridgeRpcInput(input: unknown): ValidatedBridgeRpc {
  let serializedInput = '';
  try {
    serializedInput = JSON.stringify(input ?? null);
  } catch {
    throw createHostError('invalid_params', 'RPC input must be JSON serializable');
  }
  if (Buffer.byteLength(serializedInput, 'utf8') > MAX_RPC_INPUT_BYTES) {
    throw createHostError('invalid_params', 'RPC input exceeds 64 KiB limit');
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createHostError('invalid_params', 'RPC input must be a JSON object');
  }

  const record = input as Record<string, unknown>;
  const rawMethod = typeof record.method === 'string' ? record.method.trim().toUpperCase() : '';
  if (rawMethod !== 'GET' && rawMethod !== 'POST') {
    throw createHostError('invalid_params', `Unsupported HTTP method: ${rawMethod || '(empty)'}`);
  }

  const rawPath = typeof record.path === 'string' ? record.path.trim() : '';
  if (
    !rawPath ||
    rawPath.length > 2048 ||
    /[\x00-\x1f\x7f\\]/.test(rawPath) ||
    !rawPath.startsWith('/') ||
    rawPath.startsWith('//') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawPath) ||
    rawPath.includes('://') ||
    rawPath.includes('..')
  ) {
    throw createHostError('invalid_params', 'Invalid or disallowed bridge path');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawPath, 'http://127.0.0.1');
  } catch {
    throw createHostError('invalid_params', 'Malformed bridge path');
  }

  if (parsed.origin !== 'http://127.0.0.1' || parsed.username !== '' || parsed.password !== '') {
    throw createHostError('invalid_params', 'Protocol or host prefix is not permitted');
  }

  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    throw createHostError('invalid_params', 'Malformed path percent-encoding');
  }

  if (
    decodedPath !== parsed.pathname ||
    decodedPath.includes('..') ||
    decodedPath.includes('\\') ||
    decodedPath.includes('\0') ||
    decodedPath.includes('//')
  ) {
    throw createHostError('invalid_params', 'Path traversal or unsafe path characters are not permitted');
  }

  const pathname = parsed.pathname;

  if (rawMethod === 'GET') {
    const allowedQuery = ALLOWED_GET_QUERY_PARAMS[pathname];
    if (!allowedQuery) {
      throw createHostError('invalid_params', `GET path not allowlisted: ${pathname}`);
    }
    if (record.body !== undefined && record.body !== null) {
      throw createHostError('invalid_params', 'GET requests must not include a body');
    }

    const safeParams = new URLSearchParams();
    for (const [key, val] of parsed.searchParams.entries()) {
      if (!allowedQuery.has(key)) {
        throw createHostError('invalid_params', `Unsupported query parameter: ${key}`);
      }
      if (/[\x00-\x1f\x7f]/.test(val) || val.length > 512) {
        throw createHostError('invalid_params', `Invalid query parameter value for ${key}`);
      }
      if (key === 'limit') {
        const n = Number(val);
        if (!/^\d+$/.test(val) || !Number.isInteger(n) || n < 1 || n > 200) {
          throw createHostError('invalid_params', 'limit must be an integer between 1 and 200');
        }
      } else if (key === 'refresh' || key === 'compact') {
        if (val !== '0' && val !== '1' && val !== 'true' && val !== 'false') {
          throw createHostError('invalid_params', `${key} must be 0, 1, true, or false`);
        }
      } else if (key === 'workspaceId' || key === 'project') {
        if (val.includes('..') || val.includes('\\') || val.startsWith('-')) {
          throw createHostError('invalid_params', `Unsafe value for ${key}`);
        }
      }
      safeParams.append(key, val);
    }

    const qs = safeParams.toString();
    return {
      method: 'GET',
      pathname,
      targetPath: qs ? `${pathname}?${qs}` : pathname,
      bodyStr: null
    };
  }

  // POST
  if (!ALLOWED_POST_PATHS.has(pathname)) {
    throw createHostError('invalid_params', `POST path not allowlisted: ${pathname}`);
  }
  if (parsed.search) {
    throw createHostError('invalid_params', 'Query parameters are not permitted on POST bridge paths');
  }

  let bodyObj: unknown = {};
  if (record.body !== undefined && record.body !== null) {
    if (typeof record.body === 'string') {
      const trimmed = record.body.trim();
      if (trimmed) {
        try {
          bodyObj = JSON.parse(trimmed);
        } catch {
          throw createHostError('invalid_params', 'POST string body must be valid JSON');
        }
      }
    } else {
      bodyObj = record.body;
    }
  }

  if (!bodyObj || typeof bodyObj !== 'object' || Array.isArray(bodyObj)) {
    throw createHostError('invalid_params', 'POST body must be a JSON object');
  }

  const cleanBody = stripUnsafeKeys(bodyObj);
  return {
    method: 'POST',
    pathname,
    targetPath: pathname,
    bodyStr: JSON.stringify(cleanBody)
  };
}

type BridgeHttpResult = {
  ok: boolean;
  status: number;
  data: JsonValue;
};

function isUnreachableNetworkError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ENOTFOUND' || code === 'ETIMEDOUT';
}

function callBridgeHttp(
  port: number,
  method: 'GET' | 'POST',
  targetPath: string,
  bodyStr: string | null,
  signal?: AbortSignal
): Promise<BridgeHttpResult> {
  if (signal?.aborted) {
    return Promise.reject(createHostError('cancelled', 'Bridge RPC request cancelled'));
  }

  const token = readBridgeToken();
  const payloadStr = method === 'POST' ? (bodyStr ?? '{}') : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const headers: Record<string, string | number> = {
      Host: `127.0.0.1:${port}`,
      Accept: 'application/json'
    };
    if (token) {
      headers['X-Orca-Swarm-Token'] = token;
    }
    if (payloadStr !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payloadStr, 'utf8');
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: targetPath,
        method,
        timeout: BRIDGE_RPC_TIMEOUT_MS,
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
          totalBytes += buf.length;
          if (totalBytes > MAX_RPC_RESPONSE_BYTES) {
            settled = true;
            cleanup();
            req.destroy();
            reject(createHostError('too_large', 'Bridge response exceeds 1 MiB panel RPC envelope'));
            return;
          }
          chunks.push(buf);
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          cleanup();
          const status = res.statusCode ?? 502;
          const raw = Buffer.concat(chunks).toString('utf8').trim();
          let data: JsonValue = null;
          if (raw) {
            try {
              data = JSON.parse(raw) as JsonValue;
            } catch {
              data = { raw };
            }
          }
          resolve({
            ok: status >= 200 && status < 300,
            status,
            data
          });
        });

        res.on('error', (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        });
      }
    );

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(createHostError('cancelled', 'Bridge RPC request aborted'));
    };

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(createHostError('timeout', 'Bridge request timed out'));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    if (payloadStr !== null) {
      req.write(payloadStr);
    }
    req.end();
  });
}

function resolveOrcaBin(): string {
  if (process.env.ORCA_BIN && fs.existsSync(process.env.ORCA_BIN)) {
    return process.env.ORCA_BIN;
  }
  return ['/usr/local/bin/orca', '/opt/homebrew/bin/orca'].find((p) => fs.existsSync(p)) || 'orca';
}

function runOrcaCli(
  args: string[],
  signal?: AbortSignal
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string; parsed?: Record<string, unknown> | null }> {
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, stdout: '', stderr: '', error: 'Cancelled' });
  }

  const orcaBin = resolveOrcaBin();
  return new Promise((resolve) => {
    execFile(
      orcaBin,
      args,
      {
        timeout: 8000,
        signal,
        env: {
          ...process.env,
          PATH: `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`
        }
      },
      (error: Error | null, stdout: string, stderr: string) => {
        const trimmedOut = (stdout || '').trim();
        const trimmedErr = (stderr || '').trim();
        let parsed: Record<string, unknown> | null = null;
        if (trimmedOut.startsWith('{')) {
          try {
            parsed = JSON.parse(trimmedOut) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
        }
        if (error) {
          resolve({
            ok: false,
            stdout: trimmedOut,
            stderr: trimmedErr,
            error: error.message,
            parsed
          });
          return;
        }
        resolve({
          ok: parsed ? parsed.ok !== false : true,
          stdout: trimmedOut,
          stderr: trimmedErr,
          parsed
        });
      }
    );
  });
}

async function resolveSwarmPluginKeys(signal?: AbortSignal): Promise<string[]> {
  const candidates: string[] = [];
  try {
    const listRes = await runOrcaCli(['plugin', 'list', '--json'], signal);
    const resultObj = (listRes.parsed?.result || listRes.parsed?.data || null) as { plugins?: unknown } | null;
    const rawPlugins = Array.isArray(resultObj?.plugins) ? resultObj.plugins : [];

    const matching = rawPlugins.filter((item): item is { pluginKey: string; status?: string; isDev?: boolean } => {
      if (!item || typeof item !== 'object') return false;
      const pk = (item as { pluginKey?: unknown }).pluginKey;
      return typeof pk === 'string' && (pk === 'nikolasgannon.swarm-visualiser' || pk === 'local.swarm-visualiser' || pk.endsWith('.swarm-visualiser'));
    });

    // Prefer active/running/idle plugin first, favoring publisher-qualified then local dev
    matching.sort((a, b) => {
      const aActive = a.status === 'running' || a.status === 'idle' ? 0 : 1;
      const bActive = b.status === 'running' || b.status === 'idle' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const aScore = a.pluginKey === 'nikolasgannon.swarm-visualiser' ? 0 : (a.isDev || a.pluginKey === 'local.swarm-visualiser' ? 1 : 2);
      const bScore = b.pluginKey === 'nikolasgannon.swarm-visualiser' ? 0 : (b.isDev || b.pluginKey === 'local.swarm-visualiser' ? 1 : 2);
      return aScore - bScore;
    });

    for (const m of matching) {
      if (!candidates.includes(m.pluginKey)) {
        candidates.push(m.pluginKey);
      }
    }
  } catch {
    // Fall back to standard keys below
  }

  for (const fallback of ['nikolasgannon.swarm-visualiser', 'local.swarm-visualiser']) {
    if (!candidates.includes(fallback)) {
      candidates.push(fallback);
    }
  }
  return candidates;
}

async function openSidebarPanel(
  signal?: AbortSignal
): Promise<{ ok: true; mode: 'panel'; pluginKey: string; stdout: string } | { ok: false; reason: string; error: string }> {
  const keys = await resolveSwarmPluginKeys(signal);
  let lastError = 'Panel open failed';
  let lastReason = 'unknown';

  for (const pluginKey of keys) {
    if (signal?.aborted) {
      return { ok: false, reason: 'cancelled', error: 'Cancelled' };
    }
    const res = await runOrcaCli(['plugin', 'open', pluginKey, '--panel', 'swarm', '--json'], signal);
    if (res.ok) {
      return { ok: true, mode: 'panel', pluginKey, stdout: res.stdout };
    }

    const parsedErr = typeof res.parsed?.error === 'string'
      ? res.parsed.error
      : (typeof (res.parsed?.error as { code?: unknown } | undefined)?.code === 'string'
        ? String((res.parsed?.error as { code?: unknown }).code)
        : '');
    const combined = `${parsedErr} ${res.stderr} ${res.stdout} ${res.error || ''}`.trim();
    lastError = combined || lastError;

    if (/no_workspace/i.test(combined)) {
      lastReason = 'no_workspace';
      break;
    }
  }

  return { ok: false, reason: lastReason, error: lastError };
}

async function openBrowserTab(
  orca: OrcaWorkerApi,
  port: number,
  signal?: AbortSignal
): Promise<{ ok: boolean; mode: 'tab'; url: string; stdout?: string; error?: string; stderr?: string }> {
  await startServerIfNotRunning(port, signal);

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
  const res = await runOrcaCli(['tab', 'create', '--url', url], signal);
  if (res.ok) {
    return { ok: true, mode: 'tab', url, stdout: res.stdout };
  }
  console.error('[orca-swarm-visualiser] Failed to create orca tab:', res.error || res.stderr);
  return { ok: false, mode: 'tab', url, error: res.error || 'Failed to create tab', stderr: res.stderr };
}

function normalizeAgentStateCategory(rawState: unknown): 'working' | 'blocked' | 'idle' {
  const s = String(rawState || '').toLowerCase();
  if (s === 'working' || s === 'running' || s === 'active') return 'working';
  if (s === 'blocked' || s === 'permission' || s === 'error' || s === 'failed') return 'blocked';
  return 'idle';
}

function syncStatusBarFromKnownStates(orca: OrcaWorkerApi): void {
  if (!orca.host.has('statusBar.update')) return;

  let workingCount = 0;
  let blockedCount = 0;
  for (const state of knownAgentStates.values()) {
    const cat = normalizeAgentStateCategory(state);
    if (cat === 'working') workingCount++;
    else if (cat === 'blocked') blockedCount++;
  }

  let text = 'Swarm';
  let tone: 'accent' | 'success' | 'warning' = 'accent';
  if (blockedCount > 0 && workingCount > 0) {
    text = `Swarm · ${workingCount} active`;
    tone = 'warning';
  } else if (blockedCount > 0) {
    text = `Swarm · ${blockedCount} blocked`;
    tone = 'warning';
  } else if (workingCount > 0) {
    text = `Swarm · ${workingCount} active`;
    tone = 'success';
  }

  const tooltip = workingCount > 0 || blockedCount > 0
    ? `Swarm Visualiser (${workingCount} active, ${blockedCount} blocked)`
    : 'Open Swarm Visualiser';

  const sig = `${text}|${tone}|${tooltip}`;
  if (sig === lastStatusBarSignature) return;
  lastStatusBarSignature = sig;

  void orca.host.call('statusBar.update', {
    id: 'swarm-open',
    text,
    icon: 'activity',
    tone,
    tooltip
  }).catch(() => {});
}

function updateKnownStatesFromSnapshotOrUpdate(orca: OrcaWorkerApi, data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const obj = data as Record<string, unknown>;
  let touched = false;

  if (Array.isArray(obj.orcaProjects) || Array.isArray(obj.terminals) || Array.isArray(obj.members)) {
    knownAgentStates.clear();
    touched = true;
  }

  if (Array.isArray(obj.orcaProjects)) {
    for (const proj of obj.orcaProjects) {
      if (!proj || typeof proj !== 'object') continue;
      const projMembers = (proj as { members?: unknown }).members;
      if (!Array.isArray(projMembers)) continue;
      for (const m of projMembers) {
        if (!m || typeof m !== 'object') continue;
        const rec = m as Record<string, unknown>;
        const key = String(rec.terminalId || rec.terminalHandle || rec.paneKey || rec.id || '');
        const state = rec.status || rec.liveState || '';
        if (key && state) {
          knownAgentStates.set(key, String(state));
        }
      }
    }
  }

  if (Array.isArray(obj.terminals)) {
    for (const t of obj.terminals) {
      if (!t || typeof t !== 'object') continue;
      const rec = t as Record<string, unknown>;
      const key = String(rec.id || rec.terminalId || rec.recordedPaneKey || '');
      const state = rec.status || rec.state || '';
      if (key && state && !knownAgentStates.has(key)) {
        knownAgentStates.set(key, String(state));
      }
    }
  }

  if (Array.isArray(obj.members)) {
    for (const m of obj.members) {
      if (!m || typeof m !== 'object') continue;
      const rec = m as Record<string, unknown>;
      const key = String(rec.terminalHandle || rec.id || '');
      const state = rec.status || rec.liveState || '';
      if (key && state && !knownAgentStates.has(key)) {
        knownAgentStates.set(key, String(state));
      }
    }
  }

  if (touched) {
    syncStatusBarFromKnownStates(orca);
  }
}

function updateKnownStateFromStatusEvent(orca: OrcaWorkerApi, payload: Record<string, unknown>): void {
  const key = String(payload.terminalId || payload.paneKey || payload.id || payload.member || '');
  const state = payload.state || payload.status || (payload.mainAgent as { state?: unknown } | undefined)?.state || '';
  if (key && state) {
    knownAgentStates.set(key, String(state));
    syncStatusBarFromKnownStates(orca);
  }
}

function prunePostTimestamps(now: number): void {
  const cutoff = now - POST_RATE_WINDOW_MS;
  while (postTimestamps.length > 0 && postTimestamps[0] < cutoff) {
    postTimestamps.shift();
  }
}

function postPanelSseRaw(orca: OrcaWorkerApi, event: string, data: JsonValue): void {
  try {
    orca.panels.post('swarm.sse', { event, data });
    postTimestamps.push(Date.now());
  } catch {
    // Ignore post errors if no panels are open or host is shutting down
  }
}

function scheduleUpdatePing(orca: OrcaWorkerApi, sourceEvent: string): void {
  pendingPingSource = sourceEvent;
  if (pendingPingTimer) return;

  const now = Date.now();
  prunePostTimestamps(now);
  const delayMs = postTimestamps.length >= POST_RATE_SOFT_LIMIT ? 500 : 80;

  pendingPingTimer = setTimeout(() => {
    pendingPingTimer = null;
    if (!sseActive) return;
    const nowCheck = Date.now();
    prunePostTimestamps(nowCheck);
    if (postTimestamps.length >= POST_RATE_SOFT_LIMIT) {
      scheduleUpdatePing(orca, pendingPingSource);
      return;
    }
    postPanelSseRaw(orca, 'orca_update_ping', { refresh: true, sourceEvent: pendingPingSource });
  }, delayMs);
}

function emitPanelSse(orca: OrcaWorkerApi, event: string, data: JsonValue): void {
  if (!sseActive) return;

  const now = Date.now();
  prunePostTimestamps(now);
  if (postTimestamps.length >= POST_RATE_SOFT_LIMIT) {
    scheduleUpdatePing(orca, event);
    return;
  }

  const envelope = { event, data };
  let byteLen = 0;
  try {
    byteLen = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  } catch {
    scheduleUpdatePing(orca, event);
    return;
  }

  if (byteLen > MAX_SSE_POST_BYTES) {
    postPanelSseRaw(orca, 'orca_update_ping', { refresh: true, sourceEvent: event });
    return;
  }

  postPanelSseRaw(orca, event, data);
}

function handleBridgeSseEvent(orca: OrcaWorkerApi, eventName: string, data: JsonValue): void {
  const cleanEvent = eventName || 'message';

  if (cleanEvent === 'snapshot' || cleanEvent === 'orca_update') {
    updateKnownStatesFromSnapshotOrUpdate(orca, data);
  } else if (cleanEvent === 'agent.status.changed' && data && typeof data === 'object' && !Array.isArray(data)) {
    updateKnownStateFromStatusEvent(orca, data as Record<string, unknown>);
  }

  if (cleanEvent === 'orca_update') {
    pendingOrcaUpdateData = data;
    if (!pendingOrcaUpdateTimer) {
      pendingOrcaUpdateTimer = setTimeout(() => {
        pendingOrcaUpdateTimer = null;
        const latest = pendingOrcaUpdateData;
        pendingOrcaUpdateData = null;
        if (!sseActive || latest === null) return;
        emitPanelSse(orca, 'orca_update', latest);
      }, ORCA_UPDATE_COALESCE_MS);
    }
    return;
  }

  if (cleanEvent === 'agent.status.changed' && data && typeof data === 'object' && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    const key = String(rec.terminalId || rec.paneKey || rec.id || rec.member || 'agent');
    pendingAgentStatusByKey.set(key, rec);
    if (!pendingAgentStatusTimer) {
      pendingAgentStatusTimer = setTimeout(() => {
        pendingAgentStatusTimer = null;
        if (!sseActive) {
          pendingAgentStatusByKey.clear();
          return;
        }
        const batch = Array.from(pendingAgentStatusByKey.values());
        pendingAgentStatusByKey.clear();
        if (batch.length > 15) {
          scheduleUpdatePing(orca, 'agent.status.changed');
          return;
        }
        for (const item of batch) {
          emitPanelSse(orca, 'agent.status.changed', item as JsonValue);
        }
      }, STATUS_BURST_DEBOUNCE_MS);
    }
    return;
  }

  emitPanelSse(orca, cleanEvent, data);
}

function stopBridgeSseClient(): void {
  sseActive = false;

  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (pendingPingTimer) {
    clearTimeout(pendingPingTimer);
    pendingPingTimer = null;
  }
  if (pendingOrcaUpdateTimer) {
    clearTimeout(pendingOrcaUpdateTimer);
    pendingOrcaUpdateTimer = null;
  }
  pendingOrcaUpdateData = null;
  if (pendingAgentStatusTimer) {
    clearTimeout(pendingAgentStatusTimer);
    pendingAgentStatusTimer = null;
  }
  pendingAgentStatusByKey.clear();
  postTimestamps = [];

  if (sseRes) {
    try { sseRes.destroy(); } catch {}
    sseRes = null;
  }
  if (sseReq) {
    try { sseReq.destroy(); } catch {}
    sseReq = null;
  }
}

function startBridgeSseClient(orca: OrcaWorkerApi, port: number): void {
  stopBridgeSseClient();
  sseActive = true;
  sseBackoffMs = SSE_INITIAL_BACKOFF_MS;

  const scheduleReconnect = () => {
    if (!sseActive || sseReconnectTimer) return;
    const waitMs = sseBackoffMs;
    sseBackoffMs = Math.min(SSE_MAX_BACKOFF_MS, Math.round(sseBackoffMs * 2));
    sseReconnectTimer = setTimeout(async () => {
      sseReconnectTimer = null;
      if (!sseActive) return;
      await startServerIfNotRunning(port);
      if (sseActive) {
        connect();
      }
    }, waitMs);
  };

  const connect = () => {
    if (!sseActive) return;
    if (sseReq) {
      try { sseReq.destroy(); } catch {}
      sseReq = null;
    }
    if (sseRes) {
      try { sseRes.destroy(); } catch {}
      sseRes = null;
    }

    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/events',
        headers: {
          Host: `127.0.0.1:${port}`,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache'
        }
      },
      (res) => {
        if (!sseActive) {
          res.destroy();
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          scheduleReconnect();
          return;
        }

        sseRes = res;
        sseBackoffMs = SSE_INITIAL_BACKOFF_MS;
        res.setEncoding('utf8');

        let buffer = '';
        let currentEvent = 'message';
        let dataLines: string[] = [];

        const flushFrame = () => {
          if (dataLines.length === 0) {
            currentEvent = 'message';
            return;
          }
          const rawData = dataLines.join('\n');
          const eventName = currentEvent || 'message';
          currentEvent = 'message';
          dataLines = [];

          let parsed: JsonValue = rawData;
          try {
            parsed = JSON.parse(rawData) as JsonValue;
          } catch {
            parsed = rawData;
          }
          handleBridgeSseEvent(orca, eventName, parsed);
        };

        res.on('data', (chunk: string) => {
          if (!sseActive) return;
          buffer += chunk;
          let newlineIdx = buffer.indexOf('\n');
          while (newlineIdx !== -1) {
            let line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            if (line.endsWith('\r')) {
              line = line.slice(0, -1);
            }
            if (line === '') {
              flushFrame();
            } else if (!line.startsWith(':')) {
              const colonIdx = line.indexOf(':');
              const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
              let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
              if (value.startsWith(' ')) value = value.slice(1);
              if (field === 'event') {
                currentEvent = value.trim() || 'message';
              } else if (field === 'data') {
                dataLines.push(value);
              }
            }
            newlineIdx = buffer.indexOf('\n');
          }
        });

        res.on('end', () => {
          sseRes = null;
          if (sseActive) {
            scheduleReconnect();
          }
        });

        res.on('error', () => {
          sseRes = null;
          if (sseActive) {
            scheduleReconnect();
          }
        });
      }
    );

    sseReq = req;
    req.on('error', () => {
      if (sseReq === req) sseReq = null;
      if (sseActive) {
        scheduleReconnect();
      }
    });
  };

  connect();
}

/**
 * Plugin activation hook called by Orca.
 */
export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const parsedPort = parseInt(process.env.ORCA_SWARM_PORT || String(DEFAULT_PORT), 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT;

  // 1. Start bridge server in the background if not running, open worker IPC, and start SSE relay
  await startServerIfNotRunning(port);
  await startWorkerIpc(orca);
  startBridgeSseClient(orca, port);
  syncStatusBarFromKnownStates(orca);

  // 2. Register panel RPC handlers (`bridge.rpc` and `swarm.openTab`)
  const bridgeRpcSub = orca.panels.handle('bridge.rpc', async (input, ctx) => {
    const validated = validateBridgeRpcInput(input);

    const execRpc = async (targetPath: string) => {
      try {
        return await callBridgeHttp(port, validated.method, targetPath, validated.bodyStr, ctx?.signal);
      } catch (err) {
        if (ctx?.signal?.aborted) {
          throw createHostError('cancelled', 'Bridge RPC request aborted');
        }
        if (isUnreachableNetworkError(err)) {
          await startServerIfNotRunning(port, ctx?.signal);
          try {
            return await callBridgeHttp(port, validated.method, targetPath, validated.bodyStr, ctx?.signal);
          } catch (retryErr) {
            if (isUnreachableNetworkError(retryErr)) {
              throw createHostError('unavailable', 'Swarm bridge server is unreachable');
            }
            throw retryErr;
          }
        }
        throw err;
      }
    };

    try {
      return await execRpc(validated.targetPath);
    } catch (err) {
      const code = (err as Partial<HostCallError> | null)?.code;
      if (code === 'too_large' && validated.method === 'GET' && validated.pathname === '/api/snapshot' && validated.targetPath !== '/api/snapshot?compact=1') {
        return await execRpc('/api/snapshot?compact=1');
      }
      throw err;
    }
  });
  disposables.push(bridgeRpcSub);

  const openTabPanelSub = orca.panels.handle('swarm.openTab', async (_input, ctx) => {
    return await openBrowserTab(orca, port, ctx?.signal);
  });
  disposables.push(openTabPanelSub);

  // 3. Forward agent.status.changed (including Host API 1.7-1.9 fields) to bridge / events.jsonl and update status bar
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
    updateKnownStateFromStatusEvent(orca, eventRecord);
    void deliverEvent(port, eventRecord);
  });
  disposables.push(agentStatusSub);

  // 4. Forward workspace lifecycle events so the bridge wakes immediately from idle backoff
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

  // 5. Register 'swarm-visualiser.open' (prefers far-right sidebar panel, falls back to browser tab)
  const cmdOpenSub = orca.commands.register('swarm-visualiser.open', async (_args, ctx) => {
    await startServerIfNotRunning(port, ctx?.signal);
    const panelRes = await openSidebarPanel(ctx?.signal);
    if (panelRes.ok) {
      return panelRes;
    }
    return await openBrowserTab(orca, port, ctx?.signal);
  });
  disposables.push(cmdOpenSub);

  // 6. Register 'swarm-visualiser.openTab' (opens full-window browser tab directly)
  const cmdOpenTabSub = orca.commands.register('swarm-visualiser.openTab', async (_args, ctx) => {
    return await openBrowserTab(orca, port, ctx?.signal);
  });
  disposables.push(cmdOpenTabSub);
}

/**
 * Plugin deactivation hook called by Orca when unloading or disabling the plugin.
 */
export async function deactivate(): Promise<void> {
  stopBridgeSseClient();
  knownAgentStates.clear();
  lastStatusBarSignature = '';
  startServerPromise = null;

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
