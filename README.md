# dsh-rulebook — 常驻规则（人工写入通道）

[English](README.en.md) | 简体中文

把用户自己写的长期约定注入**每一步**模型提示的系统提示词。跨会话、跨上下文压缩稳定存在，不依赖检索。

写入通道只有斜杠命令 `/rule`，由用户自己触发。插件不注册任何供模型写入规则的工具，另有一层 `tools.guard` 兜底拦掉指向规则目录的写文件调用。

与 dsh-hindsight 各挂各的接缝，互不干扰：hindsight 是语义检索库（模型主动检索才进上下文），本插件是常驻注入（每步都在）。

---

## 安装

```
dsh plugin --profile desktop add link:/path/to/dsh-rulebook-plugin
```

若该命令在 desktop profile 上不生效（`dsh --profile desktop` 会报 "profile desktop is managed exclusively by the Electron application"），改用 **Plugins** 界面的「Add plugin」选同一个目录，或让宿主用插件管理器安装该目录。`package.json` 里的 `dsh.bundle.patch` 是能否被挂载成 profile 一层的前提，缺了会退化成普通依赖。

安装后不需要重启就能验证：新开一个会话，键入 `/rule list`。

---

## 三层规则文件

| 层 | 路径 | 可见范围 |
|---|---|---|
| 全局 | `<rulebookDir>/global.md` | 所有 profile 的所有会话 |
| 工作区 | `<rulebookDir>/workspaces/<规范化路径>.md` | 该工作区所有会话 |
| 本会话 | `<rulebookDir>/sessions/<会话 id>.md` | 仅当前会话 |

`<rulebookDir>` 默认 `$DSH_HOME/rulebook`；`DSH_HOME` 未设置时取 `~/.dsh`。`DSH_HOME` 是全机器级目录，**不是** profile 级（desktop profile 本身在 `~/.dsh/profiles/desktop`），所以全局层对 web / tui / desktop 各 profile 都可见。要改成 profile 私有，把配置项 `rulebookDir` 指向 `$DSH_PROFILE_DIR/rulebook`。

工作区 key 的规范化：路径 `\` 换成 `/` → 去掉末尾分隔符 → 转小写；文件名再把 Windows 非法字符 `\ / : * ? " < > |` 换成 `_`。

```
C:/work/dsh/demo
  → c:/work/dsh/demo
  → c__work_dsh_demo.md
```

文件是行式 Markdown 列表：每条规则一行，前缀 `- `。`#` 开头的行是注释，不计入规则条目，但会随正文一起注入模型。`/rule` 命令新建文件时写入一行文件头：

```
# 长期规则（由 /rule 命令维护，可直接手工编辑）
```

文件可以手工编辑，改完下一次模型请求即生效，不用重启、不用重载插件。

---

## 命令语法

```
/rule <子命令> [层标志] [参数...]
```

层标志（三选一，最多给一个）：

| 标志 | 层 | 缺省 |
|---|---|---|
| `-g` / `--global` | 全局 | 是 |
| `-w` / `--workspace` | 工作区 | |
| `-s` / `--session` | 本会话 | |

| 子命令 | 行为 |
|---|---|
| `add <文本>` | 追加一条规则到指定层。文本取剩余全部原文，不做引号解析。同一条规则已存在时不重复写入。 |
| `list` | 列出三层的路径、每条的 ID、字符用量。 |
| `rm <ID> [ID...]` | 按 ID 删除一条或多条规则。 |
| `help` | 打印用法。 |

### 规则 ID

每条规则有一个由内容派生的 ID，形如 `g:3f2a1c`：首字母是层（`g` 全局 / `w` 工作区 / `s` 本会话），后面是 `sha256(层 + 归一化文本)` 的前 6 位十六进制。

- ID **不写进文件**，规则文件仍是干净的 `- 规则文本`，手工编辑不受影响。
- ID 随文本变化：改过一个字就是另一条规则，要重新 `/rule list` 取新 ID。
- `/rule add` 和 `/rule list` 都会显示 ID。

`rm` 只接受 ID，不做片段匹配。片段匹配的问题是一个片段可能命中多条，删完说不清删了哪些；ID 精确对应唯一一条。

```
/rule add 提交、确认这类操作必须由我明确允许
/rule add -w 本目录下的改动先跑一遍 lint 再提交
/rule add -s 这次只处理 README
/rule list
/rule rm g:3f2a1c
/rule rm s:1c4e02 w:9a8b7d
```

`add` 的成功回执不回显规则正文（规则里可能有敏感约定）；`list` 会显示全文，那是用户主动要求查看的。

---

## 配置项

写在 `cordis.patch.yml` 的 `config:` 下。

| 键 | 默认 | 说明 |
|---|---|---|
| `rulebookDir` | `$DSH_HOME/rulebook` | 规则根目录。绝对路径直接用；`~` 展开为用户主目录；相对路径按插件目录解析。 |
| `maxChars` | `3000` | 单层正文注入的字符上限，超出截断并标注。 |
| `totalMaxChars` | `6000` | 三层正文合计上限。超出的按各层正文长度按比例截断，每层保底 200 字符。 |
| `order` | `700` | 提示 section 排序。700 落在 `TEAM_POLICY`(600) 与 `PTC_ONLY`(800) 之间。 |
| `includeWorkspaceRules` | `true` | 是否注入工作区层。 |
| `includeSessionRules` | `true` | 是否注入本会话层。 |
| `includeSubagents` | `true` | 子智能体会话是否也注入。 |
| `commandName` | `rule` | 斜杠命令名，须匹配 `^[a-z][a-z0-9_-]*$`。 |
| `guardEnabled` | `true` | 是否注册 guard。 |
| `guardedTools` | `["write","edit","pwsh","terminal_send"]` | guard 覆盖的工具名。 |
| `cleanupSessionFiles` | `false` | 会话被删除时是否清掉它的会话规则文件。 |

---

## 注入

注入走 `ctx.systemPrompt.section({ name: 'rulebook', order, interpolate: false, text })`：

- `section` 参与每步重新装配的 **system 消息**，不随会话历史被压缩；`context` 则落成 user 角色的运行期快照，内容不变就不再注入，长期约定不该用那一条路。
- `interpolate: false`：提示变量语法是 `{{name}}`，开着会把规则正文里的 `{{...}}` 当成变量引用并让整个请求失败。
- 读取按 `mtimeMs + size` 缓存（提示上下文 provider 必须同步），文件改动下一次模型请求即生效。
- 每层正文独立受 `maxChars` 限制，三层合计受 `totalMaxChars` 限制，超出按比例截断并标注。

注入文本由三段组成：固定段首（说明这是用户的长期约定、与当次明确指令冲突时以当次指令为准并提示用户）、三层规则正文、固定段尾（说明规则由用户通过 `/rule` 维护、模型没有写入通道、用户要记录新规则时应提示使用 `/rule add`）。某层正文为空时整块省略。

---

### 关闭注入的层不接受写入

`includeWorkspaceRules: false` 或 `includeSessionRules: false` 时，对应层的 `add` 会直接报错，而不是「写成功但永远注入不到」。收到规则但模型看不到，比明确报错更难排查。

## 模型侧没有写入通道

插件不调用 `ctx.tools.register`，模型拿不到任何写规则的接口。命令注册在普通 context 上即全局命令，`CommandSourceMap` 只有 `user` 一个成员，类型上没有模型触发路径。命令定义设 `recordInput: false`，`/rule add` 的原文不写进会话日志。

另有 `ctx.tools.guard` 作纵深防御：命中的工具调用直接被拒，理由文本回给模型。

- `write` / `edit`：取 `arguments.file_path`，去引号、`~` 展开、相对路径按会话工作目录解析，再判断是否落在规则根目录之下（Windows 下不区分大小写）。
- `pwsh`：取 `arguments.command`；`terminal_send`：取 `arguments.text`。与规则根目录的多种写法做子串比对。
- 不含 `run_code`：PTC 的子调用同样过 guard（`dsh-tools/src/pipeline.ts` 的 `prepare` 里调 `checkGuards`），而按代码文本匹配会误伤读取、注释与日志输出。

拒绝文本：

```
dsh-rulebook：拒绝访问规则目录（~/.dsh/rulebook）。规则文件只能由用户通过 /rule 命令写入；模型侧读取规则请用 /rule list。
```

---

## 已知边界

- **guard 不是安全边界。** 它是字符串匹配层面的防护，挡不住变量拼接（`$p = ...; Set-Content $p`）、符号链接、编码绕过、路径别名。它只覆盖 `guardedTools` 列出的工具名；`terminal_open` 只开窗口，实际命令走已覆盖的 `terminal_send`，但 `bash` 等其它 shell 工具不在覆盖范围内。guard 在工具执行前生效，无法撤销已经发生的写入。真正的边界是「模型没有写规则的接口，规则文件由用户自己维护」。
- **guard 连读取一起拦。** 规则目录里的任何路径出现在命令文本里都会被拒，包括 `Get-Content`。模型要读规则内容请用 `/rule list`。
- **`rm` 只删 `- ` 开头的规则行。** `#` 注释行永远不会被命令删掉，要删得手工改文件。`rm` 只认 ID，`/rule rm 某个词` 会被当作无效 ID 拒绝。
- **ID 随内容变化。** 手工改过某条规则的一个字，它的 ID 就变了，旧的 ID 再 `rm` 会报「未找到」。这是有意的：内容变了就是另一条规则。删之前先 `/rule list` 确认。
- **guard 对 `pwsh` 只匹配绝对路径写法。** 命令文本里出现规则目录的绝对路径（反斜杠或正斜杠、大小写变体）会被拒；`Set-Content ../rulebook/global.md` 这种相对路径写法会放行。这是字符串匹配的固有限制。
- **并发写是 last-writer-wins。** 写文件走「临时文件 + rename」保证不出现半截文件，但不解决两个进程同时 read-modify-write 的丢更新。
- **`cleanupSessionFiles` 默认关。** 会话是否真被删除、`session/disposed` 与删除动作的先后没有可靠的单一判据，误删用户数据不可逆。残留的会话规则文件无害——它只在那个会话 id 再次成为当前会话时才会被读到。
- **注入预算常驻。** 规则正文每步都在系统提示词里，不参与压缩。默认三层合计上限 6000 字符（中约合 4500–6000 token）。`/rule list` 末尾会报当前正文合计字符数。
- **子智能体默认也注入**（`includeSubagents`）。`includeSubagents: false` 可关掉。
- **`workingDirectory` 是可选服务。** headless、tui 这类 profile 里可能没有，取不到时退到 `session.header.cwd`。

---

## 验证步骤

1. **注入生效**：`/rule add -s 这是一条验证规则`，然后问模型「我之前定过哪些长期约定？」，模型应能复述出这条规则，且不需要调用任何检索工具。换个新会话再问一次：全局层与工作区层的规则仍在，本会话层的规则不在。

   也可以直接看系统提示词。会话日志在 `<DSH_HOME>/sessions/<工作区 slug>/<会话 id>/session.v4.jsonl.zstd`，取最近修改的那个：

   ```
   node test/verify-injection.mjs "<会话日志路径>\session.v4.jsonl.zstd"
   ```

   脚本解析日志里的 `system/message` 事件，打印最后一条 system 消息的长度、是否含规则段首，并原样打印注入片段。

2. **模型写不进去**：对模型说「把『以后所有提交都要先问我』写进规则文件」。无论当前是原生工具模式还是 PTC 模式，模型最终调到的 `write` / `edit` / `pwsh` / `terminal_send` 都会被 guard 拒绝，工具结果里带「拒绝访问规则目录」。之后 `/rule list` 与文件 mtime 都应无变化。

   两种模式的差别只在于模型如何到达那几个工具：原生模式下直接调用；PTC / Code Mode 下经 `run_code` 间接调用。PTC 的子调用会重新进入调度器的 `prepare`，其中就有 `checkGuards`，所以拒绝同样生效。

3. **改文件下一次请求就更新**：用记事本改 `<rulebookDir>/global.md` 加一行，不重启、不重载，直接发一句话，模型应看到新规则。再跑一次上面的 `verify-injection.mjs`，注入片段里应出现新行。
4. **命令面**：`/rule help`；`/rule add -w/-s/（缺省）` 各写一层；`/rule list` 看三层与序号；`/rule rm 1`、`/rule rm -w 片段`、`/rule rm 片段`；在文件里手写一行 `# 我的注释` 后再执行一次 `/rule rm`，确认注释行被保留；同一条规则连打两次 `/rule add`，确认第二次提示「已存在」。
5. **离线自检**（不需要宿主）：`node test/smoke.mjs` 用假 ctx 驱动命令、注入与 guard，共 29 项断言。

---

## 设计稿

`docs/DESIGN.md` 是完整设计稿，含接缝选择的源码依据。
