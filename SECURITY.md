# Security Policy

## Local-first security model

Swarm Visualiser for Orca runs strictly on your own machine. It does not upload telemetry, prompts, repository contents, or presets to external servers.

- **Loopback-only binding**: By default, `bridge/server.mjs` listens only on `127.0.0.1:4319` (`ORCA_SWARM_HOST=127.0.0.1`), so other machines on your local network cannot connect.
- **DNS rebinding and CORS protection**: Incoming requests must pass strict `Host`, `Origin`, and `Sec-Fetch-Site` allowlists (`127.0.0.1`, `localhost`, or `[::1]` on the active port). Wildcard `Access-Control-Allow-Origin: *` is disabled.
- **Per-session CSRF and write token**: On startup, the bridge generates a random 32-byte `X-Orca-Swarm-Token` (overridable via `ORCA_SWARM_TOKEN`), injects it into the local UI with `Cache-Control: no-store`, and writes it with `0600` permissions to `~/.orca-swarm/bridge.token`. All state-changing `POST` endpoints (`/events`, `/api/members`, `/api/presets`, `/api/dispatch-mentions`, `/api/files/open-diff`, `/api/terminal/send`, and `/api/handoff`) reject requests without a matching token.
- **Subprocess and path hardening**: Subprocesses use `execFile` without shell interpolation, terminal and model arguments reject leading flag dashes, worktree paths are checked against live Orca worktrees, and static asset serving verifies `realpath` containment inside `bridge/public`.
- **Restricted state directory and secret redaction**: `~/.orca-swarm` is created with `0700` permissions and its files (`events.jsonl`, `presets.json`, `bridge.token`) with `0600` permissions. Common API keys, bearer tokens, JWTs, private key blocks, emails, and credential URLs are scrubbed before logging or serving state.
- **Zero external font or CDN requests**: The UI loads offline from `127.0.0.1` with system fonts, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, and a local `Content-Security-Policy`.

## Safe operating guidelines for users

1. Review the Orca approval prompt. This plugin requests `trusted-worker` execution (`agent:read`) so it can launch the local Node.js bridge and run `orca tab create`. Only approve plugins whose source you have checked.
2. Keep `bridge.token` private. Never commit `~/.orca-swarm/bridge.token` or paste it into public logs.
3. Do not expose port `4319` to untrusted networks. Overriding `ORCA_SWARM_HOST` to a public or LAN address exposes terminal control to anyone who obtains `bridge.token`.
4. Review the [MIT Licence](./LICENSE). This software is provided "as is", without warranty or liability for misuse or local environment modifications.

## Reporting a vulnerability

If you find a security issue, email `hello@nikolasgannon.com.au` before opening a public issue so it can be patched cleanly.
