import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  BRIDGE_TOKEN,
  PresetValidationError,
  buildStandaloneLaunchSpec,
  createServer,
  getLastLaunchedPresetId,
  normalisePresetRecord,
  readPresetsStore,
  saveUserPreset,
  setLastLaunchedPresetId,
  tokenizeAndValidateExtraArgs,
  validatePresetEffort,
  validateProviderBaseUrl,
  validateProviderEnvVar
} from '../bridge/server.mjs';

import {
  clearPendingLaunches,
  consumeMatchingPendingLaunch,
  posixSingleQuote,
  queuePendingLaunch,
  rewriteAgentLaunchEvent,
  validateBridgeRpcInput
} from '../src/worker.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const tempDirs = [];
const openServers = [];

function makeTempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-orca-test-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

after(async () => {
  clearPendingLaunches();
  for (const srv of openServers) {
    await new Promise((resolve) => srv.close(() => resolve()));
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures
    }
  }
});

test('validatePresetEffort accepts strict allowlist and rejects invalid values', () => {
  assert.equal(validatePresetEffort(undefined), '');
  assert.equal(validatePresetEffort(''), '');
  assert.equal(validatePresetEffort('low'), 'low');
  assert.equal(validatePresetEffort(' MEDIUM '), 'medium');
  assert.equal(validatePresetEffort('high'), 'high');
  assert.equal(validatePresetEffort('max'), 'max');

  for (const bad of ['ultra', 'xhigh', 'none', 'high; id', 42, {}]) {
    assert.throws(() => validatePresetEffort(bad), PresetValidationError);
  }
});

test('tokenizeAndValidateExtraArgs tokenizes safely and blocks shell metacharacters', () => {
  assert.deepEqual(tokenizeAndValidateExtraArgs(''), []);
  assert.deepEqual(
    tokenizeAndValidateExtraArgs('--max-turns 5 --system-prompt "be concise" --verbose'),
    ['--max-turns', '5', '--system-prompt', 'be concise', '--verbose']
  );
  assert.deepEqual(
    tokenizeAndValidateExtraArgs(['--max-turns', '3', '--output-format=json']),
    ['--max-turns', '3', '--output-format=json']
  );

  const unsafeInputs = [
    '--max-turns 5; rm -rf /',
    '--flag | cat /etc/passwd',
    '--flag & id',
    '--flag `whoami`',
    '--flag $(whoami)',
    '--flag > /tmp/out',
    '--flag < /etc/passwd',
    '--flag\nrm -rf /',
    '--flag\rid',
    '--flag\x00evil',
    '--flag \\n',
    '--unclosed "quote',
    '--api-key sk-test1234567890'
  ];

  for (const bad of unsafeInputs) {
    assert.throws(
      () => tokenizeAndValidateExtraArgs(bad),
      PresetValidationError,
      `Expected extraArgs to reject: ${JSON.stringify(bad)}`
    );
  }
});

test('validateProviderBaseUrl allows https and local loopback http only, rejecting credentials and unsafe schemes', () => {
  assert.equal(validateProviderBaseUrl(''), '');
  assert.equal(validateProviderBaseUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
  assert.equal(validateProviderBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(validateProviderBaseUrl('http://localhost:8080/v1'), 'http://localhost:8080/v1');

  const unsafeUrls = [
    'http://api.example.com/v1',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.com/file',
    'data:text/plain,hello',
    'https://user:pass@openrouter.ai/api',
    'https://sk-test123@openrouter.ai/api',
    'https://openrouter.ai/api#frag',
    'https://openrouter.ai/api\nHost: evil'
  ];

  for (const bad of unsafeUrls) {
    assert.throws(
      () => validateProviderBaseUrl(bad),
      PresetValidationError,
      `Expected providerBaseUrl to reject: ${bad}`
    );
  }
});

test('validateProviderEnvVar accepts env var names only and rejects literal secrets', () => {
  assert.equal(validateProviderEnvVar(''), '');
  assert.equal(validateProviderEnvVar('OPENROUTER_API_KEY'), 'OPENROUTER_API_KEY');
  assert.equal(validateProviderEnvVar('$ANTHROPIC_API_KEY'), 'ANTHROPIC_API_KEY');
  assert.equal(validateProviderEnvVar(' _CUSTOM_KEY_2 '), '_CUSTOM_KEY_2');

  const rejected = [
    'sk-test123',
    'sk-ant-api03-secretvalue123456',
    'sk-or-v1-secretvalue123456',
    'AIzaSyDummyKey12345678901234',
    'ghp_1234567890abcdef1234567890',
    'xoxb-1234567890-1234567890',
    'OPENROUTER_API_KEY=sk-test123',
    'KEY WITH SPACES',
    '${OPENROUTER_API_KEY}',
    '1_STARTS_WITH_DIGIT',
    'A'.repeat(65),
    'KEY;id'
  ];

  for (const bad of rejected) {
    assert.throws(
      () => validateProviderEnvVar(bad),
      PresetValidationError,
      `Expected providerEnvVar to reject: ${bad}`
    );
  }
});

test('normalisePresetRecord validates new fields and saveUserPreset preserves lastLaunchedPresetId at mode 0o600', () => {
  const presetFile = makeTempFile('presets.json');

  const normalised = normalisePresetRecord({
    id: '@openrouter-claude',
    role: 'OpenRouter Reviewer',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    extraArgs: '--max-turns 8',
    providerBaseUrl: 'https://openrouter.ai/api',
    providerEnvVar: '$OPENROUTER_API_KEY'
  });

  assert.equal(normalised.id, '@openrouter-claude');
  assert.equal(normalised.effort, 'high');
  assert.deepEqual(normalised.extraArgs, ['--max-turns', '8']);
  assert.equal(normalised.providerBaseUrl, 'https://openrouter.ai/api');
  assert.equal(normalised.providerEnvVar, 'OPENROUTER_API_KEY');

  assert.throws(
    () =>
      normalisePresetRecord({
        id: '@bad-secret',
        model: 'claude-sonnet-4-6',
        providerEnvVar: 'sk-test123'
      }),
    PresetValidationError
  );

  saveUserPreset(normalised, presetFile);
  setLastLaunchedPresetId(normalised.key, presetFile);
  saveUserPreset({
    id: '@local-ollama',
    model: 'qwen2.5-coder',
    effort: 'medium',
    providerBaseUrl: 'http://127.0.0.1:11434'
  }, presetFile);

  const store = readPresetsStore(presetFile);
  assert.equal(store.presets.length, 2);
  assert.equal(store.lastLaunchedPresetId, normalised.key);
  assert.equal(getLastLaunchedPresetId(presetFile), normalised.key);

  if (process.platform !== 'win32') {
    const mode = fs.statSync(presetFile).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('HTTP /api/presets and /api/presets/launch reject literal secrets and unsafe URLs with HTTP 400', async () => {
  const server = createServer();
  openServers.push(server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const port = addr.port;

  function postBridge(urlPath, bodyObj) {
    const body = JSON.stringify(bodyObj);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method: 'POST',
          headers: {
            Host: `127.0.0.1:${port}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
            'X-Orca-Swarm-Token': BRIDGE_TOKEN
          }
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  const secretReject = await postBridge('/api/presets', {
    preset: {
      id: '@leak-test',
      model: 'claude-sonnet-4-6',
      providerEnvVar: 'sk-test123'
    }
  });
  assert.equal(secretReject.status, 400);
  assert.equal(secretReject.data.ok, false);
  assert.ok(!JSON.stringify(secretReject.data).includes('sk-test123'));

  const badUrlReject = await postBridge('/api/presets', {
    preset: {
      id: '@bad-url',
      model: 'claude-sonnet-4-6',
      providerBaseUrl: 'http://remote-insecure.example.com'
    }
  });
  assert.equal(badUrlReject.status, 400);
  assert.equal(badUrlReject.data.ok, false);

  const badLaunchReject = await postBridge('/api/presets/launch', {
    preset: {
      id: '@bad-args',
      agent: 'claude',
      model: 'claude-sonnet-4-6',
      extraArgs: '--max-turns 5; id'
    }
  });
  assert.equal(badLaunchReject.status, 400);
  assert.equal(badLaunchReject.data.ok, false);
});

test('command-line building safety: buildStandaloneLaunchSpec, posixSingleQuote, rewriteAgentLaunchEvent, and 15s TTL queue', () => {
  // 1. Standalone spec builds argv array cleanly without shell interpolation
  const spec = buildStandaloneLaunchSpec({
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    extraArgs: '--max-turns 5',
    prompt: 'Review diffs; do not run $(rm -rf /)',
    providerBaseUrl: 'https://openrouter.ai/api',
    providerEnvVar: 'OPENROUTER_API_KEY'
  });
  assert.equal(spec.bin, 'claude');
  assert.deepEqual(spec.args, [
    '--model', 'claude-sonnet-4-6',
    '--effort', 'high',
    '--max-turns', '5',
    '-p', 'Review diffs; do not run $(rm -rf /)'
  ]);
  assert.deepEqual(spec.envPatch, { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' });
  assert.equal(spec.providerEnvVar, 'OPENROUTER_API_KEY');

  assert.throws(
    () => buildStandaloneLaunchSpec({ agent: 'bash', model: 'claude-sonnet-4-6' }),
    PresetValidationError
  );

  // 2. POSIX single-quoting safety
  assert.equal(posixSingleQuote("a'b $(id) `uname`; rm"), "'a'\"'\"'b $(id) `uname`; rm'");

  // 3. agent.launch.before command rewriting never reads process.env[ENV_VAR] into JS
  const prevSecret = process.env.SWARM_TEST_API_KEY;
  process.env.SWARM_TEST_API_KEY = 'sk-super-secret-never-inline';
  try {
    clearPendingLaunches();
    const t0 = 1_700_000_000_000;
    queuePendingLaunch(
      {
        presetId: 'saved:local:openrouter',
        agent: 'claude',
        workspaceId: 'ws-1',
        model: 'claude-opus-4-6',
        effort: 'max',
        extraArgs: ['--max-turns', '4'],
        providerBaseUrl: 'https://openrouter.ai/api',
        providerEnvVar: 'SWARM_TEST_API_KEY',
        ttlMs: 15_000
      },
      t0
    );

    // Expired after 15s TTL
    assert.equal(
      consumeMatchingPendingLaunch({ agent: 'claude', workspaceId: 'ws-1' }, t0 + 15_001),
      null
    );

    // Re-queue and consume within TTL
    queuePendingLaunch(
      {
        presetId: 'saved:local:openrouter',
        agent: 'claude',
        workspaceId: 'ws-1',
        model: 'claude-opus-4-6',
        effort: 'max',
        extraArgs: ['--max-turns', '4'],
        providerBaseUrl: 'https://openrouter.ai/api',
        providerEnvVar: 'SWARM_TEST_API_KEY',
        ttlMs: 15_000
      },
      t0
    );

    const matched = consumeMatchingPendingLaunch({ agent: 'claude', workspaceId: 'ws-1' }, t0 + 5_000);
    assert.ok(matched);
    // Consumed once only
    assert.equal(consumeMatchingPendingLaunch({ agent: 'claude', workspaceId: 'ws-1' }, t0 + 5_001), null);

    const rewritten = rewriteAgentLaunchEvent(
      {
        agent: 'claude',
        workspaceId: 'ws-1',
        workspaceKind: 'worktree',
        command: "claude --model 'old-model' -- 'fix the bug'",
        env: {}
      },
      matched
    );

    assert.equal(
      rewritten.command,
      `ANTHROPIC_BASE_URL='https://openrouter.ai/api' ANTHROPIC_API_KEY="$SWARM_TEST_API_KEY" claude --model 'claude-opus-4-6' --effort 'max' '--max-turns' '4' -- 'fix the bug'`
    );
    assert.ok(!rewritten.command.includes('sk-super-secret-never-inline'));
  } finally {
    if (prevSecret === undefined) {
      delete process.env.SWARM_TEST_API_KEY;
    } else {
      process.env.SWARM_TEST_API_KEY = prevSecret;
    }
    clearPendingLaunches();
  }

  // 4. Panel RPC allowlist includes preset launch & relaunch endpoints
  assert.equal(validateBridgeRpcInput({ method: 'POST', path: '/api/presets/launch', body: { presetId: 'builtin:coder' } }).pathname, '/api/presets/launch');
  assert.equal(validateBridgeRpcInput({ method: 'POST', path: '/api/presets/relaunch-last', body: {} }).pathname, '/api/presets/relaunch-last');
  assert.throws(() => validateBridgeRpcInput({ method: 'POST', path: '/api/unknown', body: {} }));
});

test('zero-telemetry static audit: no external network URLs or telemetry in server.mjs, worker.ts, or index.html', () => {
  const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'bridge', 'server.mjs'), 'utf8');
  const workerSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'worker.ts'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(REPO_ROOT, 'bridge', 'public', 'index.html'), 'utf8');

  const urlMatchesServer = serverSrc.match(/https?:\/\/[^\s'"`)>]+/g) || [];
  for (const u of urlMatchesServer) {
    assert.match(
      u,
      /^http:\/\/(?:127\.0\.0\.1|localhost|\$\{displayHost\})/,
      `Unexpected external URL in bridge/server.mjs: ${u}`
    );
  }

  const urlMatchesWorker = workerSrc.match(/https?:\/\/[^\s'"`)>]+/g) || [];
  for (const u of urlMatchesWorker) {
    assert.match(
      u,
      /^http:\/\/(?:127\.0\.0\.1|localhost)/,
      `Unexpected external URL in src/worker.ts: ${u}`
    );
  }

  // index.html must contain zero external script/stylesheet/font/CDN/telemetry URLs
  const externalResourceTags = htmlSrc.match(/<(?:script|link|img|iframe|source)\b[^>]*\b(?:src|href)\s*=\s*["']https?:\/\//gi) || [];
  assert.deepEqual(externalResourceTags, []);

  assert.doesNotMatch(
    htmlSrc,
    /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|googletagmanager|google-analytics|posthog|sentry\.io|mixpanel|segment\.io|nikolasgannon\.com)/i
  );

  // Neither worker.ts nor server.mjs code may dynamically read process.env[userVar]
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(stripComments(workerSrc), /process\.env\s*\[/);
  assert.doesNotMatch(stripComments(serverSrc), /process\.env\s*\[/);
});
