#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EVENTS_FILE = path.join(os.homedir(), '.orca-swarm', 'events.jsonl');
const MAX_FIELD_LEN = 2000;

/**
 * Scrubs credentials, tokens, private keys, and email addresses before persisting logs.
 */
function redactSensitiveText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/(https?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1[redacted]@')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/((?:Authorization\s*:\s*Bearer|Bearer)\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-or-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|(?:xai-|hf_|gsk_|npm_)[A-Za-z0-9_-]{12,})\b/g, '[redacted-token]')
    .replace(/((?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["']?)([^\s"',;]{8,})(["']?)/gi, '$1[redacted]$3');
}

function sanitizeHookValue(val, depth = 0) {
  if (depth > 5 || val === null || val === undefined) return val;
  if (typeof val === 'string') {
    const scrubbed = redactSensitiveText(val);
    return scrubbed.length > MAX_FIELD_LEN ? scrubbed.slice(0, MAX_FIELD_LEN) + '…' : scrubbed;
  }
  if (Array.isArray(val)) return val.slice(0, 50).map(v => sanitizeHookValue(v, depth + 1));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (/^(?:api[_-]?key|secret|token|password|passwd|authorization|private[_-]?key)$/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = sanitizeHookValue(v, depth + 1);
      }
    }
    return out;
  }
  return val;
}

/**
 * Appends an event object as a JSON line to ~/.orca-swarm/events.jsonl.
 */
function appendEvent(eventData) {
  try {
    const dir = path.dirname(EVENTS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try { fs.chmodSync(dir, 0o700); } catch {}
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(eventData) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(EVENTS_FILE, 0o600); } catch {}
  } catch (err) {
    // Hooks must never fail or crash caller processes
    console.error('[swarm-hook] Failed to write event:', err);
  }
}

/**
 * Summarizes the tool usage into a human-readable activity description.
 */
function formatActivity(hookName, toolName, toolInput) {
  let summary = `${hookName}: ${toolName}`;
  if (!toolInput) return summary;

  if (typeof toolInput === 'string') {
    const line = toolInput.trim().split('\n')[0];
    return `${summary} (${line.slice(0, 60)})`;
  }

  if (typeof toolInput === 'object') {
    const target =
      toolInput.command ||
      toolInput.CommandLine ||
      toolInput.path ||
      toolInput.Path ||
      toolInput.file ||
      toolInput.filePath ||
      toolInput.url ||
      toolInput.query;

    if (target && typeof target === 'string') {
      const line = target.trim().split('\n')[0];
      return `${summary} (${line.slice(0, 60)})`;
    }
  }

  return summary;
}

/**
 * Reads all input from stdin.
 */
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', () => {
      resolve(data);
    });

    // Fallback timeout in case stdin stream hangs
    setTimeout(() => {
      resolve(data);
    }, 1000).unref();
  });
}

async function main() {
  try {
    const rawInput = await readStdin();
    let payload = {};

    if (rawInput && rawInput.trim()) {
      try {
        payload = JSON.parse(rawInput.trim());
      } catch {
        payload = { raw: rawInput.trim() };
      }
    } else if (process.argv.length > 2) {
      payload = {
        hook: process.argv[2],
        tool: process.argv[3],
        input: process.argv[4]
      };
    }

    // Determine hook type
    const hookName =
      payload.hook_event_name ||
      payload.hook_event ||
      payload.event ||
      payload.type ||
      payload.action ||
      payload.hook ||
      'PreToolUse';

    // Normalize hook name to PreToolUse / PostToolUse if matching
    const normalizedHook = /post/i.test(hookName) ? 'PostToolUse' : 'PreToolUse';

    // Determine tool name
    const toolName =
      payload.tool_name ||
      payload.tool ||
      payload.name ||
      payload.toolName ||
      'generic_tool';

    // Extract tool input and output
    const toolInput =
      payload.tool_input ||
      payload.input ||
      payload.params ||
      payload.parameters ||
      payload.args ||
      null;

    const toolOutput =
      payload.tool_response ||
      payload.tool_output ||
      payload.response ||
      payload.output ||
      payload.result ||
      null;

    // Determine agent / member name
    const member =
      payload.agent ||
      payload.member ||
      payload.from ||
      payload.sender ||
      process.env.SWARM_AGENT ||
      process.env.ORCA_AGENT ||
      'agent';

    const safeInput = sanitizeHookValue(toolInput);
    const safeOutput = sanitizeHookValue(toolOutput);
    const rawActivity = payload.activity ? sanitizeHookValue(String(payload.activity)) : formatActivity(normalizedHook, toolName, safeInput);

    const eventRecord = {
      type: 'activity',
      hook: normalizedHook,
      member: sanitizeHookValue(String(member)),
      from: sanitizeHookValue(String(member)),
      tool: sanitizeHookValue(String(toolName)),
      activity: rawActivity,
      input: safeInput,
      output: safeOutput,
      timestamp: new Date().toISOString()
    };

    appendEvent(eventRecord);
  } catch (err) {
    console.error('[swarm-hook] Unexpected error:', err);
  } finally {
    process.exit(0);
  }
}

main();
