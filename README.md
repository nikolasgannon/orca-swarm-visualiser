# Swarm Visualiser for Orca

An open-source add-on for [Orca ADE](https://github.com/stablyai/orca) under an MIT licence. It polls Orca worktrees and terminals to detect active coding agents, discovers local agent profiles and presets, and streams live activity through an HTTP and SSE event bridge to an interactive browser canvas with a standalone demo mode.

Built for multi-agent coding sessions where keeping Git worktrees tidy and avoiding overlapping edits matters.

## What it does

- **Live Orca workspace polling**: Tracks active projects, Git worktrees, subagents, and live terminal sessions, automatically following the workspace focused in Orca.
- **Cross-worktree file collision map**: Inspects modified files per worktree, highlights overlapping edits across branches, and lets you send review prompts or launch a hand-off check.
- **Direct terminal steering and hand-offs**: Send prompts straight to live agent terminals or start a follow-up agent in the same worktree or a new sibling worktree.
- **Live model and quota discovery**: Discovers locally installed CLI models across Claude, Codex, OpenCode, and Gemini alongside Orca provider quota status through a searchable dropdown picker.
- **Live mention dispatch**: Tag agents with `@handle` or group tags in the composer to route prompts to live terminals or launch bound worktree agents.
- **Sidepanel-friendly Simple and Dev modes**: Switch between plain-English labels (`Simple`) and technical Git/CLI terminology (`Dev`) inside the settings menu while keeping the same controls.
- **Dynamic agent profile discovery**: Scans `~/.claude/agents`, `~/.config/opencode/agent`, `~/.codex/agents`, `~/.agents/agents`, project agent folders, and `~/.orca-swarm/presets.json`.
- **Standalone HTTP and SSE bridge**: Zero-dependency Node.js server on port `4319` (`GET /api/snapshot`, `GET /api/models`, `POST /events`, `POST /api/dispatch-mentions`, `POST /api/handoff`, `POST /api/terminal/send`), with offline demo mode when Orca is not running.

## Quick start

### 1. Install as an Orca extension

```bash
orca plugin install nikolasgannon/orca-swarm-visualiser
```

Orca prints an explicit `--approve <fingerprint>` command on first install. Re-run with that flag to grant `agent:read` access, then run the `Swarm: Open Swarm Visualiser` command in Orca (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux).

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

Scripts, CLI hooks, or agent runners can push posts and tool activity straight to the canvas.

### Post a board update

```bash
curl -X POST http://127.0.0.1:4319/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "swarm:post",
    "from": "@coder",
    "to": ["@verifier"],
    "text": "Completed authentication middleware update. Tests passing."
  }'
```

### Log a tool event

```bash
curl -X POST http://127.0.0.1:4319/events \
  -H "Content-Type: application/json" \
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

## Project structure

- `orca-plugin.json`: Orca v2 plugin manifest (`trusted-worker`).
- `tsconfig.json`: TypeScript configuration for Orca plugin typings.
- `src/worker.ts`: Orca plugin worker (bridge launcher and command registration).
- `bridge/server.mjs`: Zero-dependency HTTP/SSE bridge, Orca poller, and CLI discovery server.
- `bridge/public/index.html`: Single-file canvas UI with Simple/Dev language modes and demo mode.
- `hooks/swarm-hook.mjs`: CLI tool hook for external agent logging.

## Author and licence

Maintained by [Nikolas Gannon](https://www.nikolasgannon.com.au) (`hello@nikolasgannon.com.au`). Questions and bug reports live in [GitHub Issues](https://github.com/nikolasgannon/orca-swarm-visualiser/issues).

Released under the [MIT Licence](./LICENSE).
