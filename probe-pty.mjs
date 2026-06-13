// Standalone probe: can we drive interactive Claude Code inside a PTY,
// inject a prompt, and read the reply from the transcript JSONL?
// Run: node probe-pty.mjs
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const CLAUDE = process.env.CC_CLAUDE_BIN || join(homedir(), '.local/bin/claude'); // real binary, bypasses shell fn + wrapper
const SID = randomUUID();
const CWD = '/tmp/cc-probe';
mkdirSync(CWD, { recursive: true });

const esc = (s) => s.replace(/\x1b/g, '\\e').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
const now = () => (Date.now() - t0).toString().padStart(5, ' ');
const t0 = Date.now();

console.log(`[probe] session=${SID}`);
console.log(`[probe] spawning ${CLAUDE} interactive in ${CWD}`);

const term = pty.spawn(CLAUDE, ['--session-id', SID], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: CWD,
  env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' },
});

let lastDataAt = Date.now();
let injected = false;
let rawLen = 0;
let sawAltScreen = false; // TUI proper has started once we enter alt-screen buffer

// Respond to terminal capability queries like a real emulator would,
// so Ink's startup handshake completes.
function answerQueries(data) {
  const out = [];
  // DA1: CSI c  or CSI 0 c
  if (/\x1b\[(0)?c/.test(data)) out.push('\x1b[?1;2c');
  // DA2: CSI > c  (or CSI > 0 c)
  if (/\x1b\[>(0)?c/.test(data)) out.push('\x1b[>0;276;0c');
  // DSR cursor position: CSI 6 n
  if (/\x1b\[6n/.test(data)) out.push('\x1b[1;1R');
  // XTVERSION: CSI > q
  if (/\x1b\[>q/.test(data)) out.push('\x1bP>|cc-probe\x1b\\');
  for (const r of out) {
    process.stdout.write(`[${now()}] <reply> ${esc(r)}\n`);
    term.write(r);
  }
}

term.onData((data) => {
  lastDataAt = Date.now();
  rawLen += data.length;
  if (data.includes('\x1b[?1049h')) { sawAltScreen = true; console.log(`[${now()}] [probe] alt-screen entered (TUI started)`); }
  // Print a trimmed view of raw output so we can see what Ink emits.
  const shown = data.length > 300 ? data.slice(0, 300) + `…(+${data.length - 300})` : data;
  process.stdout.write(`[${now()}] <pty ${data.length}b> ${esc(shown)}\n`);
  answerQueries(data);
});

term.onExit(({ exitCode, signal }) => {
  console.log(`[${now()}] [probe] claude exited code=${exitCode} signal=${signal}`);
  process.exit(0);
});

// Quiesce detector: once output goes quiet, assume ready and inject the prompt.
const PROMPT = 'Reply with exactly one word: pong';
const tick = setInterval(() => {
  const idle = Date.now() - lastDataAt;
  // Only inject once the real TUI is up (alt-screen) AND it has gone quiet.
  if (!injected && sawAltScreen && idle > 1200) {
    injected = true;
    console.log(`[${now()}] [probe] TUI idle ${idle}ms, injecting prompt via bracketed paste`);
    // Bracketed paste so the text is taken literally (no autocomplete/keybind interference),
    // then a separate Enter to submit.
    term.write('\x1b[200~' + PROMPT + '\x1b[201~');
    setTimeout(() => term.write('\r'), 150);
    startTranscriptTail();
  }
}, 250);

// Tail the transcript JSONL for this session (found by session id, any project dir).
function findTranscript() {
  const base = join(homedir(), '.claude', 'projects');
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    const f = join(base, d, `${SID}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

let tailStarted = false;
function startTranscriptTail() {
  if (tailStarted) return;
  tailStarted = true;
  let offset = 0;
  let path = null;
  const poll = setInterval(() => {
    if (!path) {
      path = findTranscript();
      if (path) console.log(`[${now()}] [probe] transcript: ${path}`);
      return;
    }
    let buf;
    try { buf = readFileSync(path, 'utf8'); } catch { return; }
    if (buf.length <= offset) return;
    const chunk = buf.slice(offset);
    offset = buf.length;
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'assistant') {
        const m = o.message || {};
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) {
          if (b.type === 'text') console.log(`[${now()}] >>> TEXT: ${JSON.stringify(b.text)} (stop=${m.stop_reason})`);
          else if (b.type === 'thinking') console.log(`[${now()}] >>> THINK: ${JSON.stringify((b.thinking||'').slice(0,60))}…`);
          else if (b.type === 'tool_use') console.log(`[${now()}] >>> TOOL: ${b.name} ${JSON.stringify(b.input).slice(0,80)}`);
        }
        if (m.stop_reason === 'end_turn') {
          console.log(`[${now()}] [probe] turn ended (end_turn). SUCCESS. cleaning up.`);
          clearInterval(poll); clearInterval(tick);
          setTimeout(() => term.kill(), 200);
        }
      }
    }
  }, 200);
}

// Hard timeout safety net.
setTimeout(() => {
  console.log(`[${now()}] [probe] TIMEOUT — killing claude`);
  try { term.kill(); } catch {}
  process.exit(1);
}, 45000);
