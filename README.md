# claude-pty-acp

**English** · [简体中文](./README.zh-CN.md)

Expose **interactive Claude Code** as a standard **ACP ([Agent Client Protocol](https://agentclientprotocol.com)) agent**, so third-party clients (Zed / JetBrains / neovim / your own service) can connect over a standard protocol — **while usage still counts against your Claude subscription (Pro/Max) instead of being billed separately as API/SDK credits**.

It is a plain stdio ACP agent: any ACP-compatible client spawns it as a subprocess and talks JSON-RPC over stdio. No private interfaces, no special-casing — if a client can drive the official `claude-agent-acp`, it can drive this, unchanged.

## Why this exists

Since 2026-06-15, Anthropic splits billing into two pools:

- **Stays on the subscription**: **interactive** Claude Code in your terminal/IDE, and Claude web/desktop/mobile.
- **Moves to separate Agent SDK credits**: `claude -p`, the Agent SDK, GitHub Actions, and **every third-party app that authenticates through the SDK** — including the official ACP adapter `claude-agent-acp`, which is SDK-based under the hood.

So the official `claude-agent-acp` = **ACP + SDK** (consumes credits).
`claude-pty-acp` = **ACP + interactive PTY** (stays on the subscription): the protocol shape is identical, so off-the-shelf ACP clients (Zed, neovim, …) connect with zero changes, but the backend runs a real interactive `claude` process and the usage lands on your subscription.

## Install

Prerequisites: **the `claude` CLI installed and logged in to your subscription** (this drives a real interactive `claude`; that's what keeps usage on the subscription path), and **Node.js ≥ 20**.

### From npm (recommended)

```bash
npm install -g claude-pty-acp
```

This installs a global **`claude-pty-acp`** command — that's the binary your ACP client will run. The package ships the compiled `dist/`, so there's nothing to build; the postinstall step also fixes node-pty's spawn-helper exec bit automatically.

Useful afterwards:

```bash
which claude-pty-acp                 # absolute path (handy for GUI clients with a trimmed PATH)
npm install -g claude-pty-acp@latest # upgrade
npm uninstall -g claude-pty-acp      # remove
```

Then point your client at it — see [Use it in an ACP client](#use-it-in-an-acp-client).

### From source (for development)

```bash
git clone https://github.com/modelzen/claude-pty-acp.git
cd claude-pty-acp
npm install      # postinstall fixes node-pty's spawn-helper exec bit automatically
npm run build    # compile to dist/ (clients run `node dist/index.js`)
```

During development you can also run it straight from source with `npm start` (= `tsx src/index.ts`).

> Binary resolution order for the underlying `claude`: `CC_CLAUDE_BIN` → `PATH` → common locations like `~/.local/bin/claude`. GUI launchers (e.g. Zed) often start with a trimmed `PATH`, so it falls back to common install paths to avoid a bare `claude` not being found.

## Use it in an ACP client

`claude-pty-acp` is launched **by the client as a subprocess**. You do not start it yourself or keep it running — the client spawns it when you open an agent session and reclaims it when you're done. You only need the built artifact to exist and point the client at it.

### Zed

Register it as a custom ACP agent in Zed's `settings.json`. With the npm global install, just point at the `claude-pty-acp` command:

```json
{
  "agent_servers": {
    "Claude Code (claude-pty-acp)": {
      "command": "claude-pty-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Then open Zed's **Agent panel**, pick **"Claude Code (claude-pty-acp)"**, and chat. It behaves exactly like the official `claude-agent-acp` — the only difference is billing goes through your subscription.

Notes:

- If Zed can't find `claude-pty-acp` (GUI apps often start with a trimmed `PATH`), use its absolute path from `which claude-pty-acp`:
  ```json
  { "command": "/ABS/PATH/to/claude-pty-acp", "args": [], "env": {} }
  ```
- Running from source instead of npm? Point at the built entry: `{ "command": "node", "args": ["/ABS/PATH/claude-pty-acp/dist/index.js"] }` (if `node` isn't on Zed's PATH, use its absolute path from `which node`).
- Zed does not implement the optional streaming-preview extension, so it runs in **`thought` mode**: the speculative preview shows up in the collapsible thought area, and the final answer arrives as authoritative message blocks (see [Streaming](#streaming-fast-preview--authoritative-final)). No duplicated text.
- Pass any environment variable (see [Environment variables](#environment-variables)) via the `env` object, e.g. `"env": { "CC_PERMISSION_MODE": "acceptEdits" }`.

### neovim

Use a custom ACP agent in CodeCompanion / avante. The command and args are the same as Zed's:

```
command: claude-pty-acp     # or the absolute path from `which claude-pty-acp`
args:    []
```

### Any other ACP client (or your own)

Because it speaks nothing but standard ACP over stdio, any ACP client drives it the same way: **spawn `claude-pty-acp` and talk JSON-RPC over its stdin/stdout** (newline-delimited). `stdout` is the protocol channel — all logging goes to `stderr`. (From source instead of the npm install, spawn `node /ABS/PATH/claude-pty-acp/dist/index.js`.)

A minimal way to see the exact protocol path a client would take is the bundled test client:

```bash
node test-client.mjs 'introduce yourself in one sentence' /path/to/workdir
# or with tool streaming:
CC_PERMISSION_MODE=bypassPermissions node test-client.mjs 'read the first line of README.md' .
```

It uses the SDK's `ClientSideConnection` to run the full ACP handshake, spawns `claude-pty-acp`, sends a prompt, and prints every `session/update` live — exactly the path Zed/neovim follow.

### Confirm it's on the subscription path

While a session is running, confirm the spawned child is interactive:

```bash
ps -ax -o pid,command | grep -- '--session-id' | grep claude
# expected: claude --session-id <uuid> --permission-mode default
# no -p/--print; and no ANTHROPIC_API_KEY in the env → uses subscription OAuth credentials
```

Going further: after a few turns, watch your subscription usage rise while Agent SDK credits stay flat (post 6/15), and seamlessly take over the same session in your terminal with `claude --resume <uuid>` (the transcript is shared).

## Architecture

```
ACP client (Zed / neovim / test-client)
   │  JSON-RPC over stdio  (initialize / session/new / session/prompt / session/update …)
   ▼
claude-pty-acp  ── src/index.ts          ACP framing (ndJsonStream + AgentSideConnection)
           ── src/acp-agent.ts      Agent interface; transcript blocks → session/update; permission broker
           ── src/claude-pty.ts     spawns interactive `claude` (no -p) inside node-pty
           ── src/permission-hook.mjs  PermissionRequest hook bridge (claude → unix socket)
   │
   ├─ input:  inject prompt via bracketed-paste → PTY stdin
   ├─ output: tail ~/.claude/projects/<proj>/<session-id>.jsonl (structured, zero ANSI parsing)
   ├─ perms:  claude's PermissionRequest hook ──unix socket──▶ claude-pty-acp
   │          ──▶ ACP session/request_permission ──▶ client dialog ──▶ decision back: allow/deny
   └─ proc:   claude --session-id <uuid> --permission-mode default   ← interactive, subscription path
```

### Streaming: fast preview + authoritative final

Replies use two sources with separate responsibilities, getting both "fast first token" and "verbatim-correct final":

- **Preview channel `agent_thought_chunk`**: reconstructs the TUI screen from the raw PTY byte stream using a headless terminal grid (`@xterm/headless`) and emits the in-progress reply **line by line, early** (see `src/grid-preview.ts`). This is the **fast first token** — measured seconds ahead of the block-level transcript flush (for a three-paragraph prose reply: preview first line ~8.6s vs authoritative final ~14s). It's a rendered artifact and tolerant of noise (may miss code fences), so it only feeds the "draft" thought area.
- **Authoritative channel `agent_message_chunk`**: the **block-level authoritative text** from the transcript JSONL (each thinking / text / tool_use block flushes once complete), byte-for-byte equal to `claude`, preserving fences/indentation/markdown. This is the **final answer** the user sees.

"No garbled stream" is a **structural guarantee**: the final answer comes only from the transcript, so any defect in the grid preview is confined to the thought area and can never reach the real reply. The preview merely covers the wait for authoritative text with a live draft. To keep long replies from scrolling out of view (Ink repaints in place and never truly scrolls), the PTY uses a very tall `rows` (default 1000) so the grid captures the whole reply in a single frame — no fragile cross-frame stitching.

> Note: the grid preview and ACP `agent_thought_chunk` are append-only, and Zed appends message chunks (re-sending a full block duplicates it). So "preview then correct" relies on **channel separation**, not on replacing already-sent content.

#### Optional extension: streaming preview + final full replace (`_meta`)

To let capable clients stream the **preview directly into the real reply bubble** (typewriter feel) and then **fully replace** it with authoritative text, this project adds a **backward-compatible** extension on ACP's official `_meta` escape hatch (clients that don't understand it just ignore `_meta`, fall back safely, and never duplicate):

- **Client opt-in** (`clientCapabilities._meta` in `initialize`):
  ```json
  { "claude-pty-acp/streaming-preview": { "provisionalReplace": true } }
  ```
  The agent echoes `{ provisionalReplace: true, version: 1 }` under the same key in `agentCapabilities._meta` to confirm availability.
- **Provisional streaming chunk**: an `agent_message_chunk` in `session/update`, with `SessionNotification._meta` carrying `{ "claude-pty-acp/streaming-preview": { "provisional": true, "turn": N } }`. The client should render it live and remember it may be replaced.
- **Final replace chunk**: one `agent_message_chunk` at turn end, `_meta` carrying `{ "claude-pty-acp/streaming-preview": { "replaceProvisional": true, "turn": N } }`, whose `content` is the **verbatim authoritative full text**. On receipt the client should **discard all provisional chunks for that turn and render this instead**.
- **Session-ended signal**: when the claude child **exits unexpectedly** (crash), it sends an `agent_message_chunk` (empty `content`) with `_meta` carrying `{ "claude-pty-acp/streaming-preview": { "sessionEnded": true, "code": …, "signal": … } }`. An opt-in client should mark the session ended and prompt the user to reopen (resume via `loadSession` with the stored sessionId), instead of waiting for the next `prompt` to throw `unknown session`. An explicit `session/close` does not emit this signal.

Three modes (`CC_PREVIEW` env var force-overrides; otherwise auto-selected by client capability):

| Mode | Trigger | Where preview goes | For |
|---|---|---|---|
| `replace` | client opt-in or `CC_PREVIEW=replace` | real bubble (provisional) → full replace at turn end | clients implementing this extension (e.g. a custom bridge) |
| `thought` | default (no opt-in, e.g. Zed) | thought area (`agent_thought_chunk`) | any standard ACP client, zero duplication |
| `off` | `CC_PREVIEW=off` | no preview sent | block-level authoritative only, cleanest |

> Zed doesn't implement this extension today, so in Zed it's `thought` mode (preview in the collapsed thought area, final answer still arrives as whole blocks). To get the typewriter effect inside the real bubble, the client must implement the provisional/replace contract above — exactly what a custom client/bridge should do.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CC_CLAUDE_BIN` | auto-resolved | path to the claude binary (overrides auto-resolution; set an absolute path in GUI environments) |
| `CC_MODEL` | claude's default | passed to `--model` |
| `CC_PERMISSION_MODE` | `default` | `default`/`acceptEdits`/`bypassPermissions`/`plan`/`dontAsk`/`auto` |
| `CC_PREVIEW` | auto by client capability | streaming preview mode `replace`/`thought`/`off` (see [streaming extension](#optional-extension-streaming-preview--final-full-replace-_meta)) |
| `CC_TURN_TIMEOUT_MS` | `0` (off) | per-turn timeout fallback in ms: a turn that exceeds it is interrupted and finalized as `cancelled`. Recommended for long-running services (e.g. a chat bridge), e.g. `600000`, to keep a stuck turn from hanging forever. |

In `default` mode, tools that need approval (Write/Edit/Bash, …) are forwarded through the permission broker to the ACP client's dialog, which decides allow/deny (see [Implemented](#implemented-all-verified-end-to-end)). Safe read-only tools are auto-approved by Claude Code without interrupting you.

## Implemented (all verified end-to-end)

- **Phase 1 — streaming chat + streaming tools**: ACP client → claude-pty-acp → interactive claude (PTY, no -p) → transcript blocks → `session/update`. Conversation and multi-turn agentic (Bash/Read/Write) tool calls all stream.
- **Phase 2 — permission forwarding**: claude's `PermissionRequest` hook → unix socket → claude-pty-acp → `connection.requestPermission(...)` → ACP client dialog → decision back: allow/deny. Both allow and deny paths verified (see `probe-perm.mjs`).
- **Phase 3 — session resume**: ACP `loadSession` + `claude --resume <id>`. A fresh process restores an old session, replays transcript history (user/assistant/tool calls) to the client, and memory survives a claude-pty-acp restart. Verified by `test-resume.mjs` (set a secret → kill process → new process loadSession → recall succeeds).
- **Image input**: an ACP `image` content block is materialized to a temp file, and its absolute path is injected on its own line via bracketed-paste; the interactive TUI reads the image automatically (`usePasteHandler` → `isImageFilePath`), pure byte stream, no clipboard. `promptCapabilities.image=true`.
- **Client MCP forwarding**: `newSession.mcpServers` (stdio/http/sse) maps to `claude --mcp-config '<json>'` launch args; `additionalDirectories` → `--add-dir`. Declares `mcpCapabilities{http,sse}`. New sessions only.
- **Plan (task progress)**: claude's `TaskCreate`/`TaskUpdate` (incremental) and the legacy `TodoWrite` (snapshot) accumulate into a session task table, re-emitted each time as `session/update:plan` (PlanEntry with pending/in_progress/completed status) instead of being shown as a plain tool_call.
- **Robustness**: cwd normalization (/tmp→/private/tmp, avoids trust-dialog reprompts), trust-dialog auto-confirm fallback, multi-path claude binary resolution (for Zed's trimmed PATH), node-pty spawn-helper exec-bit fix in postinstall, child claude reaped on exit, cancel→`cancelled` stopReason, compilable dist artifact.

## ACP compliance

`claude-pty-acp` is a **standard stdio ACP agent** that speaks only ACP (JSON-RPC over stdio) and exposes no private interfaces — so any ACP client (Zed, neovim, and a future general ACP↔chat bridge) spawns it the same way.

- **All required methods** implemented: `initialize` / `newSession` / `authenticate` / `prompt` / `cancel`.
- **Optional capabilities**: `loadSession` and `session/close` (`sessionCapabilities.close`, to actively reclaim a single session's claude process — for long-running servers) are declared and implemented. Other optional methods (modes/forkSession/listSessions/setSessionMode…) are not implemented and their capabilities are not declared, so a conformant client won't call them.
- **Long-running robustness**: per-turn timeout fallback (`CC_TURN_TIMEOUT_MS`), an in-flight turn finalized as `cancelled` immediately on claude crash (so `prompt()` never hangs), and a `_meta.sessionEnded` signal to opt-in clients on unexpected session termination (see above).
- **agent→client**: `session/update` (agent_message_chunk / agent_thought_chunk / tool_call(+locations) / tool_call_update / plan / user_message_chunk), `session/request_permission`.
- **initialize** returns `agentInfo` (name/version), `agentCapabilities` (`loadSession`, `mcpCapabilities{http,sse}`, `promptCapabilities{embeddedContext,image}`, the streaming-preview `_meta` extension); no `authMethods` (the backend uses local subscription credentials, no ACP-layer auth needed).

## Roadmap

- **Per-token streaming**: the dual channel ("grid preview" on the thought channel + "transcript authoritative" on the message channel) is in place (see [Streaming](#streaming-fast-preview--authoritative-final)). The preview is currently **line-level** (grid rows); going per-token needs a stable-prefix character diff within a grid line. The preview systematically distorts **code blocks** (Ink drops fences), so a preview-time downgrade for suspected code is worth considering. `@xterm/headless` and Ink rendering are version-coupled, so this is a degradable component (on parse mismatch the authoritative channel is unaffected and still uses the transcript).
- **Concurrent multi-session and resource reclamation**; correlating permission requests with tool_call ids (today a PermissionRequest occasionally precedes the tool_use flush and uses a temporary id — no functional impact).
- Remaining optional ACP capabilities (plan/images/client-MCP already done): runtime mode switching (`setSessionMode` + `current_mode_update` — the TUI can only inject Shift+Tab cycling + screen-scrape, fragile), slash-command listing (needs a hand-built command list), listSessions/forkSession, runtime model switching (`/model` is a picker; prefer `--model` at new-session only); `usage_update` has no structured source in interactive mode, omitted.

## Status & limitations

- This is an experimental, feasibility-stage project. Phase 1/2/3 (streaming chat + streaming tools + permission forwarding + session resume) are verified end-to-end, but expect rough edges.
- It builds on internal, undocumented behavior of Claude Code (the TUI handshake, transcript format, and hooks schema), so it may change or break across Claude Code versions.
- It's designed for individual, interactive use on your own machine.

## Disclaimer

This is an independent, hobby project for personal use, learning, and interoperability research. It is **not affiliated with, endorsed by, or sponsored by Anthropic**; "Claude" and "Claude Code" belong to their respective owner.

It simply drives the official `claude` CLI through a pseudo-terminal, and relies on internal behavior that can change at any time. Please use it for yourself and in line with [Anthropic's Terms of Service](https://www.anthropic.com/legal/consumer-terms) and the terms of your plan. It is provided **"as is", without warranty of any kind**; you are responsible for how you use it, and the author accepts no liability for any consequences, including any effect on your account. If you're unsure whether a particular use is appropriate, prefer the official tools.

## License

[MIT](./LICENSE) © Clay (ClayCheung)
