// ACP layer: expose the PTY-driven interactive Claude Code as an ACP Agent.
//
// This is the half that any ACP client (Zed, JetBrains, neovim, our test-client)
// talks to. It maps:
//   ACP session/prompt              -> inject prompt into the interactive TUI
//   transcript blocks                -> session/update notifications (streaming)
//   Claude Code PermissionRequest    -> session/request_permission (Phase 2)
//
// Because the backend is a real interactive `claude` process (no -p / no SDK),
// usage is billed against the Claude subscription, while the client speaks the
// same protocol it would use against an SDK-backed agent.

import * as acp from '@agentclientprotocol/sdk';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { ClaudeSession } from './claude-pty.js';

const log = (...a: unknown[]) => console.error('[claude-code-acp]', ...a);

interface PendingTool {
  toolCallId: string;
  name: string;
  inputKey: string;
}

interface PlanTask {
  subject: string;
  status: acp.PlanEntryStatus;
}

interface Session {
  claude: ClaudeSession;
  cwd: string;
  pendingTools: PendingTool[];
  turn: number; // increments per prompt; tags provisional/replace chunks
  finalText: string; // authoritative reply text accumulated this turn (replace mode)
  planToolIds: Set<string>; // tool_use ids surfaced as ACP `plan` (not tool_call)
  // Claude's planning tools are incremental (TaskCreate adds one, TaskUpdate
  // mutates by id); we accumulate them and re-emit the whole ACP plan each time.
  tasks: Map<string, PlanTask>; // taskId ("1","2",…) -> task, insertion-ordered
  taskSeq: number; // mirrors Claude's sequential task numbering
}

// Vendor namespace for our `_meta` protocol extension. ACP `_meta` is the
// official escape hatch: unaware clients ignore it (so this stays compatible),
// while a client that opts in gets streaming preview + a final full replace.
const EXT = 'claude-code-acp/streaming-preview';

/**
 * How the speculative grid preview is surfaced to the client:
 *   'replace' — stream provisional reply chunks into the MESSAGE channel (real
 *               typewriter feel), then send the authoritative full text tagged
 *               to REPLACE them. Only for clients that opt in (else they'd see
 *               duplicated text), via clientCapabilities._meta[EXT] or CC_PREVIEW.
 *   'thought' — stream preview into the THOUGHT channel (safe default; any ACP
 *               client renders it as a collapsible draft, never duplicated).
 *   'off'     — no preview; authoritative transcript only.
 */
type StreamMode = 'replace' | 'thought' | 'off';

export class ClaudeCodeAgent implements acp.Agent {
  private sessions = new Map<string, Session>();
  private sockPath: string;
  private streamMode: StreamMode = 'thought';
  private extAware = false; // client opted into our _meta extension (gets death signals)

  constructor(private conn: acp.AgentSideConnection) {
    this.sockPath = join(tmpdir(), `claude-code-acp-${process.pid}.sock`);
    this.startPermissionBroker();
  }

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    // CC_PREVIEW forces the mode; otherwise honor the client's opt-in for the
    // streaming-preview extension, falling back to the safe thought channel.
    const forced = process.env.CC_PREVIEW as StreamMode | undefined;
    const clientOptIn =
      (params.clientCapabilities?._meta as any)?.[EXT]?.provisionalReplace === true;
    this.extAware = clientOptIn;
    this.streamMode =
      forced === 'replace' || forced === 'thought' || forced === 'off'
        ? forced
        : clientOptIn
          ? 'replace'
          : 'thought';
    log(`stream mode = ${this.streamMode}`);
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'claude-code-acp', title: 'Claude Code (subscription)', version: '0.1.0' },
      agentCapabilities: {
        loadSession: true,
        // A long-running client (e.g. a chat bridge) can free a session's claude
        // process with session/close instead of leaking it until we exit.
        sessionCapabilities: { close: {} },
        // image: the interactive TUI reads images from pasted absolute file
        // paths, so we materialize ACP image blocks to temp files (see prompt()).
        promptCapabilities: { embeddedContext: true, image: true, audio: false },
        // Client MCP servers are forwarded to `claude --mcp-config` at spawn.
        mcpCapabilities: { http: true, sse: true },
        // Advertise the extension so opting-in clients know it's available.
        _meta: { [EXT]: { provisionalReplace: true, version: 1 } },
      } as acp.AgentCapabilities,
    };
  }

  // No auth: the backing `claude` process uses the local subscription credentials.
  async authenticate(_params: acp.AuthenticateRequest): Promise<void> {
    return;
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    // Use one id for both the ACP session and `claude --session-id`, so the
    // transcript is trivially correlated and the user can `claude --resume <id>`.
    const sessionId = randomUUID();
    const cwd = params.cwd || process.cwd();
    log(`newSession ${sessionId} cwd=${cwd}`);
    await this.spawnSession(sessionId, cwd, false, sessionExtras(params));
    return { sessionId };
  }

  // Resume a prior session: re-spawn `claude --resume <id>` and replay the
  // existing transcript to the client so the conversation thread is rebuilt.
  // This is what lets a Feishu "thread = session" survive a bridge restart.
  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const sessionId = params.sessionId;
    const cwd = params.cwd || process.cwd();
    log(`loadSession ${sessionId} cwd=${cwd}`);

    const session = await this.spawnSession(sessionId, cwd, true, sessionExtras(params));
    const history = session.claude.snapshotHistory();
    log(`loadSession ${sessionId}: replaying ${history.length} history entries`);
    for (const h of history) this.replay(sessionId, session, h);
    return {};
  }

  private async spawnSession(
    sessionId: string,
    cwd: string,
    resume: boolean,
    extras: SessionExtras = {},
  ): Promise<Session> {
    const claude = new ClaudeSession({
      cwd,
      sessionId,
      model: process.env.CC_MODEL,
      permissionMode: (process.env.CC_PERMISSION_MODE as any) || 'default',
      permissionSocket: this.sockPath,
      resume,
      mcpConfigJson: extras.mcpConfigJson,
      additionalDirectories: extras.additionalDirectories,
      turnTimeoutMs: Number(process.env.CC_TURN_TIMEOUT_MS) || 0,
    });
    const session: Session = {
      claude,
      cwd,
      pendingTools: [],
      turn: 0,
      finalText: '',
      planToolIds: new Set(),
      tasks: new Map(),
      taskSeq: 0,
    };
    this.wireStreaming(sessionId, session);
    try {
      await claude.start();
    } catch (err) {
      claude.kill();
      throw err;
    }
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Emit a historical transcript entry as a session/update (replay on resume). */
  private replay(sessionId: string, session: Session, h: import('./claude-pty.js').HistoryEntry): void {
    switch (h.role) {
      case 'user':
        if (h.text.trim())
          this.send(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: h.text } });
        break;
      case 'assistant_text':
        this.send(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: h.text } });
        break;
      case 'tool_use':
        if (this.applyPlanTool(session, h.name, h.input)) {
          session.planToolIds.add(h.id);
          this.send(sessionId, { sessionUpdate: 'plan', entries: renderPlan(session) });
          break;
        }
        session.pendingTools.push({ toolCallId: h.id, name: h.name, inputKey: stableKey(h.input) });
        this.send(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: h.id,
          title: titleForTool(h.name, h.input),
          kind: kindForTool(h.name),
          status: 'completed',
          rawInput: h.input as Record<string, unknown>,
          locations: locationsForTool(h.input),
        });
        break;
      case 'tool_result':
        if (session.planToolIds.has(h.id)) break;
        session.pendingTools = session.pendingTools.filter((p) => p.toolCallId !== h.id);
        this.send(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: h.id,
          status: h.isError ? 'failed' : 'completed',
          content: toToolContent(h.content),
        });
        break;
      // assistant_thinking is intentionally skipped on replay (noise).
    }
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session ${params.sessionId}`);

    // Image blocks have no textual form, so we write them to temp files and let
    // the TUI read them from their pasted absolute paths (see materializePrompt).
    const { text, tempFiles } = materializePrompt(params.prompt);
    log(`prompt ${params.sessionId}: ${JSON.stringify(text.slice(0, 80))}`);

    session.turn += 1;
    session.finalText = '';
    let stopReason: string;
    try {
      stopReason = await session.claude.prompt(text);
    } finally {
      for (const f of tempFiles) {
        try {
          unlinkSync(f);
        } catch {
          /* the TUI already read it; best-effort cleanup */
        }
      }
    }

    // Replace mode: the provisional preview streamed into the message channel;
    // now send the authoritative full reply tagged to replace it. (In thought/
    // off mode the authoritative text was already streamed as it landed.)
    if (this.streamMode === 'replace' && session.finalText) {
      this.send(
        params.sessionId,
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: session.finalText } },
        { [EXT]: { replaceProvisional: true, turn: session.turn } },
      );
    }
    return { stopReason: mapStopReason(stopReason) };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.claude.cancel();
  }

  // Free a session's resources on demand (kills its claude process). Lets a
  // long-running client reclaim sessions instead of leaking claude processes
  // until the agent exits. Advertised via sessionCapabilities.close.
  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      log(`closeSession ${params.sessionId}`);
      this.sessions.delete(params.sessionId); // delete first so the exit handler is a no-op
      session.claude.kill();
    }
    return {};
  }

  // ---- streaming wiring --------------------------------------------------

  private wireStreaming(sessionId: string, session: Session): void {
    const claude = session.claude;

    // Authoritative final reply: byte-exact text blocks from the transcript.
    // In replace mode we accumulate them and emit one full replace chunk at
    // turn end (see prompt()); otherwise stream each block as it lands.
    claude.on('text', (text: string) => {
      if (this.streamMode === 'replace') {
        session.finalText += text;
        return;
      }
      this.send(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    });

    // Speculative preview: reply lines scraped early from the TUI grid for a
    // fast first token.
    //   replace mode -> stream into the MESSAGE channel as PROVISIONAL chunks
    //                   (typewriter feel); the turn-end replace supersedes them.
    //   thought mode -> stream into the THOUGHT channel (a tolerant draft area);
    //                   the authoritative 'text' is the real answer.
    // Either way the preview's render noise can never become the final answer.
    claude.on('preview', (line: string) => {
      if (this.streamMode === 'off') return;
      if (this.streamMode === 'replace') {
        this.send(
          sessionId,
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: line + '\n' } },
          { [EXT]: { provisional: true, turn: session.turn } },
        );
      } else {
        this.send(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: line + '\n' },
        });
      }
    });

    claude.on('thinking', (text: string) => {
      if (!text) return;
      this.send(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
    });

    claude.on('tool_use', ({ id, name, input }: { id: string; name: string; input: unknown }) => {
      // Planning tools become an ACP `plan` update, not a tool call.
      if (this.applyPlanTool(session, name, input)) {
        session.planToolIds.add(id);
        this.send(sessionId, { sessionUpdate: 'plan', entries: renderPlan(session) });
        return;
      }
      session.pendingTools.push({ toolCallId: id, name, inputKey: stableKey(input) });
      this.send(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: titleForTool(name, input),
        kind: kindForTool(name),
        status: 'in_progress',
        rawInput: input as Record<string, unknown>,
        locations: locationsForTool(input),
      });
    });

    claude.on(
      'tool_result',
      ({ id, content, isError }: { id: string; content: unknown; isError: boolean }) => {
        if (session.planToolIds.has(id)) return; // plan tool: no tool_call_update
        session.pendingTools = session.pendingTools.filter((p) => p.toolCallId !== id);
        this.send(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: isError ? 'failed' : 'completed',
          content: toToolContent(content),
          rawOutput: { content } as Record<string, unknown>,
        });
      },
    );

    claude.on('exit', ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      log(`session ${sessionId} claude exited code=${exitCode} signal=${signal}`);
      // Only signal an UNEXPECTED death. closeSession() deletes the session
      // before killing, so its exit lands here as a no-op and stays quiet.
      if (!this.sessions.has(sessionId)) return;
      this.sessions.delete(sessionId);
      // Tell ext-aware clients (the bridge) the session is gone so they can
      // surface it and reopen, instead of finding out via an "unknown session"
      // error on the next prompt. The empty chunk just carries the _meta flag.
      if (this.extAware) {
        this.send(
          sessionId,
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
          { [EXT]: { sessionEnded: true, code: exitCode, signal } },
        );
      }
    });
  }

  /**
   * Apply a Claude planning tool to the session's task list. Returns true if it
   * WAS a planning tool (so the caller surfaces a `plan` update and suppresses
   * the raw tool call). Handles both incremental TaskCreate/TaskUpdate and the
   * legacy snapshot TodoWrite.
   */
  private applyPlanTool(session: Session, name: string, input: unknown): boolean {
    const i = (input || {}) as any;
    if (name === 'TaskCreate') {
      const subject = String(i.subject || i.description || '').trim();
      // Mirror Claude's sequential ids (#1,#2,…) so a later TaskUpdate's taskId lines up.
      if (subject) session.tasks.set(String(++session.taskSeq), { subject, status: 'pending' });
      return true;
    }
    if (name === 'TaskUpdate') {
      const t = session.tasks.get(String(i.taskId ?? ''));
      if (t) {
        if (i.status === 'deleted') session.tasks.delete(String(i.taskId));
        else {
          if (i.status) t.status = planStatus(i.status);
          if (i.subject) t.subject = String(i.subject);
        }
      }
      return true;
    }
    if (name === 'TodoWrite') {
      if (Array.isArray(i.todos)) {
        session.tasks.clear();
        session.taskSeq = 0;
        for (const td of i.todos) {
          const subject = String(td?.content || td?.activeForm || '').trim();
          if (subject)
            session.tasks.set(String(++session.taskSeq), { subject, status: planStatus(td?.status) });
        }
      }
      return true;
    }
    return false;
  }

  private send(sessionId: string, update: acp.SessionUpdate, meta?: Record<string, unknown>): void {
    const params: acp.SessionNotification = { sessionId, update };
    if (meta) (params as any)._meta = meta;
    this.conn.sessionUpdate(params).catch((e) => log('sessionUpdate failed', e));
  }

  // ---- permission broker (unix socket) -----------------------------------

  private startPermissionBroker(): void {
    if (existsSync(this.sockPath)) {
      try {
        unlinkSync(this.sockPath);
      } catch {
        /* ignore */
      }
    }
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        this.decidePermission(line)
          .then((resp) => sock.write(JSON.stringify(resp) + '\n'))
          .catch(() => sock.write(JSON.stringify({ behavior: 'deny' }) + '\n'));
      });
      sock.on('error', () => {});
    });
    server.on('error', (e) => log('permission broker error', e));
    server.listen(this.sockPath, () => log(`permission broker on ${this.sockPath}`));
    const cleanup = () => {
      for (const s of this.sessions.values()) {
        try {
          s.claude.kill();
        } catch {
          /* ignore */
        }
      }
      try {
        unlinkSync(this.sockPath);
      } catch {
        /* ignore */
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => {
      cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      cleanup();
      process.exit(0);
    });
  }

  /** A PermissionRequest from a session's claude -> ask the ACP client. */
  private async decidePermission(line: string): Promise<{ behavior: 'allow' | 'deny' }> {
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      return { behavior: 'deny' };
    }
    const sessionId: string = req.session_id;
    const session = this.sessions.get(sessionId);
    if (!session) return { behavior: 'deny' };

    const name: string = req.tool_name;
    const input = req.tool_input;
    // Correlate with the tool_call we already streamed, so the client's
    // permission UI references the same toolCallId; fall back to a fresh id.
    const match = session.pendingTools.find(
      (p) => p.name === name && p.inputKey === stableKey(input),
    );
    const toolCallId = match?.toolCallId || randomUUID();

    log(`permission ${sessionId}: ${name} -> asking client`);
    try {
      const res = await this.conn.requestPermission({
        sessionId,
        toolCall: {
          toolCallId,
          title: titleForTool(name, input),
          kind: kindForTool(name),
          status: 'pending',
          rawInput: input,
        },
        options: [
          { kind: 'allow_once', name: '允许', optionId: 'allow' },
          { kind: 'reject_once', name: '拒绝', optionId: 'reject' },
        ],
      });
      const outcome = res.outcome as any;
      if (outcome?.outcome === 'selected' && outcome.optionId === 'allow') {
        return { behavior: 'allow' };
      }
      return { behavior: 'deny' };
    } catch (e) {
      log('requestPermission failed', e);
      return { behavior: 'deny' };
    }
  }
}

// ---- helpers -------------------------------------------------------------

function stableKey(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * Turn an ACP prompt into the text we paste into the TUI, materializing image
 * blocks to temp files (the interactive TUI reads an image from a pasted
 * absolute path). Returns the temp files so the caller can unlink them after.
 */
function materializePrompt(blocks: acp.ContentBlock[]): { text: string; tempFiles: string[] } {
  const parts: string[] = [];
  const tempFiles: string[] = [];
  for (const b of blocks as any[]) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b?.type === 'resource_link' && b.uri) parts.push(`@${uriToPath(b.uri)}`);
    else if (b?.type === 'resource' && b.resource?.text) parts.push(b.resource.text);
    else if (b?.type === 'image' && typeof b.data === 'string') {
      const file = join(tmpdir(), `cc-acp-img-${randomUUID()}${extForMime(b.mimeType)}`);
      try {
        writeFileSync(file, Buffer.from(b.data, 'base64'));
        tempFiles.push(file);
        parts.push(file); // own line (parts join with \n) => TUI treats it as an image path
      } catch (e) {
        log('failed to materialize image block', e);
      }
    }
  }
  return { text: parts.join('\n'), tempFiles };
}

function extForMime(mime?: string): string {
  switch (mime) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.png';
  }
}

interface SessionExtras {
  mcpConfigJson?: string;
  additionalDirectories?: string[];
}

/** Pull the spawn-time extras (client MCP servers, extra dirs) out of a request. */
function sessionExtras(params: acp.NewSessionRequest | acp.LoadSessionRequest): SessionExtras {
  const p = params as any;
  const additionalDirectories = Array.isArray(p.additionalDirectories)
    ? p.additionalDirectories
    : undefined;
  return { mcpConfigJson: buildMcpConfig(p.mcpServers), additionalDirectories };
}

/** Map ACP McpServer[] to a `claude --mcp-config` JSON string (stdio/http/sse). */
function buildMcpConfig(servers: unknown): string | undefined {
  if (!Array.isArray(servers) || servers.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const s of servers as any[]) {
    if (!s?.name) continue;
    if (s.type === 'http' || s.type === 'sse') {
      out[s.name] = { type: s.type, url: s.url, headers: kvToRecord(s.headers) };
    } else if (s.type === 'acp') {
      continue; // UNSTABLE ACP-transport MCP isn't reachable via the CLI
    } else if (s.command) {
      out[s.name] = { command: s.command, args: s.args ?? [], env: kvToRecord(s.env) };
    }
  }
  return Object.keys(out).length ? JSON.stringify({ mcpServers: out }) : undefined;
}

/** ACP EnvVariable[]/HttpHeader[] ({name,value}) -> a plain record. */
function kvToRecord(items: unknown): Record<string, string> {
  const r: Record<string, string> = {};
  if (Array.isArray(items)) for (const x of items as any[]) if (x?.name) r[x.name] = String(x.value ?? '');
  return r;
}

/** Render the session's accumulated tasks as ACP plan entries (creation order). */
function renderPlan(session: Session): acp.PlanEntry[] {
  return [...session.tasks.values()].map((t) => ({
    content: t.subject,
    status: t.status,
    priority: 'medium' as acp.PlanEntryPriority,
  }));
}

function planStatus(s: unknown): acp.PlanEntryStatus {
  return s === 'in_progress' || s === 'completed' ? s : 'pending';
}

/** Zed sends @-mentions as resource_link with a file:// URI; claude wants a path. */
function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri.replace(/^file:\/\//, '');
    }
  }
  return uri;
}

/** File locations a tool touches — lets Zed show/follow the affected files. */
function locationsForTool(input: unknown): acp.ToolCallLocation[] {
  const i = (input || {}) as Record<string, any>;
  const path = i.file_path || i.path || i.notebook_path;
  if (typeof path === 'string' && path) {
    const loc: acp.ToolCallLocation = { path };
    if (typeof i.line === 'number') loc.line = i.line;
    return [loc];
  }
  return [];
}

function mapStopReason(stop: string): acp.StopReason {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'end_turn';
  }
}

function kindForTool(name: string): acp.ToolKind {
  const n = name.toLowerCase();
  if (n === 'read' || n === 'glob' || n === 'grep' || n === 'notebookread') return 'read';
  if (n === 'edit' || n === 'write' || n === 'notebookedit' || n === 'multiedit') return 'edit';
  if (n === 'bash' || n === 'bashoutput' || n === 'killshell') return 'execute';
  if (n === 'websearch' || n === 'webfetch') return 'fetch';
  if (n === 'task') return 'think';
  return 'other';
}

function titleForTool(name: string, input: unknown): string {
  const i = (input || {}) as Record<string, any>;
  if (i.file_path) return `${name}: ${i.file_path}`;
  if (i.path) return `${name}: ${i.path}`;
  if (i.command) return `${name}: ${String(i.command).slice(0, 60)}`;
  if (i.pattern) return `${name}: ${i.pattern}`;
  return name;
}

function toToolContent(content: unknown): acp.ToolCallContent[] {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content))
    text = content
      .map((c: any) => (typeof c === 'string' ? c : c?.text ?? JSON.stringify(c)))
      .join('\n');
  else if (content != null) text = JSON.stringify(content);
  if (!text) return [];
  return [{ type: 'content', content: { type: 'text', text: text.slice(0, 8000) } }];
}
