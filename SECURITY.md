# Security Policy

## Local-first and zero-telemetry guarantee

Swarm Visualiser runs strictly on your own machine. Nothing is sent back to the author, Stably, or any external analytics, telemetry, or CDN server.

- **Zero outbound network requests**: Neither `src/worker.ts`, `bridge/server.mjs`, `bridge/public/index.html`, nor `hooks/swarm-hook.mjs` makes external HTTP requests, loads remote fonts or scripts, or embeds analytics SDKs. `GET /api/health` reports `zeroTelemetry: true`, and `tests/presets-and-security.test.mjs` runs a static check for unexpected external URLs and dynamic `process.env[...]` lookups.
- **Loopback-only binding**: `bridge/server.mjs` listens only on `127.0.0.1:4319` (`ORCA_SWARM_HOST=127.0.0.1`) by default, and the worker IPC server in `src/worker.ts` binds to `127.0.0.1` on an ephemeral port (`0`), blocking LAN and external network access.
- **DNS rebinding and CORS protection**: Incoming requests must pass strict `Host`, `Origin`, and `Sec-Fetch-Site` allowlists (`127.0.0.1`, `localhost`, or `[::1]` on the active port). Wildcard `Access-Control-Allow-Origin: *` is disabled, and the worker IPC server rejects any request carrying an `Origin` header.
- **Per-session tokens**: On startup, the bridge generates a random 32-byte `X-Orca-Swarm-Token` (overridable via `ORCA_SWARM_TOKEN`), injects it into the local UI with `Cache-Control: no-store`, and writes it with `0600` permissions to `~/.orca-swarm/bridge.token`. All state-changing `POST` endpoints (`/events`, `/api/members`, `/api/presets`, `/api/presets/launch`, `/api/presets/relaunch-last`, `/api/dispatch-mentions`, `/api/files/open-diff`, `/api/terminal/send`, `/api/terminal/focus`, `/api/sessions/resume`, and `/api/handoff`) require a matching token via `timingSafeEqual`. Worker IPC uses a separate 32-byte `X-Orca-Worker-Token` stored at `0600` in `~/.orca-swarm/worker-ipc.json`.
- **No stored secrets in presets**: Presets use a `$ENV_VAR` reference rule in `providerEnvVar`, accepting only an environment variable name matching `/^[A-Za-z_][A-Za-z0-9_]{1,63}$/`. Literal API keys (`sk-*`, `AIza*`, `ghp_*`, `xoxb-*`, etc.), `=`, spaces, and `${...}` expressions are rejected with HTTP `400` (`code: "invalid_preset"`) before any disk write or launch. Neither `src/worker.ts` nor `bridge/server.mjs` reads `process.env[VAR_NAME]` into JavaScript. When `agent.launch.before` rewrites a launch command for Anthropic-compatible agents, it writes `ANTHROPIC_API_KEY="$VAR_NAME"` so the local terminal shell expands the variable at runtime.
- **Validated preset flags and URLs**: `effort` uses a strict allowlist (`""`, `low`, `medium`, `high`, `max`). `extraArgs` allows at most 24 tokens (1024 chars total) and blocks control characters, unclosed quotes, literal secrets, and shell metacharacters (`; | & $ ( ) < > \ \r \n`). `providerBaseUrl` accepts only `https://` or loopback `http://` (`127.0.0.1`, `localhost`, `[::1]`) with zero embedded credentials or URL fragments. Pending preset launches queued for `agent.launch.before` expire after 15 seconds and are consumed at most once.
- **Subprocess and path hardening**: Subprocesses run via `execFile` with `shell: false`, `agent.launch.before` uses POSIX single-quoting (`posixSingleQuote`), and terminal and model arguments reject leading flag dashes and control characters. Worktree paths are validated against live Orca worktrees, static asset serving verifies `realpath` containment inside `bridge/public`, and `bridge.rpc` enforces strict `GET`/`POST` allowlists plus a `64 KiB` input cap and `960 KiB` response cap.
- **Restricted state directory and redaction**: `~/.orca-swarm` is created with mode `0700`, and `events.jsonl`, `presets.json`, `bridge.token`, and `worker-ipc.json` use mode `0600`. API keys, bearer tokens, JWTs, private key blocks, email addresses, and credential URLs are scrubbed before logging or serving state.
- **Browser hardening headers**: The local UI is served with system fonts, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy`, and a strict local `Content-Security-Policy`.

## Declared Orca capabilities

| Capability | Purpose |
|---|---|
| `agent:read` | Read live Orca agent states, subagents, and terminal status for the graph and status bar. |
| `workspace:read` | Read open project and Git worktree paths and follow the focused workspace. |
| `history:read` | List local Orca-supported agent sessions and resume selected sessions. |
| `agent:launch` | Launch presets and hand-offs via `orca agent launch` and modify flags in `agent.launch.before`. |

The manifest uses `execution: "trusted-worker"` so `src/worker.ts` can start the local `bridge/server.mjs` Node.js bridge, register `agent.launch.before`, and run `orca tab create` for the `Pop Out` tab.

## Safe operating guidelines for users

1. Review the Orca capability prompt before approving `trusted-worker` execution and the four capabilities listed above.
2. Keep `~/.orca-swarm/bridge.token` and `~/.orca-swarm/worker-ipc.json` private. Never commit them or paste them into public logs.
3. Put only environment variable names (such as `OPENROUTER_API_KEY`) in preset `providerEnvVar` fields, never raw keys.
4. Keep `ORCA_SWARM_HOST` on `127.0.0.1`. Binding port `4319` to a LAN or public interface exposes local terminal steering to anyone who obtains `bridge.token`.
5. Review the [MIT Licence](./LICENSE). This software is provided as is, without warranty or liability for local environment modifications.

## Reporting a vulnerability

If you find a security issue, email `hello@nikolasgannon.com.au` before opening a public issue so it can be patched cleanly. This address is solely for private vulnerability reports, and Swarm Visualiser never contacts it at runtime.
