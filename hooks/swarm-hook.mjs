#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EVENTS_FILE = path.join(os.homedir(), '.orca-swarm', 'events.jsonl');

/**
 * Appends an event object as a JSON line to ~/.orca-swarm/events.jsonl.
 */
function appendEvent(eventData) {
  try {
    const dir = path.dirname(EVENTS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(eventData) + '\n', 'utf8');
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

    const activity = payload.activity || formatActivity(normalizedHook, toolName, toolInput);

    const eventRecord = {
      type: 'activity',
      hook: normalizedHook,
      member,
      from: member,
      tool: toolName,
      activity,
      input: toolInput,
      output: toolOutput,
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
