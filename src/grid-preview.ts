// Speculative streaming preview: reconstruct Claude Code's TUI screen from the
// raw PTY byte stream and emit the in-progress assistant reply text EARLY, so a
// client gets a fast first token instead of waiting for the block-level
// transcript flush (a long reply only lands in the JSONL once the whole text
// block is generated).
//
// This is a PREVIEW source only. It feeds the ACP `agent_thought_chunk` channel
// (a tolerant draft area), NEVER the authoritative `agent_message_chunk` — the
// final reply always comes from the transcript JSONL. Reason: the rendered grid
// has irrecoverable losses vs the source markdown (verified against the Ink
// source):
//   - fenced code blocks lose their ``` and language tag (marked consumes the
//     fence; the body renders as colored plaintext, no box);
//   - a continuation line that wraps cannot be told apart from a real newline
//     that happens to fall near full width;
//   - indented code can be clipped by the 2-column gutter strip.
// None of that matters for a draft preview, and none of it can ever reach the
// final answer because the final answer is transcript-sourced.
//
// Ground truth that makes extraction reliable (Ink source, cross-checked on
// claude 2.1.173):
//   - the assistant text block is anchored by the ⏺ marker (figures.ts);
//   - its left gutter is a fixed 2 columns (a flex minWidth=2 box, NOT a text
//     prefix), so every line sits at x=2 — strip 2 columns deterministically;
//   - with a tall PTY (rows >> reply height) Ink never scrolls (main-screen
//     height = full content height, alt-screen viewport simply holds it all),
//     so the whole reply stays on one grid snapshot and we don't need any
//     fragile cross-frame stitching.

import { createRequire } from 'node:module';
import type { Terminal as XTerminal } from '@xterm/headless';

const require = createRequire(import.meta.url);
// @xterm/headless `main` is CJS; load via require so it works under ESM.
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

export interface GridPreviewOptions {
  cols: number;
  rows: number;
  /** Called once per newly-confirmed reply line (gutter-stripped, no trailing newline). */
  onLine: (text: string) => void;
  /** How many consecutive snapshots a line must be unchanged before we commit it. Default 2. */
  stableFrames?: number;
}

const DOT = /⏺|●/; // BLACK_CIRCLE (darwin ⏺ / other ●) anchors an assistant text block
// Spinner / progress glyphs Ink uses for the "working" indicator.
const SPINNER_START = /^[⠀-⣿✶✳✻✽✢✷✸✹✺·◐◓◑◒◉✱]/;
// Input-box chrome and status-bar fragments that sit BELOW the reply.
const CHROME_START = /^[│╭╰─╮╯❯>]/;
const STATUS_FRAGMENT = /esc to interrupt|tokens\)|\bytes\b|\/effort|\/model|bypass permissions|⏵⏵|accept edits/i;

export class GridPreview {
  private term: XTerminal;
  private opts: Required<GridPreviewOptions>;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private turnActive = false;
  private emitted = 0; // reply lines already emitted this turn
  private prevLines: string[] = [];
  private stableCount: number[] = [];
  // The previous turn's reply block, captured at beginTurn. The current reply is
  // a NEW ⏺ block; until one appears, the last ⏺ on screen is still the prior
  // turn's answer — baselining it stops us re-emitting that as this turn.
  private baselineBlock = '';

  constructor(opts: GridPreviewOptions) {
    this.opts = { stableFrames: 2, ...opts };
    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      allowProposedApi: true,
      scrollback: opts.rows, // tall PTY means nothing should scroll; small cushion anyway
    });
  }

  /** Feed raw PTY bytes. Safe to call outside a turn (keeps screen state current). */
  write(data: string): void {
    this.term.write(data);
    if (this.turnActive) this.scheduleSnapshot();
  }

  /** Mark the start of a new prompt turn: the reply is the next ⏺ block to appear. */
  beginTurn(): void {
    this.turnActive = true;
    this.emitted = 0;
    this.prevLines = [];
    this.stableCount = [];
    this.baselineBlock = this.extractBlock().join('\n'); // the prior turn's reply, if any
  }

  /** Flush whatever is confirmed (including the final line) and stop emitting. */
  endTurn(): void {
    if (!this.turnActive) return;
    this.snapshot(true);
    this.turnActive = false;
    if (this.snapTimer) {
      clearTimeout(this.snapTimer);
      this.snapTimer = null;
    }
  }

  dispose(): void {
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.snapTimer = null;
    try {
      this.term.dispose();
    } catch {
      /* ignore */
    }
  }

  // ---- internals ---------------------------------------------------------

  private scheduleSnapshot(): void {
    if (this.snapTimer) return;
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      this.snapshot(false);
    }, 40);
  }

  /**
   * Reconstruct the current reply block, then emit any newly-confirmed prefix.
   * "Confirmed" = unchanged for `stableFrames` snapshots; we hold back the last
   * line until the turn ends (it may still be growing), so we never emit text
   * that a later frame would rewrite — that's what keeps the preview from
   * "garbling" even though thought chunks are append-only.
   */
  private snapshot(turnEnded: boolean): void {
    if (!this.turnActive) return;
    const raw = this.extractBlock();
    // Until a new ⏺ block appears, the last block is still the prior turn's
    // answer — treat that as "nothing to preview yet".
    const lines = raw.join('\n') === this.baselineBlock ? [] : raw;

    const stable: number[] = lines.map((l, i) =>
      this.prevLines[i] === l ? (this.stableCount[i] || 0) + 1 : 1,
    );
    // Longest prefix of lines that have each been stable >= K frames.
    let stablePrefix = 0;
    while (stablePrefix < lines.length && stable[stablePrefix] >= this.opts.stableFrames) {
      stablePrefix++;
    }
    // Hold back the last line mid-turn (still being written); flush it on end.
    const upTo = turnEnded ? lines.length : Math.min(stablePrefix, Math.max(lines.length - 1, 0));
    for (let i = this.emitted; i < upTo; i++) this.opts.onLine(lines[i]);
    if (upTo > this.emitted) this.emitted = upTo;

    this.prevLines = lines;
    this.stableCount = stable;
  }

  /** Pull the latest ⏺-anchored assistant text block as gutter-stripped lines. */
  private extractBlock(): string[] {
    const buf = this.term.buffer.active;
    const n = buf.length;
    const rows: string[] = new Array(n);
    for (let y = 0; y < n; y++) {
      const ln = buf.getLine(y);
      rows[y] = ln ? ln.translateToString(true) : '';
    }

    let anchor = -1;
    for (let y = n - 1; y >= 0; y--) {
      if (DOT.test(rows[y]) && !this.isChromeOrStatus(rows[y])) {
        anchor = y;
        break;
      }
    }
    if (anchor < 0) return [];

    const out: string[] = [];
    out.push(rows[anchor].replace(/^.*?(?:⏺|●)\s?/, '')); // strip marker + its pad space
    for (let y = anchor + 1; y < n; y++) {
      const raw = rows[y];
      if (raw.trim() === '') {
        out.push(''); // paragraph break (or trailing pad — trimmed below)
        continue;
      }
      if (this.isChromeOrStatus(raw)) break; // spinner / input box / status bar ends the block
      if (/^ {2}/.test(raw)) {
        out.push(raw.slice(2)); // fixed 2-column gutter
        continue;
      }
      break; // non-empty, not gutter-aligned => no longer the reply block
    }
    while (out.length && out[out.length - 1] === '') out.pop(); // drop trailing blanks
    return out;
  }

  private isChromeOrStatus(raw: string): boolean {
    const t = raw.trimStart();
    if (CHROME_START.test(t)) return true;
    if (SPINNER_START.test(t)) return true;
    if (STATUS_FRAGMENT.test(raw)) return true;
    if (/Claude Code/.test(raw) && /[╭─╮]/.test(raw)) return true; // welcome banner
    return false;
  }
}
