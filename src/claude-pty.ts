// Core layer: drive an interactive Claude Code TUI inside a PTY.
//
// Design (validated empirically in probe-pty.mjs):
//   - spawn the REAL `claude` binary interactively (NO -p/--print) so usage
//     stays on the subscription billing path;
//   - answer the terminal capability handshake (DA1/DA2/DSR/XTVERSION) so Ink starts;
//   - auto-confirm the "trust this folder" dialog if it appears;
//   - wait for the alt-screen + output-idle to know the input box is ready;
//   - inject prompts via bracketed paste, then Enter;
//   - read the reply from the session transcript JSONL (clean structured JSON),
//     NOT by parsing the ANSI screen.
//
// Streaming granularity is block-level: each thinking / text / tool_use content
// block surfaces as its own event as soon as Claude Code flushes it to the
// transcript. That maps cleanly onto ACP session/update notifications.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  realpathSync,
  readFileSync,
  readdirSync,
  readFileSync as readSync,
  writeFileSync,
  watch as fsWatch,
  openSync,
  fstatSync,
  readSync as readFd,
  closeSync,
  type FSWatcher,
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { GridPreview } from './grid-preview.js';

const require = createRequire(import.meta.url);
// node-pty is CJS; load via require so named access works under ESM.
const pty = require('node-pty') as typeof import('node-pty');

export interface ClaudeSessionOptions {
  /** Working directory for the Claude Code session. */
  cwd: string;
  /** Stable session id (UUID). We pass it to `--session-id` so we know the transcript path. */
  sessionId: string;
  /** Path/name of the claude binary. Defaults to $CC_CLAUDE_BIN or `claude` (resolved via PATH). */
  claudePath?: string;
  /** Model alias (e.g. "fable", "sonnet") passed to --model. Optional. */
  model?: string;
  /**
   * Permission mode passed to --permission-mode. Default "default".
   * NOTE: in "default" a tool that needs approval will block at the (invisible to us)
   * TUI prompt. Until hook-based permission forwarding lands (Phase 2), use
   * "bypassPermissions" or "acceptEdits" for autonomous tool use.
   */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto';
  cols?: number;
  rows?: number;
  /** Extra env to merge into the spawned process. */
  env?: Record<string, string>;
  /**
   * Unix socket path for permission forwarding. When set, a PermissionRequest
   * hook is injected (via --settings) that routes approvals to this socket, and
   * CC_PERMISSION_SOCK is exported so the hook bridge can find it.
   */
  permissionSocket?: string;
  /** Resume an existing session (`claude --resume <id>`) instead of starting fresh. */
  resume?: boolean;
  /** Client-provided MCP servers, pre-serialized as a `--mcp-config` JSON string. */
  mcpConfigJson?: string;
  /** Extra workspace roots (ACP additionalDirectories) → `--add-dir`. */
  additionalDirectories?: string[];
  /**
   * Backstop: if a turn doesn't finish within this many ms, interrupt it and
   * resolve the prompt as `cancelled`. 0 (default) disables it. A long-running
   * server (e.g. a chat bridge) should set this so a stuck turn can't hang a
   * conversation forever. The common hang (claude crashing mid-turn) is already
   * resolved deterministically by the exit handler.
   */
  turnTimeoutMs?: number;
}

/** A parsed transcript entry for history replay. */
export type HistoryEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant_text'; text: string }
  | { role: 'assistant_thinking'; text: string }
  | { role: 'tool_use'; id: string; name: string; input: unknown }
  | { role: 'tool_result'; id: string; content: unknown; isError: boolean };

type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

/**
 * Events emitted:
 *   'ready'                       TUI is up and accepting input
 *   'text'     (text)             a complete assistant text block (authoritative, from transcript)
 *   'preview'  (line)             a speculative reply line scraped early from the TUI grid
 *   'thinking' (text)             a complete assistant thinking block
 *   'tool_use' ({id,name,input})  the model invoked a tool
 *   'tool_result' ({id, content, isError})  a tool returned (from transcript user entries)
 *   'turn_end' (stopReason)       the assistant finished this turn
 *   'exit'     ({code, signal})   the claude process exited
 *   'error'    (err)
 *   'pty'      (data)             raw PTY output (for debugging)
 *
 * Streaming uses two sources with split roles: 'preview' gives a FAST first
 * token (scraped from the live grid, tolerant/lossy — route to a draft channel),
 * while 'text' gives the AUTHORITATIVE final reply (transcript JSONL, byte-exact
 * — route to the real message channel). See grid-preview.ts.
 */
export class ClaudeSession extends EventEmitter {
  private term: import('node-pty').IPty | null = null;
  private opts: Required<Pick<ClaudeSessionOptions, 'cwd' | 'sessionId' | 'cols' | 'rows'>> &
    ClaudeSessionOptions;
  private lastDataAt = 0;
  private sawAltScreen = false;
  private ready = false;
  private trustConfirmed = false;
  private startResolve: (() => void) | null = null;

  // Transcript tailing (incremental, byte-offset based)
  private transcriptPath: string | null = null;
  private transcriptFd: number | null = null;
  private transcriptOffset = 0; // BYTE offset into the file
  private transcriptDecoder = new StringDecoder('utf8');
  private transcriptPending = ''; // incomplete trailing line carried across reads
  private transcriptTimer: NodeJS.Timeout | null = null; // low-freq fallback
  private transcriptWatcher: FSWatcher | null = null; // fast path

  // Speculative grid preview (fast first token)
  private grid: GridPreview | null = null;

  // Adaptive prompt submit (wait for the paste to echo, then Enter)
  private echoBuf = '';
  private awaitSig: string | null = null;
  private submitTimer: NodeJS.Timeout | null = null;
  private submitted = false;

  // Turn tracking
  private turnActive = false;
  private cancelled = false;
  private turnResolve: ((stopReason: string) => void) | null = null;
  private pendingTurnEnd: NodeJS.Timeout | null = null;
  private turnTimer: NodeJS.Timeout | null = null; // per-turn hang backstop

  constructor(options: ClaudeSessionOptions) {
    super();
    // Canonicalize cwd up front: claude resolves it to its realpath (e.g.
    // /tmp -> /private/tmp on macOS) for the workspace-trust key, so spawn cwd
    // and the trust key MUST agree or the trust dialog reappears and hangs us.
    let cwd = options.cwd;
    try {
      cwd = realpathSync(options.cwd);
    } catch {
      /* keep as-is if it doesn't resolve */
    }
    this.opts = {
      cols: 120,
      // A deliberately TALL viewport so Ink never scrolls the reply off-screen:
      // the grid preview can then read a whole long reply from one snapshot
      // without fragile cross-frame stitching. Verified harmless on 2.1.173
      // (no render/handshake/perf regressions; transcript is unaffected).
      rows: 1000,
      ...options,
      cwd,
    };
  }

  /** Spawn claude and resolve once the TUI is ready for input. */
  start(): Promise<void> {
    if (this.term) throw new Error('already started');
    this.preSeedTrust(); // best-effort: skip the trust dialog entirely

    const bin = resolveClaudeBin(this.opts.claudePath);
    // Resume keeps the SAME session id (no --fork-session) so the transcript
    // and `claude --resume <id>` stay correlated.
    const args = this.opts.resume
      ? ['--resume', this.opts.sessionId]
      : ['--session-id', this.opts.sessionId];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode);
    // Forward client MCP servers and extra workspace roots (ACP newSession).
    if (this.opts.mcpConfigJson) args.push('--mcp-config', this.opts.mcpConfigJson);
    for (const dir of this.opts.additionalDirectories ?? []) args.push('--add-dir', dir);

    const env: Record<string, string> = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
    } as Record<string, string>;
    // claude >= 2.1.173 skips ALL transcript persistence (only ai-title lands,
    // so our jsonl tail hangs forever) when it inherits the nested-session
    // marker CLAUDE_CODE_CHILD_SESSION that a parent Claude Code injects into
    // its subprocesses — i.e. whenever this adapter is launched from inside a
    // Claude Code session (dev/testing). Strip the markers the same way claude
    // itself does before spawning shells, and set the official escape hatch to
    // stay safe against future child-session checks. Old versions ignore both.
    delete env.CLAUDE_CODE_CHILD_SESSION;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION_ID;
    env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
    Object.assign(env, this.opts.env);

    // Permission forwarding: inject a PermissionRequest hook (additive to the
    // user's settings) that routes approvals through our unix socket.
    if (this.opts.permissionSocket) {
      const hookPath = fileURLToPath(new URL('./permission-hook.mjs', import.meta.url));
      const settings = JSON.stringify({
        hooks: {
          PermissionRequest: [
            {
              matcher: '*',
              hooks: [
                { type: 'command', command: `node ${JSON.stringify(hookPath)}`, timeout: 600 },
              ],
            },
          ],
        },
      });
      args.push('--settings', settings);
      env.CC_PERMISSION_SOCK = this.opts.permissionSocket;
    }

    this.term = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: this.opts.cols,
      rows: this.opts.rows,
      cwd: this.opts.cwd,
      env,
    });

    // Feed every byte to the grid preview so its virtual screen tracks the real
    // one; it only EXTRACTS text during an active turn (see prompt/finishTurn).
    this.grid = new GridPreview({
      cols: this.opts.cols,
      rows: this.opts.rows,
      onLine: (line) => this.emit('preview', line),
    });

    this.lastDataAt = Date.now();
    this.term.onData((d) => this.onData(d));
    this.term.onExit((e) => {
      // If claude died mid-turn, resolve the pending prompt() as cancelled so
      // the caller (and the ACP client) never hangs waiting for a turn that
      // can no longer complete.
      if (this.turnActive) this.finishTurn('cancelled');
      this.stopTranscriptTail();
      this.grid?.dispose();
      this.grid = null;
      this.emit('exit', e);
    });

    // Readiness watchdog: alt-screen seen + output idle => input box ready.
    const readyTimer = setInterval(() => {
      if (this.ready) {
        clearInterval(readyTimer);
        return;
      }
      const idle = Date.now() - this.lastDataAt;
      if (this.sawAltScreen && idle > 800) {
        this.ready = true;
        clearInterval(readyTimer);
        this.emit('ready');
        this.startResolve?.();
        this.startResolve = null;
      }
    }, 200);

    return new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      const failTimer = setTimeout(() => {
        clearInterval(readyTimer); // stop the watchdog spinning if we never got ready
        if (!this.ready) reject(new Error('claude TUI did not become ready in 30s'));
      }, 30_000);
      const clear = () => clearTimeout(failTimer);
      this.once('ready', clear);
      this.once('exit', () => {
        clear();
        if (!this.ready) reject(new Error('claude exited before becoming ready'));
      });
    });
  }

  /**
   * Send a prompt and resolve with the stopReason when the turn ends.
   * Streams 'text' / 'thinking' / 'tool_use' events meanwhile.
   */
  prompt(text: string): Promise<string> {
    if (!this.term) throw new Error('not started');
    if (!this.ready) throw new Error('not ready');
    if (this.turnActive) throw new Error('a turn is already in progress');

    this.turnActive = true;
    this.cancelled = false;
    this.startTranscriptTail();
    this.grid?.beginTurn();

    // Hang backstop: a turn that never writes a terminal stop_reason (claude
    // wedged, an unanswered permission, etc.) would otherwise leave prompt()
    // pending forever. On timeout, interrupt and close the turn as cancelled.
    const timeout = this.opts.turnTimeoutMs ?? 0;
    if (timeout > 0) {
      this.turnTimer = setTimeout(() => {
        console.error(`[claude-code-acp] turn timed out after ${timeout}ms; cancelling`);
        this.term?.write('\x1b'); // Esc: best-effort interrupt
        this.finishTurn('cancelled');
      }, timeout);
    }

    // Bracketed paste => text taken literally; separate Enter submits it.
    this.term.write('\x1b[200~' + text + '\x1b[201~');
    // Adaptive submit: send Enter as soon as the paste echoes back (whitespace-
    // insensitive so input-box reflow doesn't break the match), with a 150ms
    // cap so we always submit even if the echo can't be matched.
    const sig = stripAnsi(text).replace(/\s+/g, '');
    this.awaitSig = sig.length >= 4 ? sig.slice(-16) : null;
    this.echoBuf = '';
    this.submitted = false;
    this.submitTimer = setTimeout(() => this.submitPrompt(), 150);

    return new Promise<string>((resolve) => {
      this.turnResolve = resolve;
    });
  }

  /** Press Enter to submit the pasted prompt (idempotent within a turn). */
  private submitPrompt(): void {
    if (this.submitted) return;
    this.submitted = true;
    if (this.submitTimer) {
      clearTimeout(this.submitTimer);
      this.submitTimer = null;
    }
    this.awaitSig = null;
    this.echoBuf = '';
    this.term?.write('\r');
  }

  /** Interrupt the current turn (Esc, like a user pressing Escape). */
  cancel(): void {
    this.term?.write('\x1b');
    if (!this.turnActive) return;
    this.cancelled = true;
    // If claude doesn't write a terminal stop to the transcript shortly after
    // the interrupt, force the turn closed so prompt() resolves as cancelled.
    setTimeout(() => this.finishTurn('cancelled'), 1500);
  }

  kill(): void {
    this.stopTranscriptTail();
    this.grid?.dispose();
    this.grid = null;
    try {
      this.term?.kill();
    } catch {
      /* ignore */
    }
    this.term = null;
  }

  resize(cols: number, rows: number): void {
    this.term?.resize(cols, rows);
  }

  /**
   * Read the full existing transcript as replayable history, and advance the
   * tail offset to the current end so subsequent live tailing only emits NEW
   * content. Call this right after start() when resuming.
   */
  snapshotHistory(): HistoryEntry[] {
    const path = this.findTranscript();
    if (!path) return [];
    this.transcriptPath = path;
    let buf: string;
    try {
      buf = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    this.transcriptOffset = Buffer.byteLength(buf); // BYTE offset; live tail starts after history
    this.transcriptPending = '';
    this.transcriptDecoder = new StringDecoder('utf8');
    const out: HistoryEntry[] = [];
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === 'assistant') {
        const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
        for (const b of blocks) {
          if (b.type === 'text') out.push({ role: 'assistant_text', text: b.text });
          else if (b.type === 'thinking')
            out.push({ role: 'assistant_thinking', text: b.thinking ?? '' });
          else if (b.type === 'tool_use')
            out.push({ role: 'tool_use', id: b.id, name: b.name, input: b.input });
        }
      } else if (o.type === 'user') {
        const c = o.message?.content;
        if (typeof c === 'string') out.push({ role: 'user', text: c });
        else if (Array.isArray(c)) {
          for (const b of c) {
            if (b?.type === 'text') out.push({ role: 'user', text: b.text });
            else if (b?.type === 'tool_result')
              out.push({
                role: 'tool_result',
                id: b.tool_use_id,
                content: b.content,
                isError: !!b.is_error,
              });
          }
        }
      }
    }
    return out;
  }

  // ---- internals ---------------------------------------------------------

  private onData(data: string): void {
    this.lastDataAt = Date.now();
    this.emit('pty', data);
    this.grid?.write(data);
    if (!this.sawAltScreen && data.includes('\x1b[?1049h')) {
      this.sawAltScreen = true;
    }
    if (this.awaitSig !== null) this.detectSubmitEcho(data);
    this.answerTerminalQueries(data);
    if (!this.trustConfirmed) this.maybeConfirmTrust(data);
  }

  /** Submit as soon as the pasted prompt echoes back into the input box. */
  private detectSubmitEcho(data: string): void {
    this.echoBuf = (this.echoBuf + stripAnsi(data).replace(/\s+/g, '')).slice(-400);
    if (this.awaitSig && this.echoBuf.includes(this.awaitSig)) this.submitPrompt();
  }

  /** Reply to terminal capability queries so Ink's startup handshake completes. */
  private answerTerminalQueries(data: string): void {
    const replies: string[] = [];
    if (/\x1b\[(0)?c/.test(data)) replies.push('\x1b[?1;2c'); // DA1
    if (/\x1b\[>(0)?c/.test(data)) replies.push('\x1b[>0;276;0c'); // DA2
    if (/\x1b\[6n/.test(data)) replies.push('\x1b[1;1R'); // DSR cursor pos
    if (/\x1b\[>\d*q/.test(data)) replies.push('\x1bP>|claude-code-acp\x1b\\'); // XTVERSION (sent as \e[>0q)
    for (const r of replies) this.term?.write(r);
  }

  /** If the "trust this folder" dialog shows up, accept the default (Yes). */
  private maybeConfirmTrust(data: string): void {
    const plain = stripAnsi(data).toLowerCase();
    if (plain.includes('trust this folder') || plain.includes('is this a folder you trust')) {
      this.trustConfirmed = true;
      setTimeout(() => this.term?.write('\r'), 100); // option 1 = Yes, I trust
    }
  }

  /** Best-effort: mark cwd as trusted in ~/.claude.json so no dialog appears. */
  private preSeedTrust(): void {
    try {
      const p = join(homedir(), '.claude.json');
      if (!existsSync(p)) return;
      const conf = JSON.parse(readSync(p, 'utf8'));
      conf.projects = conf.projects || {};
      const key = this.opts.cwd;
      const entry = conf.projects[key] || {};
      if (entry.hasTrustDialogAccepted === true) return; // already trusted, don't rewrite
      entry.hasTrustDialogAccepted = true;
      conf.projects[key] = entry;
      writeFileSync(p, JSON.stringify(conf, null, 2));
    } catch {
      // Non-fatal: maybeConfirmTrust() handles the dialog if pre-seed fails.
    }
  }

  private startTranscriptTail(): void {
    // fs.watch is the fast path (<10ms after a block lands); the low-frequency
    // interval covers (a) discovering/creating the file before a watcher can be
    // attached and (b) any events a given filesystem drops.
    this.pollTranscript();
    if (!this.transcriptTimer) {
      this.transcriptTimer = setInterval(() => this.pollTranscript(), 500);
    }
  }

  private attachWatcher(path: string): void {
    if (this.transcriptWatcher) return;
    try {
      this.transcriptWatcher = fsWatch(path, () => this.pollTranscript());
    } catch {
      /* fall back to the interval */
    }
  }

  private stopTranscriptTail(): void {
    if (this.transcriptTimer) clearInterval(this.transcriptTimer);
    this.transcriptTimer = null;
    if (this.transcriptWatcher) {
      try {
        this.transcriptWatcher.close();
      } catch {
        /* ignore */
      }
      this.transcriptWatcher = null;
    }
    if (this.transcriptFd !== null) {
      try {
        closeSync(this.transcriptFd);
      } catch {
        /* ignore */
      }
      this.transcriptFd = null;
    }
    if (this.pendingTurnEnd) clearTimeout(this.pendingTurnEnd);
    this.pendingTurnEnd = null;
  }

  private findTranscript(): string | null {
    const base = join(homedir(), '.claude', 'projects');
    if (!existsSync(base)) return null;
    for (const d of readdirSync(base)) {
      const f = join(base, d, `${this.opts.sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
    return null;
  }

  private pollTranscript(): void {
    if (!this.transcriptPath) {
      this.transcriptPath = this.findTranscript();
      if (!this.transcriptPath) return;
    }
    if (!this.transcriptWatcher) this.attachWatcher(this.transcriptPath);

    // Read only the bytes appended since transcriptOffset (incremental tail);
    // a StringDecoder carries any partial multibyte char across reads, and
    // transcriptPending carries any incomplete trailing line.
    try {
      if (this.transcriptFd === null) this.transcriptFd = openSync(this.transcriptPath, 'r');
      const size = fstatSync(this.transcriptFd).size;
      if (size <= this.transcriptOffset) return;
      const len = size - this.transcriptOffset;
      const buf = Buffer.allocUnsafe(len);
      const read = readFd(this.transcriptFd, buf, 0, len, this.transcriptOffset);
      this.transcriptOffset += read;
      this.transcriptPending += this.transcriptDecoder.write(buf.subarray(0, read));
    } catch {
      return;
    }

    const parts = this.transcriptPending.split('\n');
    this.transcriptPending = parts.pop() ?? ''; // last piece may be a partial line
    for (const line of parts) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleTranscriptEntry(o);
    }
  }

  private handleTranscriptEntry(o: any): void {
    if (o.type === 'assistant') {
      const msg = o.message || {};
      const blocks: AssistantBlock[] = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (b.type === 'text') this.emit('text', b.text);
        else if (b.type === 'thinking') this.emit('thinking', (b as any).thinking ?? '');
        else if (b.type === 'tool_use')
          this.emit('tool_use', { id: b.id, name: b.name, input: b.input });
      }
      const stop: string = msg.stop_reason;
      // tool_use => the turn continues after the tool runs. Anything else ends it.
      if (stop && stop !== 'tool_use') this.armTurnEnd(stop);
    } else if (o.type === 'user') {
      // tool results come back as user entries with tool_result content blocks
      const msg = o.message || {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (b && b.type === 'tool_result') {
          this.emit('tool_result', {
            id: b.tool_use_id,
            content: b.content,
            isError: !!b.is_error,
          });
        }
      }
    }
  }

  /** Debounce turn-end so all blocks of the final model response flush first. */
  private armTurnEnd(stopReason: string): void {
    if (this.pendingTurnEnd) clearTimeout(this.pendingTurnEnd);
    this.pendingTurnEnd = setTimeout(() => this.finishTurn(stopReason), 200);
  }

  private finishTurn(stopReason: string): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.grid?.endTurn(); // flush the last confirmed preview line, stop scraping
    if (this.pendingTurnEnd) {
      clearTimeout(this.pendingTurnEnd);
      this.pendingTurnEnd = null;
    }
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    const reason = this.cancelled ? 'cancelled' : stopReason;
    this.emit('turn_end', reason);
    const r = this.turnResolve;
    this.turnResolve = null;
    r?.(reason);
  }
}

function stripAnsi(s: string): string {
  // Enough to detect plain words in TUI output.
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

/**
 * Resolve the claude binary to an ABSOLUTE path. GUI launchers (Zed, etc.) often
 * spawn with a minimal PATH where a bare `claude` won't resolve, so we search
 * the env override, PATH, and common install locations before giving up.
 */
function resolveClaudeBin(explicit?: string): string {
  const fromPath = (process.env.PATH || '')
    .split(':')
    .filter(Boolean)
    .map((d) => join(d, 'claude'));
  const candidates = [
    explicit,
    process.env.CC_CLAUDE_BIN,
    ...fromPath,
    join(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(homedir(), '.claude/local/claude'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return 'claude'; // last resort; let spawn surface the error
}
