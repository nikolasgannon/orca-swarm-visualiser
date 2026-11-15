import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';
import os from 'os';
import { execFile } from 'child_process';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const rawPort = parseInt(process.env.ORCA_SWARM_PORT || '4319', 10);
export const PORT = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 4319;
export const HOST = process.env.ORCA_SWARM_HOST || '127.0.0.1';
export const PUBLIC_DIR = path.resolve(__dirname, 'public');
export const PUBLIC_REAL_DIR = fs.existsSync(PUBLIC_DIR) ? fs.realpathSync(PUBLIC_DIR) : PUBLIC_DIR;
export const ORCA_SWARM_DIR = path.join(os.homedir(), '.orca-swarm');
export const EVENTS_FILE = path.join(ORCA_SWARM_DIR, 'events.jsonl');
export const PRESETS_FILE = path.join(ORCA_SWARM_DIR, 'presets.json');
export const TOKEN_FILE = path.join(ORCA_SWARM_DIR, 'bridge.token');
export const BRIDGE_TOKEN = (process.env.ORCA_SWARM_TOKEN && process.env.ORCA_SWARM_TOKEN.trim())
  || crypto.randomBytes(32).toString('hex');
let activePort = PORT;

const MAX_POSTS = 500;
const MAX_ACTIVITIES = 500;
const MAX_MEMBERS = 200;
const MAX_SSE_CLIENTS = 64;

function ensureSwarmStorage({ writeToken = false } = {}) {
  try {
    if (!fs.existsSync(ORCA_SWARM_DIR)) {
      fs.mkdirSync(ORCA_SWARM_DIR, { recursive: true, mode: 0o700 });
    }
    try { fs.chmodSync(ORCA_SWARM_DIR, 0o700); } catch {}
    if (!fs.existsSync(EVENTS_FILE)) {
      fs.writeFileSync(EVENTS_FILE, '', { encoding: 'utf8', mode: 0o600 });
    } else {
      try { fs.chmodSync(EVENTS_FILE, 0o600); } catch {}
    }
    if (fs.existsSync(PRESETS_FILE)) {
      try { fs.chmodSync(PRESETS_FILE, 0o600); } catch {}
    }
    if (writeToken) {
      fs.writeFileSync(TOKEN_FILE, BRIDGE_TOKEN + '\n', { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
    }
  } catch (err) {
    console.warn('[swarm-server] Warning preparing ~/.orca-swarm directory:', err.message);
  }
}

// Ensure ~/.orca-swarm exists with strict user-only permissions
ensureSwarmStorage({ writeToken: false });

// Universal Agent Type Detection
export function detectAgentType(input) {
  if (!input) return 'terminal';
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  const lower = str.toLowerCase();

  // Tool / harness CLIs have precedence over model flags
  if (/\b(opencode)\b/.test(lower)) return 'opencode';
  if (/\b(aider)\b/.test(lower)) return 'aider';
  if (/\b(cursor)\b/.test(lower)) return 'cursor';
  if (/\b(cline)\b/.test(lower)) return 'cline';
  if (/\b(roo|roo-cline|roo-code)\b/.test(lower)) return 'roo';
  if (/\b(agy|antigravity)\b/.test(lower)) return 'agy';
  if (/\b(claude|anthropic|claude-code)\b/.test(lower)) return 'claude';
  if (/\b(codex)\b/.test(lower)) return 'codex';
  if (/\b(gemini)\b/.test(lower)) return 'gemini';
  if (/\b(deepseek)\b/.test(lower)) return 'deepseek';
  return 'terminal';
}

export const AGENT_TYPE_META = {
  claude: { role: 'Claude Assistant', model: 'claude-sonnet-4-6', avatarBg: '#6366f1', icon: 'shield', scope: 'High capability reasoning and verification' },
  codex: { role: 'Codex Engineer', model: 'codex', avatarBg: '#10b981', icon: 'cpu', scope: 'Local implementation and execution worker' },
  gemini: { role: 'Gemini Agent', model: 'gemini-3.8-flash', avatarBg: '#3b82f6', icon: 'crown', scope: 'Interactive orchestration and multi-modal tasks' },
  agy: { role: 'Antigravity Supervisor', model: 'gemini-3.8-flash-high', avatarBg: '#8b5cf6', icon: 'sparkles', scope: 'Antigravity workspace and tools coordinator' },
  deepseek: { role: 'DeepSeek Specialist', model: 'deepseek-v4.1', avatarBg: '#0ea5e9', icon: 'bot', scope: 'Autonomous coding and algorithmic analysis' },
  opencode: { role: 'OpenCode Worker', model: 'deepseek-v4.1-flash', avatarBg: '#f59e0b', icon: 'git', scope: 'Autonomous bounded implementation worker' },
  aider: { role: 'Aider Pair Programmer', model: 'aider', avatarBg: '#14b8a6', icon: 'terminal', scope: 'Git-integrated terminal pair programmer' },
  cursor: { role: 'Cursor Agent', model: 'cursor-ide', avatarBg: '#ec4899', icon: 'search', scope: 'IDE workspace navigation and inline generation' },
  cline: { role: 'Cline Autonomous Dev', model: 'cline-agent', avatarBg: '#f97316', icon: 'users', scope: 'Browser and terminal automation developer' },
  roo: { role: 'Roo Code Assistant', model: 'roo-code', avatarBg: '#e11d48', icon: 'radar', scope: 'Multi-mode autonomous terminal and coding' },
  terminal: { role: 'Terminal Shell', model: 'zsh/bash', avatarBg: '#64748b', icon: 'terminal', scope: 'Local terminal process' }
};

const BUILTIN_AGENT_PRESETS = [
  { key: 'builtin:architect', id: '@architect', name: 'Architect', role: 'Architecture & Design Planner', model: 'claude-sonnet-4-6', avatarBg: '#2563eb', icon: 'cpu', scope: 'Design system boundaries, API contracts, and migration plans', tags: ['@design', '@plan'], brief: 'Review repository structure and propose the implementation plan before edits begin.', source: 'Built-in Template', category: 'builtin' },
  { key: 'builtin:coder', id: '@coder', name: 'Coder', role: 'Implementation Engineer', model: 'deepseek-v4.1-flash', avatarBg: '#d97706', icon: 'terminal', scope: 'Write focused code changes inside assigned workspace scope', tags: ['@dev', '@build'], brief: 'Implement the approved changes in the target files and report diffs and checks run.', source: 'Built-in Template', category: 'builtin' },
  { key: 'builtin:verifier', id: '@verifier', name: 'Verifier', role: 'QA & Test Verifier', model: 'codex', avatarBg: '#059669', icon: 'shield', scope: 'Run tests, linters, typechecks, and browser verification', tags: ['@qa', '@test'], brief: 'Verify all modified flows end-to-end and report exact pass or failure evidence.', source: 'Built-in Template', category: 'builtin' },
  { key: 'builtin:security', id: '@security', name: 'Security', role: 'Security Reviewer', model: 'claude-sonnet-4-6', avatarBg: '#dc2626', icon: 'radar', scope: 'Audit auth, secret handling, input validation, and sandboxes', tags: ['@sec', '@audit'], brief: 'Audit changed files for secret leaks, injection vectors, and boundary bypasses.', source: 'Built-in Template', category: 'builtin' },
  { key: 'builtin:researcher', id: '@researcher', name: 'Researcher', role: 'Codebase Researcher', model: 'gemini-3.8-flash', avatarBg: '#7c3aed', icon: 'search', scope: 'Map dependencies, existing helpers, and documentation', tags: ['@docs', '@search'], brief: 'Inspect related modules and summarise conventions before editing.', source: 'Built-in Template', category: 'builtin' }
];

function stripQuotes(val) {
  const s = String(val || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function normalizeHandle(rawId, fallback = 'agent') {
  const clean = String(rawId || fallback).trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `@${clean || fallback}`;
}

function normalisePresetRecord(raw, defaults = {}) {
  const baseId = raw.id || raw.handle || raw.name || defaults.id || 'agent';
  const id = normalizeHandle(baseId);
  const model = stripQuotes(raw.model || defaults.model || '');
  const detected = detectAgentType(`${model} ${defaults.providerHint || ''} ${id} ${raw.role || ''} ${raw.description || ''}`);
  const meta = AGENT_TYPE_META[detected] || AGENT_TYPE_META.terminal;
  const desc = redactSensitiveText(stripQuotes(raw.description || raw.scope || ''));
  const role = redactSensitiveText(stripQuotes(raw.role || '') || (raw.name ? stripQuotes(raw.name) : '') || meta.role);
  const rawTags = Array.isArray(raw.tags)
    ? raw.tags
    : (typeof raw.tags === 'string' ? raw.tags.split(',').map(s => s.trim()).filter(Boolean) : (defaults.tags || []));
  const tags = rawTags.map(t => (t.startsWith('@') ? t : `@${t}`));

  return {
    key: raw.key || `${defaults.category || 'saved'}:${defaults.source || 'local'}:${id.slice(1)}`,
    id,
    name: redactSensitiveText(stripQuotes(raw.name || id.slice(1))),
    role,
    model: model || meta.model,
    avatarBg: /^#[0-9a-fA-F]{6}$/.test(raw.avatarBg || raw.color || '') ? (raw.avatarBg || raw.color) : meta.avatarBg,
    icon: stripQuotes(raw.icon || '') || meta.icon,
    scope: desc || meta.scope,
    tags,
    brief: redactSensitiveText(stripQuotes(raw.brief || raw.initialBrief || '') || (desc ? `${desc}` : '')),
    source: raw.source || defaults.source || 'Saved Preset',
    category: raw.category || defaults.category || 'saved'
  };
}

function parseMarkdownAgentProfile(filePath, rawContent, sourceLabel, providerHint) {
  const content = String(rawContent || '');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = {};
  let body = content;

  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) {
        const k = m[1].toLowerCase();
        const v = stripQuotes(m[2]);
        if (v) fields[k] = v;
      }
    }
  }

  const fileSlug = path.basename(filePath, path.extname(filePath));
  const headingMatch = body.match(/^#\s+(.+)$/m);
  const cleanBody = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  const firstPara = cleanBody
    .split(/\r?\n\r?\n/)
    .map(p => p.replace(/^#+\s*/gm, '').trim())
    .find(p => p && !p.startsWith('```'));

  const name = fields.name || (headingMatch ? headingMatch[1].trim() : fileSlug);
  const description = fields.description || fields.summary || (firstPara ? firstPara.slice(0, 160).replace(/\s+/g, ' ') : '');
  const modeTag = fields.mode ? `@${fields.mode}` : '';
  const cliTag = providerHint ? `@${providerHint}` : '';
  const tags = fields.tags
    ? fields.tags
    : [cliTag, modeTag].filter(Boolean);

  return normalisePresetRecord(
    {
      id: fields.handle || fields.name || fileSlug,
      name,
      role: fields.role || (fields.mode ? `${name} (${fields.mode})` : name),
      description,
      model: fields.model,
      color: fields.color,
      icon: fields.icon,
      tags,
      brief: description
    },
    { category: 'cli', source: sourceLabel, providerHint }
  );
}

function scanPresetDirectory(dirPath, sourceLabel, providerHint) {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.') && e.name.toLowerCase() !== 'readme.md')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(resolved, entry.name);
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        results.push(parseMarkdownAgentProfile(fullPath, raw, sourceLabel, providerHint));
      } catch {
        // Ignore unreadable markdown file
      }
    }
  } catch {
    // Ignore unreadable directory
  }
  return results;
}

function loadSavedPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.presets) ? raw.presets : []);
    return list
      .filter(item => item && (item.id || item.handle || item.name))
      .map(item => normalisePresetRecord(item, { category: 'saved', source: 'Saved (~/.orca-swarm/presets.json)' }));
  } catch {
    return [];
  }
}

function saveUserPreset(rawPreset) {
  const preset = normalisePresetRecord(rawPreset, { category: 'saved', source: 'Saved (~/.orca-swarm/presets.json)' });
  const existing = loadSavedPresets().filter(p => p.id !== preset.id);
  const next = [preset, ...existing];
  ensureSwarmStorage({ writeToken: false });
  fs.writeFileSync(PRESETS_FILE, JSON.stringify({ presets: next }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(PRESETS_FILE, 0o600); } catch {}
  return preset;
}

export function discoverAgentPresets(cwd = process.cwd()) {
  const presets = [...loadSavedPresets()];
  const scannedDirs = new Set();

  const tryScan = (dirPath, label, hint) => {
    const resolved = path.resolve(dirPath);
    if (scannedDirs.has(resolved)) return;
    scannedDirs.add(resolved);
    presets.push(...scanPresetDirectory(resolved, label, hint));
  };

  const home = os.homedir();
  tryScan(path.join(cwd, '.claude', 'agents'), 'Project (.claude/agents)', 'claude');
  tryScan(path.join(cwd, '.opencode', 'agent'), 'Project (.opencode/agent)', 'opencode');
  tryScan(path.join(cwd, '.codex', 'agents'), 'Project (.codex/agents)', 'codex');

  for (const proj of orcaProjects) {
    for (const wt of proj.worktrees || []) {
      if (wt.isMain && wt.path) {
        tryScan(path.join(wt.path, '.claude', 'agents'), `${proj.name} (.claude/agents)`, 'claude');
        tryScan(path.join(wt.path, '.opencode', 'agent'), `${proj.name} (.opencode/agent)`, 'opencode');
      }
    }
  }

  tryScan(path.join(home, '.claude', 'agents'), 'Claude CLI (~/.claude/agents)', 'claude');
  tryScan(path.join(home, '.config', 'opencode', 'agent'), 'OpenCode CLI (~/.config/opencode/agent)', 'opencode');
  tryScan(path.join(home, '.opencode', 'agent'), 'OpenCode (~/.opencode/agent)', 'opencode');
  tryScan(path.join(home, '.codex', 'agents'), 'Codex CLI (~/.codex/agents)', 'codex');
  tryScan(path.join(home, '.agents', 'agents'), 'Shared (~/.agents/agents)', 'terminal');

  presets.push(...BUILTIN_AGENT_PRESETS);
  return presets;
}

export function getPresets(cwd = process.cwd()) {
  return discoverAgentPresets(cwd);
}

// Live Model & Provider Quota Discovery (cached 30s)
const MODEL_DISCOVERY_TTL_MS = 30000;
const GENERIC_MODEL_TOKENS = new Set([
  'webhook-root',
  'orca-ade',
  'zsh/bash',
  'agent',
  'custom',
  'terminal',
  'claude',
  'codex',
  'opencode',
  'gemini',
  'agy',
  'deepseek',
  'aider',
  'cursor',
  'cline',
  'roo',
  'cursor-ide',
  'cline-agent',
  'roo-code',
  'devin'
]);

let cachedModelDiscovery = null;
let cachedModelDiscoveryAt = 0;
let inFlightModelDiscovery = null;

function redactSensitiveText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1[redacted]@')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/((?:Authorization\s*:\s*Bearer|Bearer)\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-or-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:xai-|hf_|gsk_|npm_)[A-Za-z0-9_-]{12,})\b/g, '[redacted-token]')
    .replace(/((?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["']?)([^\s"',;]{8,})(["']?)/gi, '$1[redacted]$3')
    .trim();
}

function sanitizeNonPiiText(str) {
  return redactSensitiveText(str);
}

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function stripUnsafeKeys(val, depth = 0) {
  if (depth > 8 || val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(v => stripUnsafeKeys(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (UNSAFE_OBJECT_KEYS.has(k)) continue;
    out[k] = stripUnsafeKeys(v, depth + 1);
  }
  return out;
}

function redactEventPayload(val, depth = 0) {
  if (depth > 6 || val === null || val === undefined) return val;
  if (typeof val === 'string') return redactSensitiveText(val);
  if (Array.isArray(val)) return val.slice(0, 100).map(v => redactEventPayload(v, depth + 1));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (UNSAFE_OBJECT_KEYS.has(k)) continue;
      out[k] = redactEventPayload(v, depth + 1);
    }
    return out;
  }
  return val;
}

function computeLeftPct(bucket) {
  if (!bucket || typeof bucket.usedPercent !== 'number' || Number.isNaN(bucket.usedPercent)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(100 - bucket.usedPercent)));
}

function formatQuotaText(info) {
  if (!info) return 'Unavailable';
  if (info.rateLimited) return 'Rate limited';
  const parts = [];
  if (typeof info.sessionLeftPct === 'number') parts.push(`${info.sessionLeftPct}% session`);
  if (typeof info.weeklyLeftPct === 'number') parts.push(`${info.weeklyLeftPct}% weekly`);
  if (parts.length > 0) return parts.join(' · ');
  if (info.status === 'ok') return 'Available';
  if (info.error) return truncateText(info.error, 72);
  return 'Unavailable';
}

function extractProviderQuotaSummary(rl) {
  if (!rl || typeof rl !== 'object') {
    return {
      status: 'unavailable',
      rateLimited: false,
      sessionLeftPct: null,
      weeklyLeftPct: null,
      error: null,
      quotaText: 'Unavailable'
    };
  }
  const sessionLeftPct = computeLeftPct(rl.session);
  const weeklyLeftPct = computeLeftPct(rl.weekly);
  const cleanError = rl.error ? sanitizeNonPiiText(String(rl.error)) : null;
  const rateLimited = Boolean(
    rl.usageMetadata?.failureKind === 'rate-limited' ||
    /rate.?limit/i.test(cleanError || '') ||
    sessionLeftPct === 0 ||
    weeklyLeftPct === 0
  );
  const summary = {
    status: String(rl.status || (rateLimited ? 'error' : 'unavailable')),
    rateLimited,
    sessionLeftPct,
    weeklyLeftPct,
    error: cleanError || null
  };
  summary.quotaText = formatQuotaText(summary);
  return summary;
}

async function fetchProviderQuotas() {
  const providers = {
    claude: extractProviderQuotaSummary(null),
    codex: extractProviderQuotaSummary(null),
    opencode: extractProviderQuotaSummary(null),
    gemini: extractProviderQuotaSummary(null),
    devin: extractProviderQuotaSummary(null),
    antigravity: { ...extractProviderQuotaSummary(null), buckets: [] }
  };

  try {
    const res = await execJson(orcaBin, ['account', 'list', '--json'], { timeout: 4000 });
    const data = unwrapOrcaResult(res);
    if (!data || typeof data !== 'object' || res?.ok === false) {
      return providers;
    }

    const rateLimits = data.rateLimits && typeof data.rateLimits === 'object' ? data.rateLimits : {};
    providers.claude = extractProviderQuotaSummary(rateLimits.claude);
    providers.codex = extractProviderQuotaSummary(rateLimits.codex);
    providers.opencode = extractProviderQuotaSummary(rateLimits.opencodeGo || rateLimits.opencode);
    providers.gemini = extractProviderQuotaSummary(rateLimits.gemini);
    providers.devin = extractProviderQuotaSummary(rateLimits.devin);

    if (rateLimits.devin === undefined && data.devin && typeof data.devin === 'object') {
      const hasAccounts = Array.isArray(data.devin.accounts) && data.devin.accounts.length > 0;
      providers.devin = {
        status: hasAccounts || data.devin.activeAccountId ? 'ok' : 'unavailable',
        rateLimited: false,
        sessionLeftPct: null,
        weeklyLeftPct: null,
        error: null,
        quotaText: hasAccounts || data.devin.activeAccountId ? 'Configured' : 'Unavailable'
      };
    }

    const agSummary = extractProviderQuotaSummary(rateLimits.antigravity);
    const agBuckets = Array.isArray(rateLimits.antigravity?.buckets)
      ? rateLimits.antigravity.buckets.map(b => ({
          name: sanitizeNonPiiText(String(b?.name || '')),
          group: sanitizeNonPiiText(String(b?.group || '')),
          windowName: sanitizeNonPiiText(String(b?.windowName || '')),
          leftPct: computeLeftPct(b)
        }))
      : [];
    providers.antigravity = { ...agSummary, buckets: agBuckets };

    // Orca reports Gemini CLI OAuth as "disabled in settings" when users run Gemini via Antigravity or API key.
    if (providers.gemini.status !== 'ok' && !providers.gemini.rateLimited) {
      const geminiBuckets = agBuckets.filter(b => /gemini/i.test(`${b.group} ${b.name}`));
      const fiveHourBucket = geminiBuckets.find(b => /(five hour|5\s*h|session)/i.test(b.name));
      const weeklyBucket = geminiBuckets.find(b => /weekly/i.test(b.name));
      if (agSummary.status === 'ok' && geminiBuckets.length > 0) {
        const sessionLeftPct = fiveHourBucket?.leftPct ?? null;
        const weeklyLeftPct = weeklyBucket?.leftPct ?? null;
        const isLimited = sessionLeftPct === 0 || weeklyLeftPct === 0;
        const nextGemini = {
          status: 'ok',
          rateLimited: isLimited,
          sessionLeftPct,
          weeklyLeftPct,
          error: null
        };
        nextGemini.quotaText = formatQuotaText(nextGemini);
        providers.gemini = nextGemini;
      } else if (/oauth is disabled in settings/i.test(providers.gemini.error || '')) {
        const geminiSettings = readJsonFileSafe(path.join(os.homedir(), '.gemini', 'settings.json'));
        const hasLocalGemini = Boolean(geminiSettings || process.env.GEMINI_API_KEY);
        if (hasLocalGemini) {
          providers.gemini = {
            status: 'ok',
            rateLimited: false,
            sessionLeftPct: null,
            weeklyLeftPct: null,
            error: null,
            quotaText: 'Ready (OAuth tracker off)'
          };
        }
      }
    }
  } catch {
    // Fail-safe: leave defaults
  }

  return providers;
}

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readClaudeModels() {
  const home = os.homedir();
  const settings = readJsonFileSafe(path.join(home, '.claude', 'settings.json'));
  const configuredDefault = typeof settings?.model === 'string' ? settings.model.trim() : '';

  const catalogDir = path.join(home, '.claude', 'cache', 'model-catalog');
  const results = [];

  try {
    if (fs.existsSync(catalogDir)) {
      const entries = fs.readdirSync(catalogDir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.json'))
        .map(e => {
          const full = path.join(catalogDir, e.name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(full).mtimeMs;
          } catch {}
          return { name: e.name, full, isCc: e.name.endsWith('-cc.json'), mtimeMs };
        })
        .sort((a, b) => (b.isCc ? 1 : 0) - (a.isCc ? 1 : 0) || b.mtimeMs - a.mtimeMs);

      for (const file of entries) {
        const parsed = readJsonFileSafe(file.full);
        const rawModels = parsed?.catalog?.config?.models || parsed?.catalog?.models || parsed?.config?.models;
        if (Array.isArray(rawModels) && rawModels.length > 0) {
          for (const m of rawModels) {
            if (!m || typeof m.id !== 'string' || !m.id.trim()) continue;
            const id = m.id.trim();
            const family = String(m.runtime?.family || m.short_name || '').toLowerCase();
            const isDefault = Boolean(
              configuredDefault &&
              (id.toLowerCase() === configuredDefault.toLowerCase() ||
                (family && family === configuredDefault.toLowerCase()))
            );
            results.push({
              id,
              label: String(m.name || id).trim(),
              description: String(m.description || '').trim(),
              agent: 'claude',
              source: 'claude-catalog',
              isDefault
            });
          }
          break;
        }
      }
    }
  } catch {
    // Ignore unreadable catalog directory
  }

  if (configuredDefault && !results.some(m => m.isDefault || m.id.toLowerCase() === configuredDefault.toLowerCase())) {
    results.push({
      id: configuredDefault,
      label: configuredDefault,
      description: 'Configured default in ~/.claude/settings.json',
      agent: 'claude',
      source: 'claude-settings',
      isDefault: true
    });
  }

  if (results.length === 0) {
    for (const alias of ['opus', 'sonnet', 'haiku']) {
      results.push({
        id: alias,
        label: alias[0].toUpperCase() + alias.slice(1),
        description: `Claude ${alias} alias`,
        agent: 'claude',
        source: 'claude-fallback',
        isDefault: configuredDefault ? alias === configuredDefault.toLowerCase() : alias === 'sonnet'
      });
    }
  }

  return results;
}

function readCodexModels() {
  const home = os.homedir();
  let configuredDefault = '';
  try {
    const tomlPath = path.join(home, '.codex', 'config.toml');
    if (fs.existsSync(tomlPath)) {
      const tomlRaw = fs.readFileSync(tomlPath, 'utf8');
      const m = tomlRaw.match(/^\s*model\s*=\s*["']([^"'\r\n]+)["']/m);
      if (m) configuredDefault = m[1].trim();
    }
  } catch {
    // Ignore unreadable config.toml
  }

  const cache = readJsonFileSafe(path.join(home, '.codex', 'models_cache.json'));
  const results = [];
  if (Array.isArray(cache?.models)) {
    for (const m of cache.models) {
      if (!m || typeof m.slug !== 'string' || !m.slug.trim()) continue;
      if (m.visibility === 'hide') continue;
      const id = m.slug.trim();
      results.push({
        id,
        label: String(m.display_name || id).trim(),
        description: String(m.description || '').trim(),
        agent: 'codex',
        source: 'codex-cache',
        isDefault: Boolean(configuredDefault && id.toLowerCase() === configuredDefault.toLowerCase())
      });
    }
  }

  if (configuredDefault && !results.some(m => m.id.toLowerCase() === configuredDefault.toLowerCase())) {
    results.push({
      id: configuredDefault,
      label: configuredDefault,
      description: 'Configured default in ~/.codex/config.toml',
      agent: 'codex',
      source: 'codex-config',
      isDefault: true
    });
  }

  return results;
}

async function resolveOpencodeBin() {
  if (process.env.OPENCODE_BIN && process.env.OPENCODE_BIN.trim()) {
    return process.env.OPENCODE_BIN.trim();
  }
  const whichRes = await execFileAsync('which', ['opencode'], { timeout: 1500 });
  const found = whichRes.stdout.trim().split(/\r?\n/)[0]?.trim();
  if (!whichRes.error && found) return found;

  const fallback = path.join(os.homedir(), '.opencode', 'bin', 'opencode');
  if (fs.existsSync(fallback)) return fallback;
  return 'opencode';
}

async function readOpencodeModels() {
  const home = os.homedir();
  const cfg =
    readJsonFileSafe(path.join(home, '.config', 'opencode', 'opencode.json')) ||
    readJsonFileSafe(path.join(home, '.opencode', 'opencode.json'));
  const configuredDefault = typeof cfg?.model === 'string' ? cfg.model.trim() : '';

  const bin = await resolveOpencodeBin();
  const res = await execFileAsync(bin, ['models'], { timeout: 4000 });
  if (res.error && !res.stdout) return [];

  const results = [];
  const seen = new Set();
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /\s/.test(line) || !line.includes('/')) continue;
    if (!/^[a-z0-9._:/-]+$/i.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    results.push({
      id: line,
      label: line,
      description: '',
      agent: 'opencode',
      source: 'opencode-cli',
      isDefault: Boolean(configuredDefault && line.toLowerCase() === configuredDefault.toLowerCase())
    });
  }

  if (configuredDefault && !seen.has(configuredDefault) && /^[a-z0-9._:/-]+$/i.test(configuredDefault)) {
    results.push({
      id: configuredDefault,
      label: configuredDefault,
      description: 'Configured OpenCode default',
      agent: 'opencode',
      source: 'opencode-config',
      isDefault: true
    });
  }

  return results;
}

function readGeminiModels() {
  const home = os.homedir();
  const settings = readJsonFileSafe(path.join(home, '.gemini', 'settings.json'));
  const rawModel = typeof settings?.model === 'string'
    ? settings.model.trim()
    : (typeof settings?.model?.name === 'string' ? settings.model.name.trim() : '');

  const defaults = ['gemini-2.5-pro', 'gemini-2.5-flash'];
  const results = defaults.map(id => ({
    id,
    label: id,
    description: '',
    agent: 'gemini',
    source: 'gemini-default',
    isDefault: Boolean(rawModel && id.toLowerCase() === rawModel.toLowerCase())
  }));

  if (rawModel && /^[a-z0-9._:/-]+$/i.test(rawModel) && !results.some(m => m.id.toLowerCase() === rawModel.toLowerCase())) {
    results.unshift({
      id: rawModel,
      label: rawModel,
      description: 'Configured in ~/.gemini/settings.json',
      agent: 'gemini',
      source: 'gemini-settings',
      isDefault: true
    });
  }

  return results;
}

function collectKnownBranchNames() {
  const branches = new Set();
  for (const w of [...worktrees, ...processes]) {
    if (w?.branch) {
      branches.add(String(w.branch).replace(/^refs\/heads\//, '').trim().toLowerCase());
    }
    if (w?.displayName) {
      branches.add(String(w.displayName).trim().toLowerCase());
    }
  }
  for (const proj of orcaProjects) {
    for (const m of proj.members || []) {
      if (m.branch) branches.add(String(m.branch).trim().toLowerCase());
    }
  }
  return branches;
}

function isRealModelId(modelStr, knownBranches = new Set()) {
  if (!modelStr || typeof modelStr !== 'string') return false;
  const clean = modelStr.trim();
  if (!clean || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(clean)) return false;
  const lower = clean.toLowerCase();
  if (GENERIC_MODEL_TOKENS.has(lower)) return false;
  if (knownBranches.has(lower)) return false;
  return true;
}

function inferModelAgent(modelId) {
  const lower = String(modelId || '').toLowerCase();
  if (lower.includes('/')) return 'opencode';
  if (/\b(gpt|o1|o3|o4|codex)\b/.test(lower)) return 'codex';
  if (/\b(gemini)\b/.test(lower)) return 'gemini';
  if (/\b(claude|opus|sonnet|haiku|fable)\b/.test(lower)) return 'claude';
  const detected = detectAgentType(lower);
  if (detected === 'claude' || detected === 'codex' || detected === 'opencode' || detected === 'gemini') {
    return detected;
  }
  if (detected === 'deepseek') return 'opencode';
  if (detected === 'agy') return 'gemini';
  return 'claude';
}

export async function discoverAvailableModels({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cachedModelDiscovery && now - cachedModelDiscoveryAt < MODEL_DISCOVERY_TTL_MS) {
    return cachedModelDiscovery;
  }
  if (!refresh && inFlightModelDiscovery) {
    return inFlightModelDiscovery;
  }

  const run = (async () => {
    const [providers, opencodeModels] = await Promise.all([
      fetchProviderQuotas(),
      readOpencodeModels()
    ]);

    if (opencodeModels.length > 0 && providers.opencode.status === 'unavailable') {
      providers.opencode = {
        ...providers.opencode,
        status: 'ok',
        rateLimited: false,
        error: null,
        quotaText: `${opencodeModels.length} CLI models`
      };
    }

    const claudeModels = readClaudeModels();
    const codexModels = readCodexModels();
    const geminiModels = readGeminiModels();

    const knownBranches = collectKnownBranchNames();
    const modelMap = new Map();

    const addModel = entry => {
      if (!entry || !entry.id) return;
      const key = `${entry.agent}:${entry.id.toLowerCase()}`;
      const prov = providers[entry.agent] || providers.claude;
      if (modelMap.has(key)) {
        const existing = modelMap.get(key);
        if (entry.isDefault) existing.isDefault = true;
        return;
      }
      modelMap.set(key, {
        id: entry.id,
        label: entry.label || entry.id,
        description: entry.description || '',
        agent: entry.agent,
        source: entry.source || 'local',
        isDefault: Boolean(entry.isDefault),
        quotaText: prov?.quotaText || 'Unavailable',
        rateLimited: Boolean(prov?.rateLimited)
      });
    };

    for (const m of claudeModels) addModel(m);
    for (const m of codexModels) addModel(m);
    for (const m of opencodeModels) addModel(m);
    for (const m of geminiModels) addModel(m);

    for (const preset of getPresets()) {
      if (!isRealModelId(preset?.model, knownBranches)) continue;
      const agent = inferModelAgent(preset.model);
      addModel({
        id: preset.model.trim(),
        label: preset.model.trim(),
        description: preset.role || '',
        agent,
        source: 'preset',
        isDefault: false
      });
    }

    for (const proj of orcaProjects) {
      for (const mem of proj.members || []) {
        if (mem.role === 'Worktree' || mem.role === 'Main Worktree' || mem.role === 'Orca Project') continue;
        if (Array.isArray(mem.tags) && mem.tags.includes('@worktree')) continue;
        if (!isRealModelId(mem.model, knownBranches)) continue;
        const agent = inferModelAgent(mem.model);
        addModel({
          id: mem.model.trim(),
          label: mem.model.trim(),
          description: '',
          agent,
          source: 'orca-live',
          isDefault: false
        });
      }
    }

    const models = [...modelMap.values()];
    const byAgent = {
      claude: models.filter(m => m.agent === 'claude'),
      codex: models.filter(m => m.agent === 'codex'),
      opencode: models.filter(m => m.agent === 'opencode'),
      gemini: models.filter(m => m.agent === 'gemini'),
      all: models
    };

    const result = {
      ok: true,
      refreshedAt: new Date().toISOString(),
      providers,
      models,
      byAgent
    };

    cachedModelDiscovery = result;
    cachedModelDiscoveryAt = Date.now();
    return result;
  })();

  inFlightModelDiscovery = run;
  try {
    return await run;
  } finally {
    if (inFlightModelDiscovery === run) {
      inFlightModelDiscovery = null;
    }
  }
}

// MIME Types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// Swarm State (Webhook / Custom Feed + Live Orca Projects)
const startTime = Date.now();
let swarmTitle = 'Swarm Visualiser';
let activeClients = new Set();
const seenEventSignatures = new Set();

const members = [
  { id: '@coordinator', role: 'Coordinator', model: 'webhook-root', avatarBg: '#18181b', icon: 'crown', scope: 'Receives POST /events and ~/.orca-swarm/events.jsonl feeds', tags: [], joinedAtPost: 0, retiredAtPost: null }
];

const posts = [];
const activities = [];

let worktrees = [];
let terminals = [];
let processes = [];
let orcaProjects = [];
let activeOrcaProjectId = null;
let activeOrcaWorktreeId = null;
let activeWorktreePath = null;
let activeBranch = null;
let orcaStatus = {
  available: false,
  code: 'uninitialised',
  message: 'Connecting to Orca runtime',
  lastChecked: null
};

function formatTime(d = new Date()) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function extractMentions(text) {
  if (!text || typeof text !== 'string') return ['@all'];
  const matches = text.match(/@[a-zA-Z0-9_-]+/g);
  return matches && matches.length ? [...new Set(matches)] : ['@all'];
}

function registerOrUpdateMember(m) {
  if (!m || typeof m !== 'object') return null;
  const rawId = String(m.id || m.handle || '').trim();
  if (!rawId) return null;
  const id = normalizeHandle(rawId);
  const existingIdx = members.findIndex(mem => mem.id === id);

  const detected = detectAgentType(m.model || m.role || id);
  const meta = AGENT_TYPE_META[detected] || AGENT_TYPE_META.terminal;

  const memberObj = {
    id,
    role: redactSensitiveText(String(m.role || meta.role)).slice(0, 120) || meta.role,
    model: String(m.model || meta.model).trim().slice(0, 120) || meta.model,
    avatarBg: /^#[0-9a-fA-F]{6}$/.test(String(m.avatarBg || m.color || '')) ? (m.avatarBg || m.color) : meta.avatarBg,
    icon: /^[a-z0-9_-]+$/i.test(String(m.icon || '')) ? String(m.icon) : meta.icon,
    scope: redactSensitiveText(String(m.scope || m.duty || meta.scope)).slice(0, 400) || meta.scope,
    tags: Array.isArray(m.tags) ? m.tags.slice(0, 12).map(t => normalizeHandle(t, 'tag')) : (typeof m.tags === 'string' ? m.tags.split(',').map(s => s.trim()).filter(Boolean).slice(0, 12).map(t => normalizeHandle(t, 'tag')) : []),
    joinedAtPost: Number.isFinite(Number(m.joinedAtPost)) ? Number(m.joinedAtPost) : posts.length,
    retiredAtPost: m.retiredAtPost ?? null
  };

  if (existingIdx >= 0) {
    members[existingIdx] = { ...members[existingIdx], ...memberObj };
  } else {
    if (members.length >= MAX_MEMBERS) {
      const idxToDrop = members.findIndex(mem => mem.id !== '@coordinator');
      if (idxToDrop >= 0) members.splice(idxToDrop, 1);
    }
    members.push(memberObj);
  }

  broadcast('member', memberObj);
  broadcast('members_updated', members);
  return memberObj;
}

function getSnapshot() {
  return {
    type: 'snapshot',
    title: swarmTitle,
    startTime,
    members,
    posts,
    activities,
    worktrees,
    terminals,
    processes,
    orcaProjects,
    activeOrcaProjectId,
    activeOrcaWorktreeId,
    activeWorktreePath,
    activeBranch,
    orcaStatus,
    timestamp: Date.now()
  };
}

// Broadcast SSE event to all connected clients
export function broadcast(eventType, data) {
  const safeEventType = String(eventType || 'message').replace(/[\r\n\0]+/g, '').slice(0, 64) || 'message';
  const payload = typeof data === 'string' ? data.replace(/[\r\n\0]+/g, ' ') : JSON.stringify(data);
  const msg = `event: ${safeEventType}\ndata: ${payload}\n\n`;
  for (const client of activeClients) {
    try {
      client.write(msg);
    } catch {
      activeClients.delete(client);
    }
  }
}

// Append event to ~/.orca-swarm/events.jsonl and track signature
function appendToEventLog(eventObj) {
  try {
    const cleanObj = redactEventPayload(eventObj);
    const raw = JSON.stringify(cleanObj);
    const sig = `${cleanObj.type || 'evt'}:${cleanObj.id || ''}:${cleanObj.time || ''}:${String(cleanObj.text || '').slice(0, 40)}`;
    seenEventSignatures.add(sig);
    if (seenEventSignatures.size > 5000) {
      const first = seenEventSignatures.values().next().value;
      seenEventSignatures.delete(first);
    }
    fs.appendFileSync(EVENTS_FILE, raw + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[swarm-server] Error writing to events.jsonl:', err.message);
  }
}

// Ingest incoming parsed event
function ingestEvent(event, fromTailing = false) {
  if (!event || typeof event !== 'object') return null;
  const safeEvent = redactEventPayload(event);

  const type = safeEvent.type || safeEvent.event || (safeEvent.text ? 'post' : 'unknown');

  if (type === 'post' || (!type && safeEvent.text && safeEvent.from)) {
    const from = safeEvent.from || '@coordinator';
    const text = safeEvent.text || '';
    const to = Array.isArray(safeEvent.to) && safeEvent.to.length
      ? safeEvent.to
      : (safeEvent.to ? [safeEvent.to] : extractMentions(text));

    const post = {
      num: safeEvent.num || (posts.length + 1),
      sec: safeEvent.sec ?? Math.max(0, Math.round((Date.now() - startTime) / 1000)),
      time: safeEvent.time || formatTime(new Date()),
      offset: safeEvent.offset || `+${Math.max(0, Math.round((Date.now() - startTime) / 1000))}s`,
      from,
      to,
      text
    };

    posts.push(post);
    if (posts.length > MAX_POSTS) posts.shift();
    broadcast('post', post);
    return post;
  }

  if (type === 'activity' || safeEvent.activity) {
    const act = (typeof safeEvent.activity === 'object' && safeEvent.activity !== null) ? safeEvent.activity : safeEvent;
    const actId = act.id || `act-${activities.length + 1}`;
    const rawAgent = act.agentId || act.member || act.from || '@coordinator';
    const agentId = rawAgent.startsWith('@') ? rawAgent : `@${rawAgent}`;
    const cmdStr = (typeof act.activity === 'string' && act.activity) ? act.activity : (act.cmd || act.command || '');
    const isRunning = act.status === 'running' || safeEvent.hook === 'PreToolUse';
    const activity = {
      id: actId,
      agentId,
      tool: act.tool || 'tool',
      cmd: cmdStr,
      status: act.status || (isRunning ? 'running' : 'ok'),
      durationSec: act.durationSec ?? (act.duration ? Math.round(act.duration) : (isRunning ? 0 : 1)),
      postNum: act.postNum || posts.length,
      startedAt: act.startedAt || Date.now()
    };

    const idx = activities.findIndex(a => a.id === actId);
    if (idx >= 0) {
      activities[idx] = { ...activities[idx], ...activity };
    } else {
      activities.push(activity);
      if (activities.length > MAX_ACTIVITIES) activities.shift();
    }
    broadcast('activity', activity);
    return activity;
  }

  if (type === 'PreToolUse') {
    const actId = safeEvent.id || `act-pre-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const cmdStr = typeof safeEvent.input === 'string'
      ? safeEvent.input
      : (safeEvent.input?.CommandLine || safeEvent.input?.command || JSON.stringify(safeEvent.input || ''));

    const activity = {
      id: actId,
      agentId: safeEvent.agentId || safeEvent.from || '@coder',
      tool: safeEvent.tool || 'tool',
      cmd: cmdStr,
      status: 'running',
      durationSec: 0,
      postNum: posts.length,
      startedAt: Date.now()
    };
    activities.push(activity);
    if (activities.length > MAX_ACTIVITIES) activities.shift();
    broadcast('activity', activity);
    return activity;
  }

  if (type === 'PostToolUse') {
    const runningAct = activities.slice().reverse().find(a =>
      a.agentId === (safeEvent.agentId || safeEvent.from || '@coder') && a.status === 'running'
    );
    if (runningAct) {
      runningAct.status = safeEvent.status || 'ok';
      runningAct.durationSec = Math.max(1, Math.round((Date.now() - runningAct.startedAt) / 1000));
      broadcast('activity', runningAct);
      return runningAct;
    }
  }

  if (type === 'member' || safeEvent.member) {
    return registerOrUpdateMember(safeEvent.member || safeEvent);
  }

  if (type === 'agent.status.changed') {
    const memberId = safeEvent.agent || safeEvent.id;
    if (memberId) {
      const mem = members.find(m => m.id === memberId || m.id === `@${memberId.replace(/^@/, '')}`);
      if (mem && safeEvent.status) {
        mem.status = safeEvent.status;
        broadcast('agent.status.changed', { id: mem.id, status: safeEvent.status });
      }
    }
  }

  if (type === 'title' && typeof safeEvent.title === 'string') {
    const cleanTitle = safeEvent.title.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 120);
    if (cleanTitle) {
      swarmTitle = cleanTitle;
      broadcast('title', { title: swarmTitle });
    }
  }

  // Generic fallback broadcast
  broadcast(type, safeEvent);
  return safeEvent;
}

// Tail ~/.orca-swarm/events.jsonl for external event feeds
let tailOffset = 0;
function initTailer() {
  try {
    if (fs.existsSync(EVENTS_FILE)) {
      const stat = fs.statSync(EVENTS_FILE);
      tailOffset = stat.size;
    }
  } catch (err) {
    tailOffset = 0;
  }

  setInterval(() => {
    try {
      if (!fs.existsSync(EVENTS_FILE)) return;
      const stat = fs.statSync(EVENTS_FILE);
      if (stat.size < tailOffset) {
        // File was truncated or reset
        tailOffset = 0;
      }
      if (stat.size > tailOffset) {
        const stream = fs.createReadStream(EVENTS_FILE, {
          start: tailOffset,
          end: stat.size - 1,
          encoding: 'utf8'
        });
        tailOffset = stat.size;

        let accumulated = '';
        stream.on('data', chunk => {
          accumulated += chunk;
          const lines = accumulated.split('\n');
          accumulated = lines.pop(); // keep partial line
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              const sig = `${parsed.type || 'evt'}:${parsed.id || ''}:${parsed.time || ''}:${(parsed.text || '').slice(0, 40)}`;
              if (seenEventSignatures.has(sig)) continue;
              seenEventSignatures.add(sig);
              ingestEvent(parsed, true);
            } catch (jsonErr) {
              // Ignore partial or invalid JSON lines
            }
          }
        });
      }
    } catch (err) {
      // Gracefully ignore filesystem tail errors
    }
  }, 400);
}

// Orca & Git CLI Execution (always execFile, never shell exec)
export const ORCA_BIN = process.env.ORCA_BIN || 'orca';
const orcaBin = ORCA_BIN;
const GIT_SCAN_TTL_MS = 5000;
const MAX_GIT_CONCURRENCY = 4;
const gitScanCache = new Map();
let activeGitCalls = 0;
const gitCallQueue = [];

function execFileAsync(bin, args = [], options = {}) {
  return new Promise(resolve => {
    execFile(
      bin,
      args,
      {
        timeout: options.timeout ?? 4500,
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
        cwd: options.cwd
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout: stdout || '', stderr: stderr || '' });
      }
    );
  });
}

async function execJson(bin, args = [], options = {}) {
  const { error, stdout, stderr } = await execFileAsync(bin, args, options);
  if (error && !stdout) {
    return { ok: false, error: { code: 'exec_failed', message: (stderr || error.message || 'Command failed').trim() } };
  }
  try {
    return JSON.parse(stdout);
  } catch (parseErr) {
    return {
      ok: false,
      error: {
        code: error ? 'exec_failed' : 'parse_error',
        message: (stderr || parseErr.message || 'Invalid JSON output').trim()
      }
    };
  }
}

function runGitLimited(args, cwd) {
  return new Promise(resolve => {
    const start = () => {
      activeGitCalls += 1;
      execFile(
        'git',
        args,
        { cwd, timeout: 3000, maxBuffer: 5 * 1024 * 1024 },
        (error, stdout, stderr) => {
          activeGitCalls -= 1;
          if (gitCallQueue.length > 0) {
            const next = gitCallQueue.shift();
            next();
          }
          resolve({ error, stdout: stdout || '', stderr: stderr || '' });
        }
      );
    };

    if (activeGitCalls < MAX_GIT_CONCURRENCY) {
      start();
    } else {
      gitCallQueue.push(start);
    }
  });
}

function unquoteGitPath(rawPath) {
  let p = String(rawPath || '').trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    p = p.slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n');
  }
  return p;
}

function resolveRenamePath(rawPath) {
  const clean = unquoteGitPath(rawPath);
  const braceMatch = clean.match(/^(.*)\{([^{}]*?) => ([^{}]*?)\}(.*)$/);
  if (braceMatch) {
    return `${braceMatch[1]}${braceMatch[3]}${braceMatch[4]}`.replace(/\/+/g, '/');
  }
  if (clean.includes(' => ')) {
    const parts = clean.split(' => ');
    return unquoteGitPath(parts[parts.length - 1]);
  }
  return clean;
}

function parseGitStatusPorcelain(stdout) {
  const entries = [];
  if (!stdout) return entries;
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.length < 4) continue;
    const xy = line.slice(0, 2);
    const rawRest = line.slice(3).trimEnd();
    if (!rawRest) continue;

    let filePath = rawRest;
    if ((xy[0] === 'R' || xy[0] === 'C' || rawRest.includes(' -> '))) {
      const parts = rawRest.split(' -> ');
      filePath = parts[parts.length - 1];
    }
    filePath = unquoteGitPath(filePath);
    if (!filePath) continue;

    let status = 'M';
    if (xy === '??') {
      status = '?';
    } else if (xy.includes('U') || xy === 'AA' || xy === 'DD') {
      status = 'U';
    } else if (xy.includes('A')) {
      status = 'A';
    } else if (xy.includes('D')) {
      status = 'D';
    } else if (xy.includes('R')) {
      status = 'R';
    }

    entries.push({ path: filePath, status });
  }
  return entries;
}

function parseGitDiffNumstat(stdout) {
  const stats = new Map();
  if (!stdout) return stats;
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    const insertions = match[1] === '-' ? 0 : (parseInt(match[1], 10) || 0);
    const deletions = match[2] === '-' ? 0 : (parseInt(match[2], 10) || 0);
    const filePath = resolveRenamePath(match[3]);
    if (!filePath) continue;
    const prev = stats.get(filePath);
    if (prev) {
      prev.insertions += insertions;
      prev.deletions += deletions;
    } else {
      stats.set(filePath, { insertions, deletions });
    }
  }
  return stats;
}

function pruneGitCache() {
  if (gitScanCache.size <= 250) return;
  const entries = [...gitScanCache.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  const removeCount = entries.length - 200;
  for (let i = 0; i < removeCount; i++) {
    gitScanCache.delete(entries[i][0]);
  }
}

async function scanWorktreeGitFiles(wtPath, workspaceKind) {
  if (!wtPath || typeof wtPath !== 'string' || workspaceKind === 'folder-workspace') {
    return [];
  }
  const resolved = path.resolve(wtPath);
  const now = Date.now();
  const cached = gitScanCache.get(resolved);
  if (cached) {
    if (cached.promise) return cached.promise;
    if (now - cached.ts < GIT_SCAN_TTL_MS) return cached.files;
  }

  const scanPromise = (async () => {
    try {
      const st = fs.statSync(resolved);
      if (!st.isDirectory() || !fs.existsSync(path.join(resolved, '.git'))) {
        gitScanCache.set(resolved, { ts: Date.now(), files: [] });
        return [];
      }
    } catch {
      gitScanCache.set(resolved, { ts: Date.now(), files: [] });
      return [];
    }

    const [statusRes, numstatRes] = await Promise.all([
      runGitLimited(['-C', resolved, 'status', '--porcelain'], resolved),
      runGitLimited(['-C', resolved, 'diff', '--numstat'], resolved)
    ]);

    if (statusRes.error) {
      gitScanCache.set(resolved, { ts: Date.now(), files: [] });
      return [];
    }

    const statusEntries = parseGitStatusPorcelain(statusRes.stdout);
    const numstatMap = numstatRes.error ? new Map() : parseGitDiffNumstat(numstatRes.stdout);

    const files = statusEntries
      .map(entry => {
        const diffStat = numstatMap.get(entry.path) || { insertions: 0, deletions: 0 };
        return {
          path: entry.path,
          status: entry.status,
          insertions: diffStat.insertions,
          deletions: diffStat.deletions
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));

    gitScanCache.set(resolved, { ts: Date.now(), files });
    pruneGitCache();
    return files;
  })();

  gitScanCache.set(resolved, { ts: cached?.ts || 0, files: cached?.files || [], promise: scanPromise });
  try {
    return await scanPromise;
  } catch {
    gitScanCache.set(resolved, { ts: Date.now(), files: [] });
    return [];
  }
}

function getKnownWorktreePaths() {
  const set = new Set();
  for (const w of worktrees) {
    if (w && w.path && w.workspaceKind !== 'folder-workspace') {
      set.add(path.resolve(w.path));
    }
  }
  for (const w of processes) {
    if (w && w.path && w.workspaceKind !== 'folder-workspace') {
      set.add(path.resolve(w.path));
    }
  }
  return set;
}

function getKnownWorktreeIds() {
  const set = new Set();
  for (const w of worktrees) {
    if (w?.worktreeId) set.add(w.worktreeId);
    if (w?.id) set.add(w.id);
  }
  for (const w of processes) {
    if (w?.worktreeId) set.add(w.worktreeId);
    if (w?.id) set.add(w.id);
  }
  return set;
}

const SAFE_CLI_AGENTS = new Set(['claude', 'codex', 'opencode', 'gemini']);

function resolveSafeCliAgent(member = {}) {
  const explicit = String(member.agent || '').trim().toLowerCase();
  if (SAFE_CLI_AGENTS.has(explicit)) return explicit;

  const hint = `${member.model || ''} ${member.role || ''} ${member.id || ''}`.toLowerCase();
  const detected = detectAgentType(hint);
  if (SAFE_CLI_AGENTS.has(detected)) return detected;
  if (detected === 'deepseek' || hint.includes('/')) return 'opencode';
  if (detected === 'agy') return 'gemini';
  if (/\b(gpt|o1|o3|o4|codex)\b/.test(hint)) return 'codex';
  return 'claude';
}

function parseComposeMentions(text, explicitMentions) {
  const found = [];
  const seen = new Set();

  const add = raw => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const normalized = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
    if (!/^@[a-zA-Z0-9._-]+$/.test(normalized)) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(normalized);
  };

  if (typeof text === 'string') {
    const matches = text.match(/@[a-zA-Z0-9._-]+/g) || [];
    for (const m of matches) add(m);
  }

  if (Array.isArray(explicitMentions)) {
    for (const m of explicitMentions) add(m);
  }

  return found;
}

async function dispatchComposeMentions({ from, text, projectId, mentions, targets }) {
  await ensureOrcaPolled();

  const cleanText = text.trim();
  const fromHandle = (typeof from === 'string' && from.trim())
    ? normalizeHandle(from.trim(), 'coordinator')
    : '@coordinator';
  const parsedMentions = parseComposeMentions(cleanText, mentions);
  const cleanProjectId = typeof projectId === 'string' ? projectId.trim() : '';

  const postTo = parsedMentions.length ? parsedMentions : ['@all'];
  const postEvt = {
    type: 'post',
    from: fromHandle,
    to: postTo,
    text: cleanText,
    time: formatTime(new Date()),
    projectId: cleanProjectId || null
  };
  const post = ingestEvent(postEvt, false);
  appendToEventLog(postEvt);

  const proj = cleanProjectId
    ? (orcaProjects.find(p => p.id === cleanProjectId || p.rawId === cleanProjectId) || null)
    : null;

  const liveTerminalsByHandle = new Map();
  for (const t of terminals) {
    if (t && typeof t.handle === 'string' && t.handle.trim()) {
      liveTerminalsByHandle.set(t.handle.trim(), t);
    }
  }
  const knownWorktreePaths = getKnownWorktreePaths();
  const knownBranches = collectKnownBranchNames();

  const projMembersById = new Map();
  const projTerminals = new Set();
  const projWorktreePaths = new Set();

  if (proj) {
    for (const m of proj.members || []) {
      if (m?.id) projMembersById.set(m.id.toLowerCase(), m);
      if (m?.terminalHandle && liveTerminalsByHandle.has(m.terminalHandle)) {
        projTerminals.add(m.terminalHandle);
      }
      if (m?.worktreePath && typeof m.worktreePath === 'string' && !m.worktreePath.includes('\0')) {
        const rp = path.resolve(m.worktreePath);
        if (knownWorktreePaths.has(rp)) {
          projWorktreePaths.add(rp);
        }
      }
    }
  }

  const demoMembersById = new Map();
  for (const m of members) {
    if (m?.id) demoMembersById.set(m.id.toLowerCase(), m);
  }

  const resolvedTargets = [];
  const seenTargets = new Set();

  const pushCandidateTarget = (rawId, rawOverride = {}) => {
    const cleanId = typeof rawId === 'string' ? rawId.trim() : '';
    if (!cleanId) return;
    const handle = cleanId.startsWith('@') ? cleanId : `@${cleanId}`;
    const lower = handle.toLowerCase();

    if (lower === '@coordinator' || lower === fromHandle.toLowerCase()) return;
    if (seenTargets.has(lower)) return;
    seenTargets.add(lower);

    if (lower === '@all' && !rawOverride.terminalHandle && !rawOverride.worktreePath) {
      resolvedTargets.push({
        target: handle,
        terminalHandle: null,
        worktreePath: null,
        member: null,
        isBroadcast: true
      });
      return;
    }

    const projMember = projMembersById.get(lower) || null;
    const fallbackMember = proj ? null : (demoMembersById.get(lower) || null);
    const mergedMember = projMember || fallbackMember || (typeof rawOverride === 'object' ? rawOverride : {});

    // Verify terminalHandle against live terminals AND project scope
    const candidateTh = (typeof rawOverride.terminalHandle === 'string' && rawOverride.terminalHandle.trim())
      ? rawOverride.terminalHandle.trim()
      : (projMember?.terminalHandle || null);

    let validTerminalHandle = null;
    if (
      candidateTh &&
      /^[a-z0-9_:-]+$/i.test(candidateTh) &&
      orcaStatus.available &&
      liveTerminalsByHandle.has(candidateTh)
    ) {
      if (!cleanProjectId || projTerminals.has(candidateTh)) {
        validTerminalHandle = candidateTh;
      }
    }

    // Verify worktreePath against known worktrees AND project scope
    const candidateWp = (typeof rawOverride.worktreePath === 'string' && rawOverride.worktreePath.trim() && !rawOverride.worktreePath.includes('\0'))
      ? rawOverride.worktreePath.trim()
      : (projMember?.worktreePath || null);

    let validWorktreePath = null;
    if (candidateWp) {
      const resolvedWp = path.resolve(candidateWp);
      if (knownWorktreePaths.has(resolvedWp)) {
        if (!cleanProjectId || projWorktreePaths.has(resolvedWp)) {
          validWorktreePath = resolvedWp;
        }
      }
    }

    resolvedTargets.push({
      target: projMember?.id || handle,
      terminalHandle: validTerminalHandle,
      worktreePath: validWorktreePath,
      member: {
        id: projMember?.id || handle,
        model: rawOverride.model || mergedMember?.model || '',
        role: rawOverride.role || mergedMember?.role || '',
        agent: rawOverride.agent || mergedMember?.agent || '',
        branch: rawOverride.branch || mergedMember?.branch || ''
      },
      isBroadcast: false
    });
  };

  if (Array.isArray(targets) && targets.length > 0) {
    for (const item of targets) {
      if (typeof item === 'string') {
        pushCandidateTarget(item);
      } else if (item && typeof item === 'object') {
        const itemId = item.id || item.handle || item.target || '';
        pushCandidateTarget(itemId, item);
      }
    }
  } else {
    for (const m of parsedMentions) {
      pushCandidateTarget(m);
    }
  }

  const dispatched = [];
  for (const item of resolvedTargets) {
    if (item.terminalHandle) {
      const rpcRes = await execJson(
        orcaBin,
        ['terminal', 'send', '--terminal', item.terminalHandle, '--text', cleanText, '--enter', '--json'],
        { timeout: 8000 }
      );
      const ok = Boolean(rpcRes && rpcRes.ok !== false);
      dispatched.push({
        target: item.target,
        action: 'terminal_send',
        ok,
        detail: ok
          ? `Sent to terminal ${item.terminalHandle}`
          : (rpcRes?.error?.message || 'Failed to send to terminal')
      });
    } else if (item.worktreePath) {
      const agentId = resolveSafeCliAgent(item.member);
      const branchExclude = new Set(knownBranches);
      if (item.member?.branch) {
        branchExclude.add(String(item.member.branch).replace(/^refs\/heads\//, '').trim().toLowerCase());
      }
      const modelFlag = isRealModelId(item.member?.model, branchExclude)
        ? ['--model', String(item.member.model).trim()]
        : [];
      const rpcRes = await execJson(
        orcaBin,
        ['agent', 'launch', '--agent', agentId, '--worktree', 'path:' + item.worktreePath, '--prompt', cleanText, ...modelFlag, '--json'],
        { timeout: 15000 }
      );
      const ok = Boolean(rpcRes && rpcRes.ok !== false);
      dispatched.push({
        target: item.target,
        action: 'agent_launch',
        ok,
        detail: ok
          ? `Launched ${agentId} in ${path.basename(item.worktreePath)}`
          : (rpcRes?.error?.message || 'Failed to launch agent')
      });
    } else {
      dispatched.push({
        target: item.target,
        action: 'note_only',
        ok: true,
        detail: item.isBroadcast ? 'Broadcast note recorded on board' : 'No live terminal or worktree bound'
      });
    }
  }

  const summary = {
    total: dispatched.length,
    sent: dispatched.filter(d => d.action === 'terminal_send' && d.ok).length,
    launched: dispatched.filter(d => d.action === 'agent_launch' && d.ok).length,
    noted: dispatched.filter(d => d.action === 'note_only').length,
    failed: dispatched.filter(d => !d.ok).length
  };

  return {
    ok: true,
    post,
    dispatched,
    summary
  };
}

function unwrapOrcaResult(res) {
  if (res && typeof res === 'object' && 'result' in res && res.result !== undefined) {
    return res.result;
  }
  return res;
}

function slugify(str, fallback = 'node') {
  const s = String(str || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

function truncateText(str, max = 220) {
  const clean = String(str || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function mapOrcaState(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'working' || s === 'running' || s === 'active') return 'active';
  if (s === 'blocked' || s === 'error' || s === 'failed') return 'blocked';
  return 'waiting';
}

function buildOrcaProjects(wtList, psWorktrees, termList, gitFilesByPath = new Map()) {
  const wtListById = new Map();
  for (const w of wtList) {
    if (w.id) wtListById.set(w.id, w);
    if (w.path) wtListById.set(w.path, w);
  }

  const termsByPane = new Map();
  const termsByWorktree = new Map();
  for (const t of termList) {
    if (t.tabId && t.leafId) termsByPane.set(`${t.tabId}:${t.leafId}`, t);
    const wtKey = t.worktreeId || t.worktreePath;
    if (wtKey) {
      if (!termsByWorktree.has(wtKey)) termsByWorktree.set(wtKey, []);
      termsByWorktree.get(wtKey).push(t);
    }
  }

  // Group worktree ps entries (falling back to wtList if psWorktrees is empty)
  const sourceWorktrees = psWorktrees.length ? psWorktrees : wtList;
  const projectGroups = new Map();

  for (const w of sourceWorktrees) {
    const wtMeta = wtListById.get(w.worktreeId || w.id) || wtListById.get(w.path) || {};
    const projectKey = w.repoId || wtMeta.repoId || wtMeta.projectId || w.repo || path.basename(w.path || '') || 'orca-project';
    const projectName = w.repo || (wtMeta.projectId ? wtMeta.projectId.split('/').pop() : null) || path.basename(w.path || '') || 'Orca Project';

    if (!projectGroups.has(projectKey)) {
      projectGroups.set(projectKey, {
        id: `orca:${projectKey}`,
        rawId: projectKey,
        name: projectName,
        worktrees: [],
        lastActivityAt: 0
      });
    }
    const grp = projectGroups.get(projectKey);
    grp.worktrees.push({ ...wtMeta, ...w });
    grp.lastActivityAt = Math.max(grp.lastActivityAt, Number(w.lastActivityAt || 0));
  }

  const built = [];

  for (const grp of projectGroups.values()) {
    const orderedWts = [...grp.worktrees].sort((a, b) => (a.isMainWorktree ? -1 : 1) - (b.isMainWorktree ? -1 : 1) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

    // Precompute per-worktree changed files and cross-worktree collisions for this project
    const worktreeFiles = {};
    const pathOccurrences = new Map();
    let totalChangedFilesCount = 0;

    for (const w of orderedWts) {
      const wtId = w.worktreeId || w.id || w.path;
      const wtLabel = w.displayName || (w.branch ? w.branch.replace(/^refs\/heads\//, '') : '') || path.basename(w.path || '') || 'worktree';
      const branchShort = (w.branch || '').replace(/^refs\/heads\//, '') || wtLabel;
      const resolvedWtPath = w.path ? path.resolve(w.path) : '';
      const files = (resolvedWtPath && gitFilesByPath.get(resolvedWtPath)) || [];
      if (!worktreeFiles[wtId]) {
        worktreeFiles[wtId] = files;
        totalChangedFilesCount += files.length;
        for (const fileEntry of files) {
          if (!pathOccurrences.has(fileEntry.path)) {
            pathOccurrences.set(fileEntry.path, []);
          }
          pathOccurrences.get(fileEntry.path).push({
            worktreeId: wtId,
            branch: branchShort,
            status: fileEntry.status
          });
        }
      }
    }

    const fileCollisions = [];
    const wtCollisionCounts = new Map();
    for (const [filePath, occurrences] of pathOccurrences.entries()) {
      if (occurrences.length >= 2) {
        fileCollisions.push({ path: filePath, worktrees: occurrences });
        for (const occ of occurrences) {
          wtCollisionCounts.set(occ.worktreeId, (wtCollisionCounts.get(occ.worktreeId) || 0) + 1);
        }
      }
    }
    fileCollisions.sort((a, b) => (b.worktrees.length - a.worktrees.length) || a.path.localeCompare(b.path));

    const rootHandle = `@${slugify(grp.name, 'project')}`;
    const projMembers = [
      {
        id: rootHandle,
        role: 'Orca Project',
        model: 'orca-ade',
        avatarBg: '#18181b',
        icon: 'crown',
        scope: `${grp.worktrees.length} worktree${grp.worktrees.length === 1 ? '' : 's'}`,
        tags: ['@project'],
        liveState: 'active',
        repoId: grp.rawId || '',
        worktreeId: null,
        worktreePath: '',
        branch: '',
        terminalHandle: null,
        changedFilesCount: totalChangedFilesCount,
        collisionCount: fileCollisions.length,
        joinedAtPost: 0,
        retiredAtPost: null
      }
    ];
    const usedHandles = new Set([rootHandle]);
    const projPosts = [];
    const projActivities = [];
    const wtHandleById = new Map();
    const agentHandleByPane = new Map();

    let postSeq = 0;
    let activeCount = 0;
    let totalAgents = 0;
    let totalTerminals = 0;

    function uniqueHandle(base) {
      let h = base.startsWith('@') ? base : `@${base}`;
      if (!usedHandles.has(h)) {
        usedHandles.add(h);
        return h;
      }
      let n = 2;
      while (usedHandles.has(`${h}-${n}`)) n++;
      const finalH = `${h}-${n}`;
      usedHandles.add(finalH);
      return finalH;
    }

    function pushPost(from, to, text, tsMs) {
      if (!text) return;
      postSeq += 1;
      const d = tsMs ? new Date(tsMs) : new Date();
      projPosts.push({
        num: postSeq,
        sec: postSeq * 15,
        time: formatTime(d),
        offset: `+${postSeq * 15}s`,
        from,
        to: Array.isArray(to) ? to : [to],
        text
      });
    }

    // First pass: map worktree handles so child worktrees and agents can link to parent worktrees
    for (const w of orderedWts) {
      const wtId = w.worktreeId || w.id || w.path;
      const wtLabel = w.displayName || (w.branch ? w.branch.replace(/^refs\/heads\//, '') : '') || path.basename(w.path || '') || 'worktree';
      const branchShort = (w.branch || '').replace(/^refs\/heads\//, '') || wtLabel;
      const wtSlug = slugify(wtLabel, 'wt');
      const wtRepoId = w.repoId || grp.rawId || '';
      const wtPath = w.path || '';
      const wtChangedCount = (worktreeFiles[wtId] || []).length;
      const wtCollisionCount = wtCollisionCounts.get(wtId) || 0;
      const agents = Array.isArray(w.agents) ? w.agents : [];
      const wtTerms = termsByWorktree.get(wtId) || termsByWorktree.get(w.path) || [];
      const primaryWtTerm = wtTerms.find(t => t.connected && t.writable) || wtTerms.find(t => t.connected) || wtTerms[0] || null;
      const primaryTermHandle = primaryWtTerm ? (primaryWtTerm.handle || null) : null;
      totalTerminals += Number(w.liveTerminalCount || wtTerms.length || 0);

      // Determine parent node for this worktree
      const parentWtHandle = (w.parentWorktreeId && wtHandleById.get(w.parentWorktreeId)) || rootHandle;
      let wtNodeHandle = parentWtHandle;

      // Create a worktree node when this worktree is a child worktree, has live terminals, or has >1 agents / 0 agents with activity
      if (!w.isMainWorktree || agents.length === 0 || wtTerms.length > 0) {
        wtNodeHandle = uniqueHandle(`wt-${wtSlug}`);
        const wtLive = (w.liveTerminalCount > 0 || w.status === 'active' || wtTerms.some(t => t.connected)) ? 'active' : 'waiting';
        if (wtLive === 'active') activeCount++;
        projMembers.push({
          id: wtNodeHandle,
          role: w.isMainWorktree ? 'Main Worktree' : 'Worktree',
          model: branchShort,
          avatarBg: w.isMainWorktree ? '#334155' : '#0284c7',
          icon: 'git',
          scope: w.path || branchShort,
          tags: ['@worktree'],
          liveState: wtLive,
          worktreeId: wtId,
          worktreePath: wtPath,
          branch: branchShort,
          repoId: wtRepoId,
          terminalHandle: primaryTermHandle,
          changedFilesCount: wtChangedCount,
          collisionCount: wtCollisionCount,
          joinedAtPost: 0,
          retiredAtPost: null
        });
        wtHandleById.set(wtId, wtNodeHandle);

        const linkedSummary = Array.isArray(w.linkedItems) && w.linkedItems.length
          ? ` (${w.linkedItems.map(li => `${li.type.toUpperCase()} #${li.number}`).join(', ')})`
          : '';
        if (wtTerms.length > 0 || agents.length > 0 || !w.isMainWorktree) {
          pushPost(parentWtHandle, [wtNodeHandle], `Worktree \`${branchShort}\`${linkedSummary} (${w.liveTerminalCount || 0} live terminals, ${agents.length} agents).`, w.lastActivityAt);
        }
      } else {
        wtHandleById.set(wtId, rootHandle);
      }

      // Register agents and nested subagents inside this worktree
      const seenPaneKeys = new Set();

      function registerAgentNode(ag, fallbackParent) {
        totalAgents++;
        const paneKey = ag.paneKey || `${wtId}:${totalAgents}`;
        seenPaneKeys.add(paneKey);

        const rawType = ag.agentType || detectAgentType(ag.displayName || ag.taskTitle || ag.conversationName || '');
        const meta = AGENT_TYPE_META[rawType] || AGENT_TYPE_META.terminal;
        const label = ag.displayName || ag.taskTitle || ag.conversationName || rawType;
        const handle = uniqueHandle(`${rawType}-${slugify(label, 'agent').slice(0, 16)}`);
        agentHandleByPane.set(paneKey, handle);

        const liveState = mapOrcaState(ag.state);
        if (liveState === 'active') activeCount++;
        const isSub = Boolean(ag.parentPaneKey);
        const matchedTerm = (paneKey && termsByPane.get(paneKey)) || null;
        const agentTerminalHandle = (matchedTerm && matchedTerm.handle) || ag.terminalHandle || primaryTermHandle || null;

        projMembers.push({
          id: handle,
          role: isSub ? `Subagent · ${rawType}` : `${meta.role} · ${wtLabel}`,
          model: rawType,
          avatarBg: meta.avatarBg,
          icon: isSub ? 'bot' : meta.icon,
          scope: truncateText(ag.conversationName || ag.taskTitle || ag.prompt || w.path || '', 120),
          tags: isSub ? ['@subagent', `@${rawType}`] : [`@${rawType}`, `@${wtSlug}`],
          liveState,
          worktreeId: wtId,
          worktreePath: wtPath,
          branch: branchShort,
          repoId: wtRepoId,
          terminalHandle: agentTerminalHandle,
          changedFilesCount: wtChangedCount,
          collisionCount: wtCollisionCount,
          joinedAtPost: 0,
          retiredAtPost: null
        });

        const parentHandle = (ag.parentPaneKey && agentHandleByPane.get(ag.parentPaneKey)) || fallbackParent || wtNodeHandle;
        const briefText = truncateText(ag.prompt || ag.conversationName || ag.taskTitle || `Running ${rawType} session`, 260);
        pushPost(parentHandle, [handle], briefText, ag.stateStartedAt || ag.updatedAt || w.lastActivityAt);

        if (ag.lastAssistantMessage) {
          pushPost(handle, [parentHandle], truncateText(ag.lastAssistantMessage, 260), ag.updatedAt || ag.stateStartedAt);
        }

        if (ag.toolName || ag.state === 'working') {
          projActivities.push({
            id: `orca-act-${slugify(paneKey)}`,
            agentId: handle,
            tool: ag.toolName || `${rawType}.session`,
            cmd: truncateText(ag.toolInput ? JSON.stringify(ag.toolInput) : (ag.conversationName || ag.taskTitle || 'Active agent turn'), 120),
            status: ag.state === 'working' ? 'running' : 'ok',
            durationSec: ag.stateStartedAt ? Math.max(1, Math.round((Date.now() - ag.stateStartedAt) / 1000)) : 1,
            postNum: postSeq,
            startedAt: ag.stateStartedAt || Date.now()
          });
        }

        if (Array.isArray(ag.children)) {
          for (const child of ag.children) {
            registerAgentNode({ ...child, parentPaneKey: child.parentPaneKey || paneKey }, handle);
          }
        }
      }

      // Parent agents first, then any flat child agents referencing parentPaneKey
      const topAgents = agents.filter(a => !a.parentPaneKey);
      const subAgents = agents.filter(a => a.parentPaneKey);
      for (const ag of topAgents) registerAgentNode(ag, wtNodeHandle);
      for (const ag of subAgents) registerAgentNode(ag, wtNodeHandle);

      // Join standalone live terminals in this worktree not already covered by structured agents
      for (const term of wtTerms) {
        const paneKey = term.tabId && term.leafId ? `${term.tabId}:${term.leafId}` : null;
        if (paneKey && seenPaneKeys.has(paneKey)) continue;

        const detected = detectAgentType(`${term.title || ''} ${term.preview || ''}`);
        const meta = AGENT_TYPE_META[detected] || AGENT_TYPE_META.terminal;
        const termHandle = uniqueHandle(`${detected}-${slugify(term.title || 'term', 'term').slice(0, 18)}`);
        const isLiveTerm = Boolean(term.connected);
        if (isLiveTerm) activeCount++;

        projMembers.push({
          id: termHandle,
          role: `${term.title || 'Terminal'} · ${wtLabel}`,
          model: detected,
          avatarBg: meta.avatarBg,
          icon: meta.icon,
          scope: truncateText(term.preview || term.worktreePath || term.title || 'Orca terminal', 120),
          tags: [`@${detected}`, '@terminal'],
          liveState: isLiveTerm ? 'active' : 'waiting',
          worktreeId: wtId,
          worktreePath: wtPath,
          branch: branchShort,
          repoId: wtRepoId,
          terminalHandle: term.handle || null,
          changedFilesCount: wtChangedCount,
          collisionCount: wtCollisionCount,
          joinedAtPost: 0,
          retiredAtPost: null
        });

        pushPost(wtNodeHandle, [termHandle], `Terminal \`${term.title || 'Shell'}\`${term.preview ? `: ${truncateText(term.preview, 180)}` : ''}`, w.lastActivityAt);
      }
    }

    // Only keep projects that have worktrees/agents/terminals
    built.push({
      id: grp.id,
      rawId: grp.rawId,
      name: grp.name,
      worktreeCount: grp.worktrees.length,
      agentCount: totalAgents,
      terminalCount: totalTerminals,
      activeCount,
      changedFilesCount: totalChangedFilesCount,
      collisionCount: fileCollisions.length,
      worktreeFiles,
      fileCollisions,
      lastActivityAt: grp.lastActivityAt,
      members: projMembers,
      posts: projPosts,
      activities: projActivities
    });
  }

  // Sort projects: live terminals/active agents first, then total agents, then recent activity
  built.sort((a, b) =>
    (b.terminalCount - a.terminalCount) ||
    (b.activeCount - a.activeCount) ||
    (b.agentCount - a.agentCount) ||
    (b.lastActivityAt - a.lastActivityAt)
  );

  return built;
}

let pollInFlight = false;
let activePollPromise = null;

async function ensureOrcaPolled() {
  if (orcaStatus.lastChecked !== null) return;
  if (activePollPromise) {
    await activePollPromise;
    return;
  }
  await pollOrca();
}

async function pollOrca() {
  if (pollInFlight) return activePollPromise;
  pollInFlight = true;
  activePollPromise = (async () => {
    try {
      const [wtRes, psRes, termRes, activeWtRes] = await Promise.all([
        execJson(orcaBin, ['worktree', 'list', '--json']),
        execJson(orcaBin, ['worktree', 'ps', '--json']),
        execJson(orcaBin, ['terminal', 'list', '--json']),
        execJson(orcaBin, ['worktree', 'show', '--worktree', 'active', '--json'], { timeout: 2500 }).catch(() => null)
      ]);

      let orcaDown = false;
      let downReason = 'runtime_unavailable';

      for (const res of [wtRes, psRes, termRes]) {
        if (res && res.error && (res.error.code === 'runtime_unavailable' || res.error.code === 'exec_failed')) {
          orcaDown = true;
          downReason = res.error.code;
          break;
        }
      }

      if (orcaDown) {
        const prevAvailable = orcaStatus.available;
        activeOrcaProjectId = null;
        activeOrcaWorktreeId = null;
        activeWorktreePath = null;
        activeBranch = null;
        orcaStatus = {
          available: false,
          code: downReason,
          message: 'Orca runtime unavailable or offline',
          lastChecked: Date.now()
        };
        if (prevAvailable) {
          orcaProjects = [];
          broadcast('orca_status', orcaStatus);
        }
        return;
      }

      const activeWtUnwrapped = activeWtRes && !activeWtRes.error && activeWtRes.ok !== false
        ? unwrapOrcaResult(activeWtRes)
        : null;
      const activeWt = activeWtUnwrapped?.worktree || null;
      const nextActiveProjectId = activeWt?.projectId || null;
      const nextActiveWorktreeId = activeWt?.id || null;
      const nextActiveWorktreePath = activeWt?.path || null;
      const nextActiveBranch = activeWt?.branch ? String(activeWt.branch).replace(/^refs\/heads\//, '') : null;
      const activeChanged =
        nextActiveProjectId !== activeOrcaProjectId ||
        nextActiveWorktreeId !== activeOrcaWorktreeId ||
        nextActiveWorktreePath !== activeWorktreePath ||
        nextActiveBranch !== activeBranch;

      const wtUnwrapped = unwrapOrcaResult(wtRes);
      const psUnwrapped = unwrapOrcaResult(psRes);
      const termUnwrapped = unwrapOrcaResult(termRes);

      const newWorktrees = Array.isArray(wtUnwrapped) ? wtUnwrapped : (wtUnwrapped?.worktrees || wtUnwrapped?.items || []);
      const psWorktrees = Array.isArray(psUnwrapped) ? psUnwrapped : (psUnwrapped?.worktrees || psUnwrapped?.items || []);
      let newTerminals = Array.isArray(termUnwrapped) ? termUnwrapped : (termUnwrapped?.terminals || termUnwrapped?.items || []);

      newTerminals = newTerminals.map(term => {
        const detected = detectAgentType(`${term.command || ''} ${term.title || ''} ${term.preview || ''}`);
        return {
          ...term,
          agentType: detected,
          agentMeta: AGENT_TYPE_META[detected]
        };
      });

      const gitTargets = new Map();
      for (const w of (psWorktrees.length ? psWorktrees : newWorktrees)) {
        if (w && w.path && w.workspaceKind !== 'folder-workspace') {
          gitTargets.set(path.resolve(w.path), { path: w.path, workspaceKind: w.workspaceKind });
        }
      }
      const gitFilesByPath = new Map();
      await Promise.all(
        [...gitTargets.entries()].map(async ([resolvedPath, target]) => {
          const files = await scanWorktreeGitFiles(target.path, target.workspaceKind);
          gitFilesByPath.set(resolvedPath, files);
        })
      );

      const newOrcaProjects = buildOrcaProjects(newWorktrees, psWorktrees, newTerminals, gitFilesByPath);

      const changed = JSON.stringify(newOrcaProjects) !== JSON.stringify(orcaProjects) || activeChanged || !orcaStatus.available;

      worktrees = newWorktrees;
      terminals = newTerminals;
      processes = psWorktrees;
      orcaProjects = newOrcaProjects;
      activeOrcaProjectId = nextActiveProjectId;
      activeOrcaWorktreeId = nextActiveWorktreeId;
      activeWorktreePath = nextActiveWorktreePath;
      activeBranch = nextActiveBranch;
      orcaStatus = {
        available: true,
        code: 'ok',
        message: `Orca active (${orcaProjects.length} projects, ${newTerminals.length} live terminals)`,
        lastChecked: Date.now()
      };

      if (changed) {
        broadcast('orca_update', {
          worktrees,
          terminals,
          orcaProjects,
          orcaStatus,
          activeOrcaProjectId,
          activeOrcaWorktreeId,
          activeWorktreePath,
          activeBranch
        });
      }
    } catch (err) {
      orcaStatus = {
        available: false,
        code: 'polling_error',
        message: err.message,
        lastChecked: Date.now()
      };
    } finally {
      pollInFlight = false;
      activePollPromise = null;
    }
  })();
  return activePollPromise;
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, res, maxBytes = 1024 * 1024) {
  return new Promise(resolve => {
    let body = '';
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      body += chunk;
      if (body.length > maxBytes) {
        settled = true;
        sendJson(res, 413, { ok: false, error: 'Payload too large' });
        req.destroy();
        resolve({ ok: false, handled: true });
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(body || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, { ok: false, error: 'JSON object body required' });
          resolve({ ok: false, handled: true });
          return;
        }
        resolve({ ok: true, data: stripUnsafeKeys(parsed) });
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
        resolve({ ok: false, handled: true });
      }
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      sendJson(res, 400, { ok: false, error: 'Request stream error' });
      resolve({ ok: false, handled: true });
    });
  });
}

function getAllowedHostnames() {
  const set = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (process.env.ORCA_SWARM_HOST && process.env.ORCA_SWARM_HOST.trim()) {
    const h = process.env.ORCA_SWARM_HOST.trim().toLowerCase();
    if (h !== '0.0.0.0' && h !== '::') {
      set.add(h);
      if (h.includes(':') && !h.startsWith('[')) set.add(`[${h}]`);
    }
  }
  return set;
}

function parseHostHeader(rawHost) {
  if (!rawHost || typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed || /[\s/@\\]/.test(trimmed)) return null;
  if (trimmed.startsWith('[')) {
    const m = trimmed.match(/^(\[[a-f0-9:]+\])(?::(\d{1,5}))?$/i);
    if (!m) return null;
    return { hostname: m[1], port: m[2] ? Number(m[2]) : null };
  }
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return { hostname: trimmed, port: null };
  if (trimmed.indexOf(':', colonIdx + 1) !== -1) return null;
  const portNum = Number(trimmed.slice(colonIdx + 1));
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
  return { hostname: trimmed.slice(0, colonIdx), port: portNum };
}

function isAllowedOrigin(originHeader, allowedHostnames, expectedPort) {
  if (!originHeader || typeof originHeader !== 'string') return false;
  try {
    const u = new URL(originHeader);
    if (u.protocol !== 'http:') return false;
    if (!allowedHostnames.has(u.hostname.toLowerCase())) return false;
    const originPort = u.port ? Number(u.port) : 80;
    return originPort === expectedPort;
  } catch {
    return false;
  }
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

function hasValidBridgeToken(req) {
  const headerToken = req.headers['x-orca-swarm-token'];
  const authHeader = req.headers['authorization'];
  let candidate = '';
  if (typeof headerToken === 'string' && headerToken.trim()) {
    candidate = headerToken.trim();
  } else if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
    candidate = authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  if (!candidate) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(BRIDGE_TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// HTTP Request Handler
async function handleRequest(req, res) {
  applySecurityHeaders(res);

  const expectedPort = req.socket?.localPort || activePort || PORT;
  const allowedHostnames = getAllowedHostnames();
  const parsedHost = parseHostHeader(req.headers.host);
  if (
    !parsedHost ||
    !allowedHostnames.has(parsedHost.hostname) ||
    (parsedHost.port !== null && parsedHost.port !== expectedPort)
  ) {
    sendJson(res, 403, { ok: false, error: 'Host header blocked' });
    return;
  }

  const secFetchSite = typeof req.headers['sec-fetch-site'] === 'string'
    ? req.headers['sec-fetch-site'].trim().toLowerCase()
    : '';
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    sendJson(res, 403, { ok: false, error: 'Cross-site request blocked' });
    return;
  }

  const originHeader = req.headers.origin;
  if (originHeader !== undefined) {
    if (!isAllowedOrigin(originHeader, allowedHostnames, expectedPort)) {
      sendJson(res, 403, { ok: false, error: 'Cross-origin request blocked' });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Orca-Swarm-Token, Authorization');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && !hasValidBridgeToken(req)) {
    sendJson(res, 401, { ok: false, error: 'Missing or invalid X-Orca-Swarm-Token' });
    return;
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${expectedPort}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /events (Server-Sent Events)
  if (req.method === 'GET' && pathname === '/events') {
    if (activeClients.size >= MAX_SSE_CLIENTS) {
      sendJson(res, 503, { ok: false, error: 'Too many SSE subscribers' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'Connection': 'keep-alive'
    });

    // Send immediate initial snapshot
    const snapshot = getSnapshot();
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

    // Keepalive ping every 15s
    const keepAliveTimer = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepAliveTimer);
      }
    }, 15000);

    activeClients.add(res);

    req.on('close', () => {
      clearInterval(keepAliveTimer);
      activeClients.delete(res);
    });
    return;
  }

  // POST /events (REST webhook)
  if (req.method === 'POST' && pathname === '/events') {
    const bodyRes = await readJsonBody(req, res, 5 * 1024 * 1024);
    if (!bodyRes.ok) return;
    const ingested = ingestEvent(bodyRes.data, false);
    appendToEventLog(bodyRes.data);
    sendJson(res, 200, { ok: true, received: ingested });
    return;
  }

  // POST /api/members (Register custom agent)
  if (req.method === 'POST' && pathname === '/api/members') {
    const bodyRes = await readJsonBody(req, res);
    if (!bodyRes.ok) return;
    const parsed = bodyRes.data;
    const memberPayload =
      parsed && typeof parsed.member === 'object' && parsed.member !== null
        ? parsed.member
        : parsed;
    const registered = registerOrUpdateMember(memberPayload);
    if (!registered) {
      sendJson(res, 400, { ok: false, error: 'Member handle or id is required' });
      return;
    }

    appendToEventLog({ type: 'member', member: registered, timestamp: Date.now() });
    sendJson(res, 200, { ok: true, member: registered });
    return;
  }

  // GET /api/members
  if (req.method === 'GET' && pathname === '/api/members') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(members));
    return;
  }

  // GET /api/presets
  if (req.method === 'GET' && pathname === '/api/presets') {
    const presets = discoverAgentPresets();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, presets, count: presets.length }));
    return;
  }

  // GET /api/models
  if (req.method === 'GET' && pathname === '/api/models') {
    const refreshParam = (parsedUrl.searchParams.get('refresh') || '').toLowerCase();
    const refresh = refreshParam === '1' || refreshParam === 'true';
    const modelsPayload = await discoverAvailableModels({ refresh });
    sendJson(res, 200, modelsPayload);
    return;
  }

  // POST /api/dispatch-mentions
  if (req.method === 'POST' && pathname === '/api/dispatch-mentions') {
    const bodyRes = await readJsonBody(req, res);
    if (!bodyRes.ok) return;

    const { from, text, projectId, mentions, targets } = bodyRes.data;
    if (typeof text !== 'string' || text.trim().length === 0) {
      sendJson(res, 400, { ok: false, error: 'Non-empty text is required' });
      return;
    }

    const result = await dispatchComposeMentions({ from, text, projectId, mentions, targets });
    sendJson(res, 200, result);
    return;
  }

  // POST /api/presets
  if (req.method === 'POST' && pathname === '/api/presets') {
    const bodyRes = await readJsonBody(req, res);
    if (!bodyRes.ok) return;
    const parsed = bodyRes.data;
    const payload = parsed && typeof parsed.preset === 'object' && parsed.preset !== null ? parsed.preset : parsed;
    if (!payload || !(payload.id || payload.handle || payload.name)) {
      sendJson(res, 400, { ok: false, error: 'Preset id or handle is required' });
      return;
    }
    const saved = saveUserPreset(payload);
    const presets = discoverAgentPresets();
    sendJson(res, 200, { ok: true, preset: saved, presets });
    return;
  }

  // GET /api/files?project=<id>
  if (req.method === 'GET' && pathname === '/api/files') {
    await ensureOrcaPolled();
    const projectParam = parsedUrl.searchParams.get('project') || '';
    let proj = null;
    if (projectParam) {
      proj = orcaProjects.find(p => p.id === projectParam || p.rawId === projectParam) || null;
      if (!proj) {
        sendJson(res, 404, { ok: false, error: 'Project not found' });
        return;
      }
    } else {
      proj = orcaProjects[0] || null;
    }
    sendJson(res, 200, {
      ok: true,
      projectId: proj ? proj.id : null,
      worktreeFiles: proj ? (proj.worktreeFiles || {}) : {},
      fileCollisions: proj ? (proj.fileCollisions || []) : []
    });
    return;
  }

  // POST /api/files/open-diff
  if (req.method === 'POST' && pathname === '/api/files/open-diff') {
    const bodyRes = await readJsonBody(req, res);
    if (!bodyRes.ok) return;
    await ensureOrcaPolled();

    const { worktreePath, filePath } = bodyRes.data;
    if (typeof worktreePath !== 'string' || !worktreePath.trim() || worktreePath.includes('\0')) {
      sendJson(res, 400, { ok: false, error: 'Valid worktreePath is required' });
      return;
    }
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
      sendJson(res, 400, { ok: false, error: 'Valid relative filePath is required' });
      return;
    }

    const resolvedWt = path.resolve(worktreePath);
    const knownPaths = getKnownWorktreePaths();
    if (!knownPaths.has(resolvedWt)) {
      sendJson(res, 400, { ok: false, error: 'Unknown or invalid worktreePath' });
      return;
    }

    if (path.isAbsolute(filePath) || /^[/\\]/.test(filePath) || filePath.split(/[/\\]/).includes('..')) {
      sendJson(res, 400, { ok: false, error: 'filePath must be a safe relative path inside worktreePath' });
      return;
    }

    const resolvedFilePath = path.resolve(resolvedWt, filePath);
    const rel = path.relative(resolvedWt, resolvedFilePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      sendJson(res, 400, { ok: false, error: 'filePath escapes worktreePath' });
      return;
    }

    try {
      if (fs.existsSync(resolvedFilePath) && fs.existsSync(resolvedWt)) {
        const realWt = fs.realpathSync(resolvedWt);
        const realFile = fs.realpathSync(resolvedFilePath);
        const realRel = path.relative(realWt, realFile);
        if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
          sendJson(res, 400, { ok: false, error: 'filePath escapes worktreePath via symlink' });
          return;
        }
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'Unable to verify filePath inside worktreePath' });
      return;
    }

    const rpcRes = await execJson(
      orcaBin,
      ['file', 'diff', resolvedFilePath, '--focus', '--json'],
      { cwd: resolvedWt, timeout: 8000 }
    );

    if (!rpcRes || rpcRes.ok === false) {
      sendJson(res, 502, {
        ok: false,
        error: rpcRes?.error?.message || 'Failed to open diff in Orca'
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      worktreePath: resolvedWt,
      filePath: rel,
      result: unwrapOrcaResult(rpcRes)
    });
    return;
  }

  // POST /api/terminal/send
  if (req.method === 'POST' && pathname === '/api/terminal/send') {
    const bodyRes = await readJsonBody(req, res);
    if (!bodyRes.ok) return;
    await ensureOrcaPolled();

    const { terminalHandle, text, enter = true, projectId, from, to } = bodyRes.data;
    if (typeof terminalHandle !== 'string' || !/^[a-z0-9][a-z0-9_:-]*$/i.test(terminalHandle)) {
      sendJson(res, 400, { ok: false, error: 'Invalid terminalHandle' });
      return;
    }
    if (orcaStatus.available && !terminals.some(t => t.handle === terminalHandle)) {
      sendJson(res, 400, { ok: false, error: 'Unknown or offline terminalHandle' });
      return;
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      sendJson(res, 400, { ok: false, error: 'Non-empty text is required' });
      return;
    }

    const shouldEnter = enter === undefined ? true : Boolean(enter);
    const args = ['terminal', 'send', '--terminal', terminalHandle, '--text', text, ...(shouldEnter ? ['--enter'] : []), '--json'];
    const rpcRes = await execJson(orcaBin, args, { timeout: 8000 });

    if (!rpcRes || rpcRes.ok === false) {
      sendJson(res, 502, {
        ok: false,
        error: rpcRes?.error?.message || 'Failed to send input to terminal'
      });
      return;
    }

    const postFrom = (typeof from === 'string' && from.trim()) ? from.trim() : '@coordinator';
    const postTo = [(typeof to === 'string' && to.trim()) ? to.trim() : terminalHandle];
    const postEvt = {
      type: 'post',
      from: postFrom,
      to: postTo,
      text,
      time: formatTime(new Date()),
      projectId: typeof projectId === 'string' ? projectId : null,
      terminalHandle
    };
    const post = ingestEvent(postEvt, false);
    appendToEventLog(postEvt);

    sendJson(res, 200, {
      ok: true,
      terminalHandle,
      post,
      result: unwrapOrcaResult(rpcRes)
    });
    return;
  }

  // POST /api/handoff
  if (req.method === 'POST' && pathname === '/api/handoff') {
    const bodyRes = await readJsonBody(req, res);
    if (!bodyRes.ok) return;
    await ensureOrcaPolled();

    const {
      mode,
      sourceWorktreeId,
      sourceWorktreePath,
      sourceBranch,
      repoId,
      targetAgent,
      targetModel,
      prompt,
      name
    } = bodyRes.data;

    if (mode !== 'existing' && mode !== 'new-worktree') {
      sendJson(res, 400, { ok: false, error: 'Invalid mode: must be "existing" or "new-worktree"' });
      return;
    }
    const cleanAgent = typeof targetAgent === 'string' ? targetAgent.trim() : '';
    if (!cleanAgent || !/^[a-z0-9][a-z0-9._-]*$/i.test(cleanAgent)) {
      sendJson(res, 400, { ok: false, error: 'Invalid targetAgent' });
      return;
    }
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      sendJson(res, 400, { ok: false, error: 'Non-empty prompt is required' });
      return;
    }

    let cleanModel = '';
    if (targetModel !== undefined && targetModel !== null && String(targetModel).trim() !== '') {
      const m = String(targetModel).trim();
      if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(m)) {
        sendJson(res, 400, { ok: false, error: 'Invalid targetModel' });
        return;
      }
      cleanModel = m;
    }

    let args;
    let rpcTimeout = 15000;

    if (mode === 'existing') {
      if (typeof sourceWorktreePath !== 'string' || !sourceWorktreePath.trim() || sourceWorktreePath.includes('\0')) {
        sendJson(res, 400, { ok: false, error: 'Valid sourceWorktreePath is required for existing mode' });
        return;
      }
      const resolvedSourcePath = path.resolve(sourceWorktreePath);
      if (!getKnownWorktreePaths().has(resolvedSourcePath)) {
        sendJson(res, 400, { ok: false, error: 'Unknown or invalid sourceWorktreePath' });
        return;
      }
      args = [
        'agent', 'launch',
        '--agent', cleanAgent,
        '--worktree', 'path:' + resolvedSourcePath,
        '--prompt', prompt,
        ...(cleanModel ? ['--model', cleanModel] : []),
        '--json'
      ];
    } else {
      const cleanRepoId = typeof repoId === 'string' ? repoId.trim() : '';
      const cleanSourceWtId = typeof sourceWorktreeId === 'string' ? sourceWorktreeId.trim() : '';
      if (!cleanRepoId && !cleanSourceWtId) {
        sendJson(res, 400, { ok: false, error: 'repoId or sourceWorktreeId is required for new-worktree mode' });
        return;
      }
      if (cleanRepoId && !/^[a-z0-9][a-z0-9._:-]*$/i.test(cleanRepoId)) {
        sendJson(res, 400, { ok: false, error: 'Invalid repoId' });
        return;
      }
      if (cleanSourceWtId) {
        if (cleanSourceWtId.includes('\0') || cleanSourceWtId.startsWith('-')) {
          sendJson(res, 400, { ok: false, error: 'Invalid sourceWorktreeId' });
          return;
        }
        if (orcaStatus.available && !getKnownWorktreeIds().has(cleanSourceWtId)) {
          sendJson(res, 400, { ok: false, error: 'Unknown sourceWorktreeId' });
          return;
        }
      }

      const slug = slugify(name || ('handoff-' + cleanAgent), 'handoff-agent').slice(0, 64);
      rpcTimeout = 20000;
      args = [
        'worktree', 'create',
        '--name', slug,
        ...(cleanRepoId ? ['--repo', 'id:' + cleanRepoId] : []),
        ...(cleanSourceWtId ? ['--parent-worktree', 'worktree:' + cleanSourceWtId] : []),
        '--agent', cleanAgent,
        '--prompt', prompt,
        ...(cleanModel ? ['--model', cleanModel] : []),
        '--json'
      ];
    }

    const rpcRes = await execJson(orcaBin, args, { timeout: rpcTimeout });
    if (!rpcRes || rpcRes.ok === false) {
      sendJson(res, 502, {
        ok: false,
        error: rpcRes?.error?.message || 'Handoff command failed'
      });
      return;
    }

    const branchInfo = (typeof sourceBranch === 'string' && sourceBranch.trim()) ? ` from ${sourceBranch.trim()}` : '';
    const postEvt = {
      type: 'post',
      from: '@coordinator',
      to: [`@${cleanAgent}`],
      text: `Handoff (${mode}${branchInfo}): ${truncateText(prompt, 240)}`,
      time: formatTime(new Date())
    };
    const post = ingestEvent(postEvt, false);
    appendToEventLog(postEvt);

    sendJson(res, 200, {
      ok: true,
      mode,
      targetAgent: cleanAgent,
      post,
      result: unwrapOrcaResult(rpcRes)
    });
    return;
  }

  // GET /api/snapshot or /api/health
  if (req.method === 'GET' && (pathname === '/api/snapshot' || pathname === '/api/state')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getSnapshot()));
    return;
  }

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      port: activePort,
      uptime: process.uptime(),
      orca: orcaStatus,
      sseClients: activeClients.size
    }));
    return;
  }

  // Static file serving from bridge/public
  if (req.method === 'GET' || req.method === 'HEAD') {
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('400 Bad Request');
      return;
    }

    if (decodedPath.includes('\0') || path.posix.basename(decodedPath).startsWith('.')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    const safeRel = path.posix.normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
    const resolvedPath = path.resolve(PUBLIC_REAL_DIR, safeRel);
    if (resolvedPath !== PUBLIC_REAL_DIR && !resolvedPath.startsWith(PUBLIC_REAL_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    const htmlCsp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ');

    fs.realpath(resolvedPath, (realErr, realFile) => {
      if (realErr) {
        if (decodedPath === '/index.html') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': htmlCsp,
            'Cache-Control': 'no-store'
          });
          res.end(`<!DOCTYPE html><html><head><meta name="orca-swarm-token" content="${BRIDGE_TOKEN}"><title>Swarm Visualiser</title></head><body style="font-family:system-ui,sans-serif;padding:40px;background:#09090b;color:#f4f4f5"><h2>Swarm Visualiser Bridge Active</h2><p>Server listening on port ${expectedPort}. Awaiting index.html in bridge/public.</p><p>SSE stream available at <a href="/events" style="color:#60a5fa">/events</a>.</p></body></html>`);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }

      if (realFile !== PUBLIC_REAL_DIR && !realFile.startsWith(PUBLIC_REAL_DIR + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
      }

      fs.stat(realFile, (statErr, stats) => {
        if (statErr || !stats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 Not Found');
          return;
        }

        const ext = path.extname(realFile).toLowerCase();
        const contentType = MIME_TYPES[ext];
        if (!contentType) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('403 Forbidden');
          return;
        }

        if (ext === '.html' || ext === '.htm') {
          fs.readFile(realFile, 'utf8', (readErr, htmlRaw) => {
            if (readErr) {
              if (!res.headersSent) res.writeHead(500);
              res.end();
              return;
            }
            const injectedHtml = htmlRaw.includes('<meta name="orca-swarm-token"')
              ? htmlRaw.replace(
                  /<meta\s+name="orca-swarm-token"\s+content="[^"]*"\s*\/?>/i,
                  `<meta name="orca-swarm-token" content="${BRIDGE_TOKEN}" />`
                )
              : htmlRaw.replace(
                  /<head>/i,
                  `<head>\n  <meta name="orca-swarm-token" content="${BRIDGE_TOKEN}" />`
                );
            const buf = Buffer.from(injectedHtml, 'utf8');
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': buf.length,
              'Content-Security-Policy': htmlCsp,
              'Cache-Control': 'no-store'
            });
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            res.end(buf);
          });
          return;
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stats.size,
          'Cache-Control': 'no-cache'
        });

        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        const stream = fs.createReadStream(realFile);
        stream.on('error', () => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        stream.pipe(res);
      });
    });
    return;
  }

  // Fallback 405
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('405 Method Not Allowed');
}

// Server factory & lifecycle
export function createServer() {
  return http.createServer((req, res) => {
    Promise.resolve(handleRequest(req, res)).catch(err => {
      console.error('[swarm-server] Request error:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'Internal server error' });
      } else {
        res.end();
      }
    });
  });
}

export function startServer(port = PORT, host = HOST) {
  ensureSwarmStorage({ writeToken: true });
  activePort = port;
  const server = createServer();

  server.listen(port, host, () => {
    const addr = server.address();
    if (addr && typeof addr === 'object' && addr.port) {
      activePort = addr.port;
    }
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(`[swarm-server] Swarm Visualiser Bridge running at http://${displayHost}:${activePort}`);
    console.log(`[swarm-server] Static files served from ${PUBLIC_DIR}`);
    console.log(`[swarm-server] SSE feed at http://${displayHost}:${activePort}/events`);
    console.log(`[swarm-server] Auth token stored (0600) at ${TOKEN_FILE}`);
    console.log(`[swarm-server] Event log active at ${EVENTS_FILE}`);
  });

  // Start background workers
  initTailer();

  // Poll Orca immediately, then every 1.5s
  pollOrca();
  const orcaTimer = setInterval(pollOrca, 1500);

  function shutdown() {
    console.log('\n[swarm-server] Shutting down bridge gracefully...');
    clearInterval(orcaTimer);
    for (const client of activeClients) {
      try {
        client.end();
      } catch {}
    }
    server.close(() => {
      console.log('[swarm-server] Server stopped.');
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

// Auto-run if executed directly
const isDirectRun = Boolean(
  process.argv[1] &&
  import.meta.url === url.pathToFileURL(path.resolve(process.argv[1])).href
);

if (isDirectRun) {
  startServer(PORT, HOST);
}
