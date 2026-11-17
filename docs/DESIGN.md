# dsh-rulebook 设计稿

> 状态：第 4 版（含 AI 整理），已实现并通过本地冒烟测试（57 项）。改动依据复核意见与后续需求。
> 目标运行时：本机 DeepSeek Harness 0.2.2-rc.3（Desktop profile，DSH_PROFILE=desktop）。

---

## 1. 目标与动机

DSH 的长期记忆由 dsh-hindsight 承担，它是语义检索库：内容入库后，只有模型主动调用 `hindsight_recall` 才会进入上下文。用户提出的通用要求（例如「提交、确认这类操作必须由我明确允许，才能代替我执行」）存进去之后，在新会话里未必生效，因为模型这一轮没有检索。

需要一个常驻规则层：规则每步注入系统提示词，跨会话、跨上下文压缩稳定存在，不依赖检索。

写入通道只走斜杠命令 `/rule`，由用户自己触发；模型侧没有任何写规则的接口。

### 与 `@leiyi-works/dsh-keyrule` 的关系

参考实现，只取四处做法：三层文件定位与工作区 key 的规范化；`readCached` 的 mtime + size 缓存；`cordis.patch.yml` 的 bundle 结构；`ctx.systemPrompt` 的动态文本 provider 写法。

不取它的 `standing_rules` 工具、`web_logins` 工具、密钥目录、SSH 配置自愈。

**注入接缝与 keyrule 不同，改用 `systemPrompt.section`**（第 1 版曾写 `context`），依据见 §4.1。

---

## 2. 交付物与目录布局

```
<插件目录>\
├── package.json          # type: module + dsh.bundle.patch → ./cordis.patch.yml
├── cordis.patch.yml      # - insert: [{ id: rulebook, name: 'dsh-rulebook', config: {...} }]
├── index.js              # Host 插件主体（唯一运行时代码文件）
├── README.md             # 交付说明，同时作为插件详情页正文
├── locale/
│   ├── en.json           # meta.title / meta.description
│   └── zh.json
├── icon.svg
├── test/
│   └── smoke.mjs         # 不依赖宿主的冒烟测试（假 ctx 驱动命令/注入/guard）
└── docs/
    └── DESIGN.md         # 本文件
```

`package.json` 必须含：

```json
{
  "name": "dsh-rulebook",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md", "docs"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`type: module` 决定 `export function apply` 能否按 ESM 解析；`dsh.bundle` 决定安装后是否作为 bundle 层挂载，缺了会退化成普通依赖、不进 profile 的 bundle 列表。

`index.js` 的服务依赖：

```js
export const inject = ['commands', 'sessions', 'systemPrompt', 'tools']
```

`workingDirectory` 不在硬依赖里：headless、tui 这类 profile 里没有这个服务，Cordis 的 `inject` 语义是等待服务，服务不到插件就永远不激活。改用 `ctx.inject(['workingDirectory'], …)` 可选注入，取不到时退到 `session.header.cwd`。

---

## 3. 三层规则文件

| 层 | 路径 | 可见范围 |
|---|---|---|
| 全局 | `$DSH_HOME/rulebook/global.md` | 所有 profile 的所有会话（见下方说明） |
| 工作区 | `$DSH_HOME/rulebook/workspaces/<规范化路径>.md` | 该工作区所有会话 |
| 本会话 | `$DSH_HOME/rulebook/sessions/<会话 id>.md` | 仅当前会话 |

`$DSH_HOME` 取 `process.env.DSH_HOME`（trim 后非空才采用），否则 `~/.dsh`。

**可见范围的实际含义**：`DSH_HOME` 是全机器级目录，不属于单个 profile（desktop profile 本身在 `<DSH_HOME>/profiles/desktop`）。所以全局层对 web / tui / desktop 各 profile 都可见。要改成 profile 私有，把配置项 `rulebookDir` 指向 `$DSH_PROFILE_DIR/rulebook` 即可，无需改代码。

### 工作区 key 规范化

与 keyrule 一致：`cwd` 的 `\` 换成 `/` → 去掉末尾的 `/` → 转小写。文件名再把 Windows 非法字符 `\ / : * ? " < > |` 换成 `_`。

```
C:/work/dsh/demo
  → c:/work/dsh/demo
  → c__work_dsh_demo.md
```

### 会话 id → 文件名

先按 `/^[A-Za-z0-9_.:-]{1,160}$/` 校验；不通过时把非法字符换成 `_` 并截断到 160 字符。

### 文件格式

- UTF-8 文本，行式 Markdown 列表：每条规则一行，前缀 `- `。
- `#` 开头的行是注释，不计入规则条目，但会随正文一起注入模型。
- 新建文件时写入一行自动文件头：

```
# 长期规则（由 /rule 命令维护，可直接手工编辑）
```

- **注入正文的定义**：文件全文去掉那一行自动文件头后的内容。剩余为空 → 该层整块省略；剩余非空（哪怕只剩注释）→ 注入。
- 文件不存在时不创建空文件，注入时跳过该层；目录不存在时，只有真正写入规则才 `mkdir -p`。

---

## 4. 注入

### 4.1 为什么用 `section` 而不是 `context`

第 1 版按 keyrule 的写法用 `ctx.systemPrompt.context(...)`。复核本机源码后发现这条路不满足目标：

| | `systemPrompt.section` | `systemPrompt.context` |
|---|---|---|
| 渲染函数 | `renderPrompt(assembly)` 取 `assembly.sections` | `renderContextSections(assembly)` 取 `assembly.contexts` |
| 落到哪 | system 消息（`createSystemMessage`） | user 角色消息，包在 `<system-reminder>` 里，前缀 "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." |
| 何时重发 | 每步重新装配，随请求重发 | `RuntimeContextProjection.project` 里 `deepEqualJson` 相等就**不再提交**新消息；只有内容变化才追加一条快照 |
| 可否被抑制 | 无抑制机制 | `suppressRuntimeContext()` 或 `systemPrompt.includeRuntimeContext: false` 会移除可选 context |

依据（本机 0.2.2-rc.3 源码）：

- `dsh-system-prompt/lib/index.js:120` — `renderPrompt` 只取 `assembly.sections`。
- `dsh-system-prompt/lib/index.js:153-158` — `renderContextSections` 只取 `assembly.contexts`。
- `dsh-agent-loop/src/runtime-context.ts:164-180` — context 快照被包成 `<system-reminder>` 的 user 消息；`deepEqualJson` 相等时返回 `undefined`。
- `dsh-agent-loop/src/agent.ts:300` — `assemble()` 在每个 step 前调用，section 文本函数每步重新求值。
- `dsh-agent-loop/src/agent.ts:448` — `renderPrompt(assembly)` 的结果交给 `SystemPromptProjection` 维护 system 消息节点。

关于「压缩」：没有直接核实压缩器是否处理 system 消息。成立且已核实的论据是另一条——规则正文来自每步重新装配的 section，不来自会话历史，因此不依赖压缩器的取舍。

### 4.2 注册方式

```js
ctx.effect(() =>
  ctx.systemPrompt.section({
    name: 'rulebook',
    order: cfg.order,
    interpolate: false,
    text: renderRules,
  }),
)
```

- `name` 全局唯一。hindsight 用的是 `section`，但名字不同，section 注册按名字区分，互不冲突。
- `order` 默认 **700**：落在 policy 区（`PLAN_POLICY` 500、`TEAM_POLICY` 600 之后，`PTC_ONLY` 800 之前）。`SECTION_ORDERS` 全量：`HARNESS_IDENTITY` -1000、`DEPLOYMENT_PERSONA_PREFIX` 0、`PLAN_POLICY` 500、`TEAM_POLICY` 600、`PTC_ONLY` 800、`FILE_REFERENCE` 900、`TOOL_BASH` 1000 …… `TOOLS_SDK` 5000、`DELIVERABLE_FILE_REFERENCES` 9000、`STRUCTURED_OUTPUT` 9900、`HARNESS_SOURCE` 10000、`WEB_SURFACE` 10100、`DEPLOYMENT_PERSONA_SUFFIX` 10200。order 可配置。
- `interpolate: false`：提示变量语法是 `{{name}}`，开着会把规则正文里的 `{{...}}` 当成变量引用并抛 "unknown prompt variable"，让整次请求失败。关掉则按字面保留。
- 不设 `complete`（`complete: true` 的段会独占整个提示）。

### 4.3 缓存

`readCached(file)`：按 `mtimeMs + size` 缓存正文，`statSync` + `readFileSync` 同步读取（提示上下文 provider 必须是同步的）。文件改动 → 下一次模型请求即生效，不重启、不重载插件。命令写完文件后主动作废该文件的缓存项，避免同毫秒内同尺寸的改动被缓存吞掉。

### 4.4 注入预算

单层上限 `maxChars`（默认 3000），三层合计上限 `totalMaxChars`（默认 6000）。合计超限时按各层正文长度**按比例**切分，每层保底 200 字符，再各自截断并标注：

```
…（本层规则过长，已截断）
```

段首与段尾不占配额。`/rule list` 末尾报当前正文合计字符数，便于观察实际注入量。

### 4.5 注入文本全文

三层都存在时的完整形态：

```
## 长期规则（用户自己维护，必须遵守）

以下内容是用户写下的长期约定，每一步模型提示都会重新出现一次。与当前任务是否相关都要遵守：动手前先对照一遍，发现冲突先停下来处理。与用户当次的明确指令冲突时，以当次指令为准，并提示用户这条长期约定与当次指令不一致、是否要更新规则。

### 全局规则（~/.dsh/rulebook/global.md）

- 提交、确认这类操作必须由我明确允许，才能代替我执行。

### 工作区规则（~/.dsh/rulebook/workspaces/c__work_dsh_demo.md）

- 本目录下的改动先跑一遍 lint 再提交。

### 本会话规则（~/.dsh/rulebook/sessions/session-3.md）

- 这次只处理 README，不要改代码。

以上规则由用户通过 `/rule` 命令维护：全局层用 `/rule add <文本>`（等价于 `/rule add -g <文本>`），工作区层用 `/rule add -w <文本>`，本会话层用 `/rule add -s <文本>`，删除用 `/rule rm`。你没有写入规则的通道，也不能直接改写这些文件。用户提出新的长期约定时，不要只口头答应：请提示用户用 `/rule add` 把规则写下来。
```

规则：

- 段首与段尾是插件代码里的固定常量（即使三层都没有规则也注入），让模型知道规则由用户通过 `/rule` 维护。
- 某层正文为空时，**整块省略**（连标题和路径一起省掉）。
- 段首里「与当次明确指令冲突时以当次指令为准并提示用户」是必须出现的语义。

### 4.6 渲染失败不得拖垮请求

`section.text` 的返回值直接参与装配，没有外层捕获。`renderRules` 最外层套 try/catch，失败时返回段首 + 一行降级说明 + 段尾：

```
（长期规则本次未能载入：<原因>）
```

`readCached` 内部已 catch；`path.resolve`、路径拼接、子智能体判定等位置再抛一次，也只是降级，不会让整次请求失败。

### 4.7 会话与工作区的解析

section 文本函数收到的装配上下文在类型上只声明了 `scope` 与 `signal`，运行期实际还带 `agent`、`modelSelection`（见 `dsh-agent-loop/src/index.ts:336-337` 里 `context.agent?.options.provider`）。解析顺序：

1. `context.agent`（运行期确实带）
2. `context.scope`（按 `Agent` 形态判断：有字符串 `id`）
3. `context.session`

拿到 agent 后：会话对象取 `agent.session`，取不到再退 `ctx.sessions.get(agent.id)`；工作目录取 `ctx.workingDirectory.get(session)`，取不到再退 `session.header.cwd`；会话 id 取 `session.id`；子智能体判定 `session.header.origin === 'subagent'`。

`includeSubagents` 为 false 时，子智能体会话不注入。

---

## 5. 命令通道

### 注册

```js
ctx.commands.register({
  name: 'rule',
  description: '维护长期规则（全局 / 工作区 / 本会话三层）。',
  input: { hint: 'add [-g|-w|-s] <文本> | list | rm <ID> [ID...] | help' },
  recordInput: false,
  handler,
})
```

- 命令名必须匹配 `/^[a-z][a-z0-9_-]*$/`；本 profile 现有内建命令为 compact / feedback / goal / permission / plan / export，`rule` 不冲突。
- `recordInput: false`：`CommandDefinition.recordInput` 默认是 `true`，命令原文会写进会话日志的 `command/run` 事件。规则里可能有敏感约定，显式关掉。
- `handler(invocation)` 返回 `{ kind: 'success', text }` 或 `{ kind: 'error', text }`，`text` 必须是非空字符串。
- `invocation.rawInput` 是命令名之后的**全部原文、含前导空格**，解析前先 trim。
- `invocation.agent` 的**基础类型**是 `{ readonly id: SessionId }`（`dsh-agent/src/types.ts`），`session` / `options` / `ctx` 由 agent-loop 在运行期补齐。因此优先用 `invocation.agent.session`，取不到再退 `ctx.sessions.get(invocation.agent.id)`。

### 语法

```
/rule <子命令> [层标志] [参数...]
```

层标志（三选一，最多给一个）：`-g` / `--global`（全局，缺省即全局）、`-w` / `--workspace`（工作区）、`-s` / `--session`（本会话）。

| 子命令 | 行为 |
|---|---|
| `add <文本>` | 追加一条规则到指定层。文本取剩余全部原文，去掉首尾空白，不做引号解析。层标志从参数开头剥离，其余原文保持不变。 |
| `list` | 列出三层的路径、每条的 ID、字符用量。 |
| `rm <ID> [ID...]` | 按 ID 删除一条或多条规则。 |
| `help` | 打印用法。 |

`rm` 的两种语义：

- **ID**：形如 `g:3f2a1c`，首字母是层（`g` 全局 / `w` 工作区 / `s` 本会话），后面是 `sha256(层 + 归一化文本)` 的前 6 位十六进制。ID 由内容派生、**不落盘**，规则文件仍是干净的 `- 规则文本`。
- ID 随文本变化：改过一个字就是另一条规则，要重新 `/rule list` 取新 ID。
- 不做片段匹配：一个片段可能命中多条，删完说不清删了哪些；也不按序号，因为序号会随删除前移。

多个层标志同时出现 → 错误。未知子命令 → 错误并附用法。

**写回时的保留规则**：`rm` 改写文件时保留所有非规则行（自动文件头、`#` 注释行原样保留），只删除命中的 `- ` 行。用户手写的注释不会被命令抹掉。相应地，`#` 注释行永远不会被 `/rule rm` 删除，要删得手工改文件。

### 去重与并发

- `add` 先做归一化比对（trim + 折叠内部连续空白 + 转小写），命中已有规则时返回「已存在，未重复写入」，不写第二行。
- 写文件走「同目录临时文件 + `rename`」的原子替换，避免读到半截文件。它不解决两个进程同时 read-modify-write 的丢更新，那是 last-writer-wins，写在已知边界里。

### 输出示例

`/rule list`：

```
全局规则  ~/.dsh/rulebook/global.md
  1. 提交、确认这类操作必须由我明确允许，才能代替我执行。
工作区规则  ~/.dsh/rulebook/workspaces/c__work_dsh_demo.md
  （无）
本会话规则  ~/.dsh/rulebook/sessions/session-3.md
  1. 这次只处理 README，不要改代码。

正文合计 96 字符（单层上限 3000，三层合计上限 6000）
```

`add` 的成功回执显示整理后的规则正文与 ID（因为写入的是 AI 整理后的文本，用户需要当场确认有没有理解歪）：

```
已写入全局层：~/.dsh/rulebook/global.md
  整理后：提交、确认这类操作必须由我明确允许，才能代替我执行。
  ID g:2b68b6（该层现有 1 条规则）
```

> 第 1 版曾刻意不回显正文（怕规则里有敏感约定）。启用 AI 整理后改为回显：不回显用户就无法发现整理错误。这是第 14 节的修订。

---

## 6. 模型侧无写入通道 + guard

### 不注册任何写规则的工具

插件不调用 `ctx.tools.register`。模型拿不到任何写规则的接口。

### guard（纵深防御）

```js
ctx.effect(() =>
  ctx.tools.guard((execution) => {
    // 返回字符串 = 拒绝理由；返回 undefined = 放行
  }),
)
```

`ToolGuard = (execution: Readonly<ToolExecution>) => string | ToolGuardDenial | undefined`，同步、只拒绝。`ToolExecution` 带 `name` 与 `arguments: unknown`。guard 在工具执行前生效，且在 pre-execute 策略与审批之后检查（`dsh-tools/src/pipeline.ts:214`：`const denial = decision.kind === 'allow' ? this.tools.checkGuards(exec) : decision`）。

覆盖范围（配置项 `guardedTools`，默认 `["write", "edit", "pwsh", "terminal_send"]`）：

- `write` / `edit`：取 `arguments.file_path`，去引号、`~` 展开、相对路径按会话工作目录 resolve，再判断是否落在规则根目录之下（Windows 下不区分大小写）。
- `pwsh`：取 `arguments.command`；`terminal_send`：取 `arguments.text`。与规则根目录的多种写法（原生、反斜杠、正斜杠、小写）做子串比对。
- **不含 `run_code`**：PTC 的子调用同样过 guard——`dsh-tool-executor-ptc/src/ptc.ts:597` 的每个子调用都走 `executor.prepare(input)`，而 `prepare` 里就有 `checkGuards`（`dsh-tools/src/pipeline.ts:214`）。所以 `write`/`edit`/`pwsh` 在 PTC 模式下照常命中，`run_code` 的 `code` 文本匹配既多余又有害：代码里出现规则目录的路径字符串就拒绝，连读取、注释、日志输出都误伤，而它防不住的（代码拼路径）本来也防不住。

拒绝文本：

```
dsh-rulebook：拒绝访问规则目录（~/.dsh/rulebook/global.md）。规则文件只能由用户通过 /rule 命令写入；模型侧读取规则请用 /rule list。
```

按路径子串匹配会连读取一起拦（`Get-Content` 也被拒）。规则文件本来允许用户手工编辑，模型读一下确认内容却不行，行为不一致；这里选择改文案而不是解析命令——解析命令超出字符串匹配的能力范围。模型要读规则内容请用 `/rule list`。

### 已知边界（写进 README，不宣称是安全边界）

- guard 是字符串匹配层面的防护，挡不住变量拼接（`$p = ...; Set-Content $p`）、符号链接、编码绕过、路径别名。
- 只覆盖 `guardedTools` 列出的工具名；`terminal_open` 只开窗口（实际命令走已覆盖的 `terminal_send`），但 `bash` 等其它 shell 工具不在覆盖范围内。
- guard 在工具执行前生效，无法撤销已经发生的写入。
- 真正的边界是「模型没有写规则的接口，规则文件由用户自己维护」；guard 只是第二道网。

---

## 7. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `rulebookDir` | `$DSH_HOME/rulebook` | 规则根目录。绝对路径直接用；`~` 展开；相对路径按插件目录解析。 |
| `maxChars` | `3000` | 单层正文注入上限，超出截断并标注。 |
| `totalMaxChars` | `6000` | 三层合计上限，超出按比例截断，每层保底 200 字符。 |
| `order` | `700` | 提示 section 排序，见 §4.2。 |
| `includeWorkspaceRules` | `true` | 是否注入工作区层。 |
| `includeSessionRules` | `true` | 是否注入本会话层。 |
| `includeSubagents` | `true` | 子智能体会话是否也注入。 |
| `commandName` | `rule` | 斜杠命令名。 |
| `guardEnabled` | `true` | 是否注册 guard。 |
| `guardedTools` | `["write","edit","pwsh","terminal_send"]` | guard 覆盖的工具名。 |
| `cleanupSessionFiles` | `false` | 会话被删除时是否清掉它的会话规则文件。默认关：会话是否真被删除、删除动作与 `session/disposed` 的先后没有可靠的单一判据，误删用户数据不可逆。残留文件无害——它只在那个会话 id 再次成为当前会话时被读到。 |

配置读取在 `readConfig()` 里做类型归一与范围检查，未知键忽略；不声明 `export const Config`（keyrule 同样没有 Config 却在 `apply(ctx, config)` 里读配置）。

---

## 8. 与 hindsight 的关系

- 两者不冲突。hindsight 用 `systemPrompt.section`，本插件也用 `systemPrompt.section`，但 section 按**名字**区分注册，名字不同就不会冲突。
- 工具名不重叠：本插件不注册任何工具。
- 数据一个在远端服务（hindsight），一个在本地文件（rulebook）。
- 本插件不接管、不修改 hindsight 的任何配置，也不读它的数据。

---

## 9. 非目标

- 不写 `~/.dsh/AGENTS.md`，也不写任何项目里的 `AGENTS.md`。
- 不依赖审批接缝，在 `approval: never` 下完整工作。
- 不做 Web 面板、不做设置页。第一版只要命令和注入。
- 不做密钥管理、浏览器登录扫描、SSH 配置维护。

---

## 10. 安装方式

主路径（本机 CLI）：

```
dsh plugin --profile desktop add link:/path/to/dsh-rulebook-plugin
```

`dsh plugin` 把参数转交给 profile 目录里的 pnpm；插件被挂载成 profile 的一层，依赖 `package.json` 里的 `dsh.bundle.patch`。若该命令在 desktop profile 上不生效（本机 `dsh --profile desktop` 报 "profile desktop is managed exclusively by the Electron application"），改用 Profile 的插件管理器安装同一个目录，或让宿主用插件管理器安装该目录绝对路径。三条路都只新增这一个 bundle，不改权限预设，不动其它插件。

---

## 11. 验证步骤

### 11.1 确认注入生效

1. `/rule add -s 这是一条验证规则`（本会话层）。
2. 在同一会话里问模型：「我之前定过哪些长期约定？」——模型应能复述出这条规则，且不需要调用任何检索工具。
3. 换一个新会话再问一次：全局层与工作区层的规则仍应出现，本会话层的规则不应出现。
4. 更直接的证据：`/rule list` 确认文件路径与内容，再看模型请求的 **system 消息**里是否出现「## 长期规则（用户自己维护，必须遵守）」段首。会话日志里能看到这条 system 消息。

### 11.2 确认模型写不进去

1. 对模型说：「把『以后所有提交都要先问我』写进规则文件。」
2. 模型调用 `write` / `edit` / `pwsh` 写规则文件时会被 guard 拒绝，工具结果里带「拒绝访问规则目录」。
3. 模型被拒绝后应转而提示用户用 `/rule add`。若模型仍反复尝试，属于提示词效果问题，不影响写入通道的封闭性。
4. 复核：`/rule list` 与文件 mtime 均未变化。

注：原生工具模式下模型直接调用 `write`/`edit`/`pwsh`；PTC / Code Mode 下经 `run_code` 间接调用，子调用会重新进入调度器的 `prepare`（含 `checkGuards`），拒绝同样生效。两种模式都按上面的形态验证即可。

### 11.3 确认改文件后下一次请求就更新

1. 用记事本直接改 `<rulebookDir>/global.md`，加一行 `- 手工改的文件要立刻生效`，保存。
2. 不重启、不重载插件，直接在同一个会话里发一句话，模型应看到新规则。
3. 规则内容变了会改动 system 消息的渲染文本，`SystemPromptProjection` 会相应更新 system 消息节点，模型在下一次请求即看到新内容。

### 11.4 确认命令面

1. `/rule help` 打印用法。
2. `/rule add -w 工作区测试规则`、`/rule add -s 会话测试规则`、`/rule add 全局测试规则`，各写一层。
3. `/rule list` 显示三层与每条规则的 ID。
4. `/rule rm 1` 删掉全局层第 1 条；`/rule rm -w 测试` 删掉工作区层命中的行；`/rule rm 测试` 三层都搜。
5. 在文件里手写一行 `# 我的注释`，再执行一次 `/rule rm`，确认注释行被保留。
6. 同一条规则连打两次 `/rule add`，确认第二次提示「已存在」。

---

## 12. 已定下的选择

1. 包名 `dsh-rulebook`，bundle 行 id `rulebook`，命令名 `/rule`。
2. 注入走 `systemPrompt.section`，`order` 默认 700，`interpolate: false`。
3. 规则文件用行式 Markdown 列表（`- ` 前缀），`#` 行视为注释；`rm` 保留注释行与自动文件头。
4. `rm` 只接受 ID，`/rule rm 某词` 会被当作无效 ID 拒绝；`/rule rm <ID1> <ID2>` 一次删多条。
5. `guardedTools` 默认四项，不含 `run_code`。
6. `cleanupSessionFiles` 默认关。
7. `maxChars` 3000、`totalMaxChars` 6000。
8. 全局层位于 `$DSH_HOME/rulebook`，对所有 profile 可见（`rulebookDir` 可改指 `$DSH_PROFILE_DIR/rulebook` 变成 profile 私有）。

---

## 13. 首版实现审计后的修订

首版在真实宿主里跑通后做了一轮实现审计，改了四处。

### 13.1 `rm` 从「序号 / 片段」改为按 ID

原设计允许序号与文本片段两种删除。实现里出现了两个问题：

- **层名错配。** `listLayers` 给三层的标签是「全局规则 / 工作区规则 / 本会话规则」，而 `rm` 的层过滤拿「本会话层」去比，字符串不相等，`rm -s` 恒返回「未找到」。`add` 的回执用的是「本会话层」，所以写得到、删不掉。
- **片段语义本身不合适。** 一个片段可能命中多条，删完只回一句「已删除 N 条」，说不清删了哪些；想精确删一条反而要先构造一个只命中它的片段。

改法：每条规则一个内容派生 ID，形如 `g:3f2a1c`（层字母 + `sha256(层 + 归一化文本)` 前 6 位）。`rm` 只收 ID，可一次多个。ID 不落盘，文件保持纯文本。按层名过滤那段代码随 id 自带层字母一并删除，13.1 的第一个问题自然消失。

代价：ID 随文本变化，手工改过的规则要重新取 ID；同一条文本同时存在于两层时是两个独立 ID。

### 13.2 预算保底方向修正

`allocate` 原先把保底写在取小值之后：`Math.max(MIN_LAYER_CHARS, Math.min(cfg.maxChars, ...))`。配置写小于 200 时，保底反过来顶破上限——`maxChars: 100` 实测注入 184 字符，`totalMaxChars: 300` 实测三层合计 882 字符。

改法：保底先被 `cfg.maxChars` 与「总预算均分」两次夹住，收缩循环以夹过的 floor 为下限。实测现在 `maxChars: 100` 注入 100 字符，`totalMaxChars: 300` 三层各 100、合计 300。

### 13.3 关闭注入的层拒绝写入

原实现里 `includeWorkspaceRules: false` 时 `add -w` 仍返回「已写入」，文件确实写了，但注入与 `list` 都不显示这一层。用户以为记下了，模型永远看不到。

改法：`scopeOf` 检查开关，拒绝并说明原因与替代做法。沉默失败比报错更难排查，宁可报错。

### 13.4 层名常量统一

原先「本会话层」与「本会话规则」两套写法散在 add 回执、rm 过滤、list 标题三处，正是 13.1 那个 bug 的成因。改为 `LAYER_LETTER` / `LAYER_TITLE` / `LAYER_LABEL` 三个常量，各处引用同一份。

### 13.5 测试补齐

冒烟测试原 29 项，`rm` 只测了缺省层，`-w` 与 `-s` 一次没测，所以 13.1 的 bug 没被抓住。现扩到 52 项，新增：三层各自的 ID 删除、一次删多条、非 ID 输入被拒、重复删同一 ID、注释保留、预算小于保底的两组回归、关闭层拒绝写入。

---

## 14. 写入前用 AI 整理规则

### 14.1 需求

用户不希望原话被逐字记录，而希望 AI 结合当前对话理解意图后补充必要的语境、理顺措辞，但只是「稍微长一点」，不能把一句话扩写成段落。

### 14.2 门控不变

AI 只在用户敲 `/rule add` 之后运行，角色是「整理者」而非决策者：

- 触发权仍完全在用户手里，模型没有任何写入接口（见第 6 节）；
- 写入内容由 AI 整理，但整理失败一律拒绝写入，绝不退回未经整理的原文；
- 整理后的文本在回执里显示，用户可当场发现理解偏差。

### 14.3 复用当前对话前缀（KV 命中）

整理请求不另起一份精简上下文，而是 fork 当前对话：

1. `session.deriveMessages()` 拿到完整历史消息，原样作为 `messages` 前缀（含开头的 system 文本）；
2. 末尾追加一条整理指令的 user 消息，内含用户原话；
3. `provider` / `model` / `reasoningEffort` 取 `session.requestHeader().config`，与原对话一致；
4. 不传 `tools`（只整理，不调工具），也不设 `maxTokens`：用模型默认输出预算。

system、历史消息、模型都和当前对话一致，只有末尾多一条，因此前面的 KV cache 前缀全部命中。

> `maxTokens` 早期设为 256，在高推理模型上会被 reasoning 全部吃掉、正文为空，已移除。`reasoningEffort` 沿用当前会话的取值，不硬编码——各模型的档位名不统一（DeepSeek 是 `low: low`，GLM 与 pi-ai 路由是 `low: light`）。

### 14.4 失败语义

模型服务缺席、鉴权失败、限流、超时、结果为空、结果过长（> 200 字符）、结果不是单行——任一情况都拒绝写入并报错。宁可这次不记，也不写一条未经整理或质量可疑的规则。

### 14.5 测试

新增 5 项 AI 整理断言：整理后文本落盘、请求 provider/model 沿用当前会话、消息前缀等于原对话 + 整理指令、末条含原话、请求无 tools 字段；以及模型失败拒绝写入、空结果拒绝写入。冒烟测试现 57 项。

### 14.6 命令不阻塞：整理改走后台任务

#### 问题

斜杠命令在宿主侧是短事务。`CommandService.execute` 先写 `command/run`，`await` handler 后才写 `command/done`：

```js
const output = command.definition.handler(invocation)
result = normalizeResult(parsed.name, await withAbort(Promise.resolve(output), signal))
return settle(result)   // 这里才写 command/done
```

第 14 版把整段模型 stream 放在 handler 里 `await`，命令迟迟不结算，composer 处于「命令执行中」状态，输入框被锁。这与请求快慢无关：任何耗时都会锁住输入，长会话（system 文本几十万字符）会被放大成几十秒。

#### 改法

handler 立即返回，整理与写入交给后台任务：

1. `ctx.jobs.start({ kind: 'rule-rewrite', label, owner, run })` 注册任务，`owner` 是当前会话 id；
2. `run(job)` 必须**同步**返回 `{ cancel, done }`（`JobSpec` 契约），因此任务体 `runAdd` 是异步的，`run` 只挂 `.then` 不 `await`；
3. `cancel` 只置一个布尔位，`rewriteRule` 每个 chunk 检查一次；
4. `done` 永不 reject，失败也 resolve 成 `{ status: 'failed', detail }`；
5. 结果用 `agent.followup(...)` 以一条 `[rule] …` 的 user 消息送回会话——`followup` 走 `next-turn` 并唤醒驱动，繁忙时排到下一步、空闲时开新一轮。`followup` 抛错时降级到 `inject`（`next-step`，不唤醒），再不行只记日志。

断言依据：

| 事实 | 来源 |
|---|---|
| handler 被 `await` 后才结算 | `CommandService.execute` 源码 |
| `kind` 接受任意非空字符串 | `pty-send`、`workflow` 两处现存用法 |
| 任务自带完成通知 | `dsh-tool-jobs` 对任意 kind 的归属任务结算都投递 notice |
| `followup` = `send(msg, 'next-turn', true)` | `Agent.send` 实现 |
| `ctx.agents.get(id)` 可取回 agent | bash、ptc 等工具的后台分支 |

#### 退化路径

`jobs` 或 `agents` 服务缺席（headless、精简组合），或配置 `backgroundRewrite: false` 时，`/rule add` 回到第 14 版的同步路径 `addRuleSync`。功能不丢，只是命令结算前输入框会被锁。

两者共用 `writeAddResult`，回执文案只有一处。