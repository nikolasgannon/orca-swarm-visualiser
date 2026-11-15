# Swarm Visualiser for Orca

An open-source add-on for [Orca ADE](https://github.com/stablyai/orca) under an MIT licence. It polls Orca worktrees and terminals to detect active coding agents, discovers local agent profiles and presets, and streams live activity through an HTTP and SSE event bridge to an interactive browser canvas with a standalone demo mode.

Built for multi-agent coding sessions where keeping Git worktrees tidy and avoiding overlapping edits matters.

## What it does

- **Live Orca workspace polling**: Tracks active projects, Git worktrees, subagents, and live terminal sessions, automatically following the workspace focused in Orca. Polls at `1.5s` when browser clients are connected, backs off to `15s` when idle, and refreshes right away on Orca workspace or agent status events.
- **Outcome badges and session resume**: Displays agent run outcomes (`completed`, `failed`, `stopped`) and session IDs, lists recent past sessions (`GET /api/sessions` via local worker IPC with `orca search` keyword fallback), and resumes stopped sessions in one click (`POST /api/sessions/resume`).
- **Cross-worktree file collision map**: Inspects modified files per worktree, highlights overlapping edits across branches, and lets you send review prompts or launch a hand-off check.
- **Direct terminal steering, focus, and hand-offs**: Send prompts straight to live agent terminals, jump to a terminal or workspace in Orca with single-click focus (`POST /api/terminal/focus`), or start a follow-up agent in the same worktree or a new sibling worktree.
- **Live model and quota discovery**: Discovers locally installed CLI models across Claude, Codex, OpenCode, and Gemini alongside Orca provider quota status through a searchable dropdown picker.
- **Live mention dispatch**: Tag agents with `@handle` or group tags in the composer to route prompts to live terminals or launch bound worktree agents.
- **Sidepanel-friendly Simple and Dev modes**: Switch between plain-English labels (`Simple`) and technical Git/CLI terminology (`Dev`) inside the settings menu while keeping the same controls.
- **Dynamic agent profile discovery**: Scans `~/.claude/agents`, `~/.config/opencode/agent`, `~/.codex/agents`, `~/.agents/agents`, project agent folders, and `~/.orca-swarm/presets.json`.
- **Standalone HTTP and SSE bridge**: Zero-dependency Node.js server on port `4319` (`GET /api/snapshot`, `GET /api/models`, `GET /api/sessions`, `POST /events`, `POST /api/dispatch-mentions`, `POST /api/handoff`, `POST /api/terminal/send`, `POST /api/terminal/focus`, `POST /api/sessions/resume`), with offline demo mode when Orca is not running.

## Quick start

### 1. Install as an Orca extension

```bash
orca plugin install nikolasgannon/orca-swarm-visualiser
```

Orca prints an explicit `--approve <fingerprint>` command on first install. Re-run with that flag to grant `agent:read`, `workspace:read`, `history:read`, and `agent:launch` access (Orca `1.4.259+`), then click `Swarm` in Orca's status bar or run `Swarm: Open Swarm Visualiser` in the quick palette (`Cmd+J` on macOS, `Ctrl+J` on Windows/Linux).

### 2. Local development in Orca

```bash
orca plugin validate .
orca plugin dev load .
```

Re-run `dev load` with the printed `--approve` flag, then launch `Swarm: Open Swarm Visualiser` or open a split tab:

```bash
orca tab create --url http://127.0.0.1:4319
```

### 3. Standalone browser server

```bash
cd orca-swarm-visualiser
node bridge/server.mjs
```

Open [http://127.0.0.1:4319](http://127.0.0.1:4319).

## Event webhook API

Scripts, CLI hooks, or agent runners can append lines directly to `~/.orca-swarm/events.jsonl` or post over `127.0.0.1` using the session token in `~/.orca-swarm/bridge.token`.

### Post a board update

```bash
TOKEN=$(cat ~/.orca-swarm/bridge.token)
curl -X POST http://127.0.0.1:4319/events \
  -H "Content-Type: application/json" \
  -H "X-Orca-Swarm-Token: $TOKEN" \
  -d '{
    "type": "swarm:post",
    "from": "@coder",
    "to": ["@verifier"],
    "text": "Completed authentication middleware update. Tests passing."
  }'
```

### Log a tool event

```bash
TOKEN=$(cat ~/.orca-swarm/bridge.token)
curl -X POST http://127.0.0.1:4319/events \
  -H "Content-Type: application/json" \
  -H "X-Orca-Swarm-Token: $TOKEN" \
  -d '{
    "type": "swarm:activity",
    "activity": {
      "id": "act-101",
      "agentId": "@coder",
      "tool": "git.commit",
      "cmd": "git commit -m \"feat: auth middleware\"",
      "status": "ok",
      "durationSec": 2
    }
  }'
```

## Security model

- **Loopback binding**: Listens on `127.0.0.1` only by default (`ORCA_SWARM_HOST=127.0.0.1`), blocking LAN access.
- **DNS rebinding and CORS checks**: Rejects foreign `Host`, `Origin`, and cross-site browser requests with no wildcard CORS.
- **Per-run token and redaction**: Requires a `0600` `X-Orca-Swarm-Token` on all `POST` endpoints, scrubs common API keys and credentials from hook and event logs, and runs zero external fonts or telemetry.
- **Threat model and disclosure**: Read [SECURITY.md](./SECURITY.md) for security controls and vulnerability reporting.

## Project structure

- `orca-plugin.json`: Orca v2 plugin manifest (`0.2.1`, `trusted-worker`, `engines.orca >=1.4.259`).
- `tsconfig.json`: TypeScript configuration for Orca plugin typings.
- `src/worker.ts`: Orca plugin worker (bridge launcher, command registration, event forwarding, and loopback session IPC).
- `bridge/server.mjs`: Zero-dependency HTTP/SSE bridge, Orca poller, and CLI discovery server.
- `bridge/public/index.html`: Single-file canvas UI with Simple/Dev language modes and demo mode.
- `hooks/swarm-hook.mjs`: CLI tool hook for external agent logging.
- `SECURITY.md`: Security architecture, user safeguards, and vulnerability disclosure policy.

## Author and licence

Maintained by [Nikolas Gannon](https://www.nikolasgannon.com.au) (`hello@nikolasgannon.com.au`). Questions and bug reports live in [GitHub Issues](https://github.com/nikolasgannon/orca-swarm-visualiser/issues).

Released under the [MIT Licence](./LICENSE).
