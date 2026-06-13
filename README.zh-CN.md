# claude-pty-acp

[English](./README.md) · **简体中文**

把**交互式 Claude Code** 封装成一个 **ACP（[Agent Client Protocol](https://agentclientprotocol.com)）** 服务端，让第三方客户端（Zed / JetBrains / neovim / 你自己的服务）以标准协议接入，**同时用量仍计入 Claude 订阅套餐（Pro/Max），而不是按 API/SDK 单独计费**。

它就是个标准 stdio ACP agent：任何 ACP 兼容客户端把它当子进程 spawn、走 stdio 上的 JSON-RPC 通信。没有私有接口、没有特化——能驱动官方 `claude-agent-acp` 的客户端，零改动就能驱动它。

## 为什么这样设计

自 2026-06-15 起，Anthropic 把订阅计费拆成两个池：

- **仍走订阅**：终端/IDE 里的**交互式** Claude Code、Claude web/桌面/移动端。
- **改走单独的 Agent SDK credit**：`claude -p`、Agent SDK、GitHub Actions、以及**所有通过 SDK 鉴权的第三方应用**（包括官方的 ACP 适配器 `claude-agent-acp`，它底层是 SDK）。

所以官方的 `claude-agent-acp` = **ACP + SDK**（走 credit）。
claude-pty-acp = **ACP + 交互式 PTY**（走订阅）：协议形状一样，Zed/neovim 等现成 ACP 客户端零改动就能连，但后端跑的是真实交互式 `claude` 进程，用量落在订阅里。

## 安装

前置条件：**本机装了 `claude` 且已登录订阅**（它驱动的是真实交互式 `claude`，这正是用量落在订阅路径的原因），以及 **Node.js ≥ 20**。

### 从 npm 安装（推荐）

```bash
npm install -g claude-pty-acp
```

这会装上一个全局命令 **`claude-pty-acp`**——它就是你的 ACP 客户端要运行的程序。包里已带编译好的 `dist/`，无需自己构建；postinstall 也会自动修复 node-pty 的 spawn-helper 执行位。

装完常用：

```bash
which claude-pty-acp                 # 绝对路径（GUI 客户端 PATH 精简时用得上）
npm install -g claude-pty-acp@latest # 升级
npm uninstall -g claude-pty-acp      # 卸载
```

然后把客户端指向它——见 [在 ACP 客户端中使用](#在-acp-客户端中使用)。

### 从源码安装（开发用）

```bash
git clone https://github.com/modelzen/claude-pty-acp.git
cd claude-pty-acp
npm install      # postinstall 自动修复 node-pty 的 spawn-helper 执行位
npm run build    # 编译到 dist/（客户端用 node dist/index.js）
```

开发时也可直接 `npm start`（= `tsx src/index.ts`）从源码跑。

> 底层 `claude` 二进制解析顺序：`CC_CLAUDE_BIN` → `PATH` → `~/.local/bin/claude` 等常见位置。GUI 启动器（如 Zed）的 PATH 往往精简，所以会回退到常见安装路径，避免裸 `claude` 找不到。

## 在 ACP 客户端中使用

`claude-pty-acp` 是**由客户端当子进程拉起**的。你不需要自己启动它、也不用让它常驻——客户端在你新建会话时 spawn 它，用完就回收。你只需让构建产物存在、并让客户端指向它。

### Zed

在 Zed `settings.json` 注册自定义 ACP agent。用 npm 全局安装后，直接指向 `claude-pty-acp` 命令即可：

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

然后打开 Zed 的 **Agent 面板**，选 **「Claude Code (claude-pty-acp)」** 对话。用法和官方 `claude-agent-acp` 完全一样，区别只是计费走订阅。

注意：

- 若 Zed 找不到 `claude-pty-acp`（GUI 应用的 `PATH` 往往精简），用 `which claude-pty-acp` 拿到的绝对路径：
  ```json
  { "command": "/ABS/PATH/to/claude-pty-acp", "args": [], "env": {} }
  ```
- 从源码（而非 npm）跑？指向构建产物：`{ "command": "node", "args": ["/ABS/PATH/claude-pty-acp/dist/index.js"] }`（若 `node` 不在 Zed 的 PATH 里，用 `which node` 的绝对路径）。
- Zed 不实现可选的流式预览扩展，所以是 **`thought` 模式**：抢跑预览出现在折叠的思考区，最终答案以块级权威文本到达（见 [流式](#流式快预览--准最终)）。不会重复。
- 任意环境变量（见 [环境变量](#环境变量)）可通过 `env` 对象传入，如 `"env": { "CC_PERMISSION_MODE": "acceptEdits" }`。

### neovim

走 CodeCompanion / avante 的自定义 ACP agent 配置，命令和参数与 Zed 相同：

```
command: claude-pty-acp     # 或 `which claude-pty-acp` 的绝对路径
args:    []
```

### 其它任意 ACP 客户端（或你自建的）

因为它对外只说标准 ACP（stdio），任何 ACP 客户端都用同一种方式驱动：**spawn `claude-pty-acp`，走它 stdin/stdout 上的 JSON-RPC**（换行分隔）。`stdout` 是协议通道——所有日志都走 `stderr`。（若从源码而非 npm 跑，则 spawn `node /ABS/PATH/claude-pty-acp/dist/index.js`。）

想最快看清一个客户端会走的协议路径，用自带的 test-client：

```bash
node test-client.mjs '用一句话介绍你自己' /path/to/workdir
# 或工具流式：
CC_PERMISSION_MODE=bypassPermissions node test-client.mjs '读取 README.md 第一行' .
```

它用 SDK 的 `ClientSideConnection` 走完整 ACP 握手，spawn claude-pty-acp，发 prompt，实时打印每条 `session/update`——这正是 Zed/neovim 会走的协议路径。

### 确认走的是订阅路径

会话进行时，确认拉起的子进程是交互式的：

```bash
ps -ax -o pid,command | grep -- '--session-id' | grep claude
# 期望：claude --session-id <uuid> --permission-mode default
# 不含 -p/--print；且环境无 ANTHROPIC_API_KEY → 走订阅 OAuth 凭据
```

更进一步：跑几轮后看订阅 usage 上涨、Agent SDK credit 不动（6/15 后），并可用 `claude --resume <uuid>` 在终端里无缝接管同一会话（transcript 同步）。

## 架构

```
ACP 客户端 (Zed / neovim / test-client)
   │  JSON-RPC over stdio  (initialize / session/new / session/prompt / session/update …)
   ▼
claude-pty-acp  ── src/index.ts          ACP framing (ndJsonStream + AgentSideConnection)
           ── src/acp-agent.ts      Agent 接口实现；transcript 块 → session/update；权限 broker
           ── src/claude-pty.ts     在 node-pty 里拉起交互式 `claude`（无 -p）
           ── src/permission-hook.mjs  PermissionRequest hook 桥接（claude → unix socket）
   │
   ├─ 输入：bracketed-paste 注入 prompt → PTY stdin
   ├─ 输出：tail ~/.claude/projects/<proj>/<session-id>.jsonl（结构化，零 ANSI 解析）
   ├─ 权限：claude 的 PermissionRequest hook ──unix socket──▶ claude-pty-acp
   │        ──▶ ACP session/request_permission ──▶ 客户端弹窗 ──▶ 决策回传放行/拒绝
   └─ 进程：claude --session-id <uuid> --permission-mode default   ← 交互式，订阅路径
```

### 流式：快预览 + 准最终

回复用两个数据源，职责分离，兼顾「首 token 快」与「最终逐字一致」：

- **预览通道 `agent_thought_chunk`**：从 PTY 字节流用 headless 终端网格（`@xterm/headless`）重建 TUI 屏幕，把正在生成的回复**逐行抢跑**发出（见 `src/grid-preview.ts`）。它给的是**快首 token**——实测比 transcript 块级落盘早数秒（一段三段散文：预览首行 ~8.6s vs 权威终稿 ~14s）。它是渲染产物、容错，可能缺代码围栏/有渲染噪声，所以只进「草稿语义」的思考区。
- **正式通道 `agent_message_chunk`**：transcript JSONL 的**块级权威文本**（每个 thinking / text / tool_use 块写完即落盘），逐字 == claude、保留围栏/缩进/markdown 结构。这是用户看到的**最终答案**。

「不乱流」是**结构性保证**：正式答案只来自 transcript，grid 预览的任何缺陷都被关在思考区、进不了正式回复。预览只负责把「等待权威文本」那段时间用实时草稿盖住。两通道靠 `ClaudeSession` 的 `'preview'` 与 `'text'` 事件分发。为让长回复不滚出视口（Ink 原地重绘、从不真滚动），PTY 用很高的 `rows`（默认 1000），grid 一帧即可完整捕获，无需脆弱的跨帧拼接。

> 注：grid 预览与 ACP `agent_thought_chunk` 是 append-only，且 Zed 不读 `messageId`、对 message chunk 是追加（重发整段会重复）——所以「先预览后校正」只能靠**通道分离**，不能靠替换已发内容。

#### 可选扩展：流式预览 + 最终全量替换（`_meta`）

为了让支持的客户端把**预览直接流进正式回复气泡**（打字机手感）、再用权威文本**全量替换**，本项目在 ACP 官方的 `_meta` 扩展位上加了一个**向后兼容**的扩展（不懂的客户端忽略 `_meta`，照常走安全回退，绝不重复）：

- **客户端 opt-in**（`initialize` 的 `clientCapabilities._meta`）：
  ```json
  { "claude-pty-acp/streaming-preview": { "provisionalReplace": true } }
  ```
  agent 会在 `initialize` 的 `agentCapabilities._meta` 同键回告 `{ provisionalReplace: true, version: 1 }` 表示可用。
- **provisional 流式块**：`session/update` 的 `agent_message_chunk`，`SessionNotification._meta` 带 `{ "claude-pty-acp/streaming-preview": { "provisional": true, "turn": N } }`。客户端应**实时渲染**、并记住它可被替换。
- **最终替换块**：turn 结束时一条 `agent_message_chunk`，`_meta` 带 `{ "claude-pty-acp/streaming-preview": { "replaceProvisional": true, "turn": N } }`，`content` 是**逐字权威全文**。客户端收到后应**丢弃本 turn 所有 provisional 块、改渲染这条**。
- **会话终止信号**：claude 子进程**意外退出**（崩溃）时，发一条 `agent_message_chunk`（`content` 为空），`_meta` 带 `{ "claude-pty-acp/streaming-preview": { "sessionEnded": true, "code": …, "signal": … } }`。opt-in 客户端应据此把会话标记为已结束、提示用户并重开（凭存下的 sessionId 走 `loadSession` 恢复），而不是等下一次 `prompt` 抛 `unknown session`。主动 `session/close` 不发此信号。

三种模式（`CC_PREVIEW` 环境变量可强制覆盖；缺省按客户端能力自动选）：

| 模式 | 触发 | 预览去向 | 适用 |
|---|---|---|---|
| `replace` | 客户端 opt-in 或 `CC_PREVIEW=replace` | 正式气泡（provisional）→ turn 末全量替换 | 实现了本扩展的客户端（如自建 bridge） |
| `thought` | 缺省（未 opt-in，如 Zed） | 思考区（`agent_thought_chunk`） | 任意标准 ACP 客户端，零重复 |
| `off` | `CC_PREVIEW=off` | 不发预览 | 只要块级权威、最干净 |

> Zed 当前不实现本扩展，所以在 Zed 里是 `thought` 模式（预览在折叠的思考区，正式气泡仍整块出）。要在正式气泡里看到打字机效果，客户端需实现上面的 provisional/replace 契约——这正是自建客户端/bridge 该做的。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CC_CLAUDE_BIN` | 自动解析 | claude 二进制路径（覆盖自动解析；GUI 环境建议设绝对路径） |
| `CC_MODEL` | 跟随 claude 默认 | 传给 `--model` |
| `CC_PERMISSION_MODE` | `default` | `default`/`acceptEdits`/`bypassPermissions`/`plan`/`dontAsk`/`auto` |
| `CC_PREVIEW` | 自动按客户端能力 | 流式预览模式 `replace`/`thought`/`off`（见上「流式预览扩展」） |
| `CC_TURN_TIMEOUT_MS` | `0`（关闭） | 单轮超时兜底毫秒：turn 超时则中断并以 `cancelled` 收尾。长期运行的服务（如聊天 bridge）建议设（如 `600000`），防止卡住的 turn 永久挂起。 |

`default` 模式下，需要审批的工具（Write/Edit/Bash 等）会经权限 broker 转发到 ACP 客户端弹窗，由客户端决策放行/拒绝（见下方「已实现」）。安全的只读工具由 Claude Code 自动放行、不打扰。

## 已实现（均已实测验证）

- **Phase 1 — 流式对话 + 工具流式**：ACP 客户端 → claude-pty-acp → 交互式 claude（PTY，无 -p）→ transcript 块级 → `session/update`。对话、多轮 agentic（Bash/Read/Write）工具调用均流式可用。
- **Phase 2 — 权限转发**：claude 的 `PermissionRequest` hook 经 unix socket 转给 claude-pty-acp，再 `connection.requestPermission(...)` 交给 ACP 客户端弹窗，决策回传放行/拒绝。allow 与 deny 两条路径均已验证（见 `probe-perm.mjs`）。
- **Phase 3 — 会话恢复**：ACP `loadSession` + `claude --resume <id>`。新进程恢复旧会话、回放 transcript 历史（user/assistant/tool 调用）到客户端，记忆跨 claude-pty-acp 重启存活。验证见 `test-resume.mjs`（建立暗号 → 杀进程 → 新进程 loadSession → 回忆成功）。
- **图片输入**：ACP `image` content block 落地为临时文件，注入时把其绝对路径单独成行 bracketed-paste，交互式 TUI 自动读图（`usePasteHandler`→`isImageFilePath`），纯字节流、不需剪贴板。`promptCapabilities.image=true`。
- **client MCP 转发**：`newSession.mcpServers`（stdio/http/sse）映射成 `claude --mcp-config '<json>'` 启动参数；`additionalDirectories`→`--add-dir`。声明 `mcpCapabilities{http,sse}`。仅新会话生效。
- **plan（任务进度）**：claude 的 `TaskCreate`/`TaskUpdate`（增量）与旧版 `TodoWrite`（快照）累积成会话任务表，逐次发 `session/update:plan`（PlanEntry，含 pending/in_progress/completed 状态），不再当普通 tool_call 展示。
- **健壮性**：cwd 规范化（/tmp→/private/tmp，避免信任对话框复现）、信任对话框兜底自动确认、claude 二进制多路径解析（适配 Zed 精简 PATH）、node-pty spawn-helper 执行位 postinstall 修复、进程退出回收子 claude、cancel→`cancelled` stopReason、可编译 dist 产物。

## ACP 合规性

claude-pty-acp 是一个**标准 stdio ACP agent**，对外只说 ACP（JSON-RPC over stdio），不暴露任何私有接口——所以任何 ACP 客户端（Zed、neovim、以及将来**通用的 ACP↔聊天 bridge**）都用同一种方式 spawn 它。

- **必需方法**全部实现：`initialize` / `newSession` / `authenticate` / `prompt` / `cancel`。
- **可选能力**：`loadSession`、`session/close`（`sessionCapabilities.close`，主动回收单会话的 claude 进程，适配长期运行的服务端）已声明并实现。其余可选方法（modes/forkSession/listSessions/setSessionMode…）未实现，且不声明对应 capability，故合规客户端不会调用。
- **长运行健壮性**：单轮超时兜底（`CC_TURN_TIMEOUT_MS`）、claude 崩溃时进行中的 turn 立即以 `cancelled` 收尾（不会让 `prompt()` 永挂）、会话意外终止时给已 opt-in 扩展的客户端发 `_meta.sessionEnded` 信号（见上）。
- **agent→client**：`session/update`（agent_message_chunk / agent_thought_chunk / tool_call(+locations) / tool_call_update / plan / user_message_chunk）、`session/request_permission`。
- **initialize** 返回 `agentInfo`（名称/版本）、`agentCapabilities`（`loadSession`、`mcpCapabilities{http,sse}`、`promptCapabilities{embeddedContext,image}`、streaming-preview `_meta` 扩展），不声明 authMethods（后端用本地订阅凭据，无需 ACP 层鉴权）。

## Roadmap

- **逐 token 流式**：已落地「grid 预览（thought 通道）+ transcript 权威（message 通道）」双通道（见上「流式」）。预览目前是**逐行**（grid 行级）粒度；进一步做逐 token 需在 grid 行内做稳定前缀的字符级 diff。预览对**代码块**系统性失真（Ink 渲染丢围栏），可考虑预览时对疑似代码降级处理。`@xterm/headless` 与 Ink 渲染存在版本耦合，已作可降级组件（解析失配时正式通道不受影响、仍走 transcript）。
- **多会话并发与资源回收**；权限请求与 tool_call 的 id 关联（当前 PermissionRequest 偶尔早于 tool_use 落盘，会用临时 id，不影响功能）。
- 仍可补的可选 ACP 能力（plan/images/client-MCP 已落地）：运行时模式切换（`setSessionMode`+`current_mode_update`，TUI 只能注 Shift+Tab 循环+读屏，脆弱）、slash commands 列表（需自建命令清单）、listSessions/forkSession、运行时 model 切换（`/model` 是 picker，建议仅新会话 `--model`）；usage_update 在交互式下无结构化来源，从略。

## 现状与局限

- 这是一个实验性、可行性阶段的项目。Phase 1/2/3（流式对话 + 工具流式 + 权限转发 + 会话恢复）均已端到端实测，但仍有粗糙之处。
- 它构建在 Claude Code 的内部、未公开行为之上（TUI 握手、transcript 格式、hooks schema），可能随 Claude Code 版本变化或失效。
- 它面向**个人、在自己机器上的交互式使用**而设计。

## 免责声明

本项目是一个独立的个人兴趣项目，仅供**个人使用、学习与互操作性研究**。它与 Anthropic **无任何关联、未获其背书或赞助**；「Claude」「Claude Code」归其各自所有者所有。

它只是通过伪终端驱动官方 `claude` CLI，依赖随时可能变化的内部行为。请**自用**，并遵守 [Anthropic 服务条款](https://www.anthropic.com/legal/consumer-terms)及你所用套餐的条款。本项目**按「现状」提供，不附带任何形式的担保**；你需对自己的使用方式负责，作者不对由此产生的任何后果（包括对你账户的任何影响）承担责任。若你不确定某种用法是否合适，请优先使用官方工具。

## 许可证

[MIT](./LICENSE) © Clay (ClayCheung)
