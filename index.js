/**
 * dsh-rulebook — 常驻规则（人工写入通道）
 *
 * 三层规则文件，每一步模型提示重新注入一次：
 *   1. 全局：<rulebookDir>/global.md —— 所有会话都看得到；
 *   2. 工作区：<rulebookDir>/workspaces/<工作区路径 key>.md —— 该工作区的会话看得到；
 *   3. 本会话：<rulebookDir>/sessions/<sessionId>.md —— 只在当前会话注入。
 *
 * 写入通道只有斜杠命令 `/rule`，由用户自己触发。插件不注册任何供模型写入规则的
 * 工具；另有一层 tools.guard 兜底，拦掉指向规则目录的写文件调用。
 *
 * 注入走 systemPrompt.section：section 参与每步重新装配的 system 消息，
 * 不随会话历史被压缩；context 则落成 user 角色的运行期快照，内容不变就不再注入。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as pathResolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-rulebook'

export const inject = ['commands', 'sessions', 'systemPrompt', 'tools']
// llm 不列入 inject：用 ctx.get('llm') 可选读取，服务缺席时按「调用失败」拒绝写入，
// 不让缺少模型服务的 profile 在加载阶段就失败。

const HERE = dirname(fileURLToPath(import.meta.url))

/** 自动文件头：新建规则文件时写入第一行，注入时不算正文。 */
const AUTO_HEADER = '# 长期规则（由 /rule 命令维护，可直接手工编辑）'
/** 段首：说明这些是用户的长期约定，以及与当次指令冲突时的处理。 */
const HEADER = [
  '## 长期规则（用户自己维护，必须遵守）',
  '',
  '以下内容是用户写下的长期约定，每一步模型提示都会重新出现一次。与当前任务是否相关都要遵守：动手前先对照一遍，发现冲突先停下来处理。与用户当次的明确指令冲突时，以当次指令为准，并提示用户这条长期约定与当次指令不一致、是否要更新规则。',
].join('\n')
/** 段尾：说明规则由用户通过 /rule 维护，模型没有写入通道。 */
const FOOTER = [
  '以上规则由用户通过 `/rule` 命令维护：全局层用 `/rule add <文本>`（等价于 `/rule add -g <文本>`），工作区层用 `/rule add -w <文本>`，本会话层用 `/rule add -s <文本>`，删除用 `/rule rm <ID>`（ID 从 `/rule list` 取，形如 `g:3f2a1c`）。你没有写入规则的通道，也不能直接改写这些文件。用户提出新的长期约定时，不要只口头答应：请提示用户用 `/rule add` 把规则写下来。',
].join('\n')
/** 规则正文被截断时追加的标注。 */
const TRUNCATED_NOTE = '…（本层规则过长，已截断）'
/** 分配总预算时每层的保底字符数。 */
const MIN_LAYER_CHARS = 200

/** AI 整理指令：作为新的一轮 user 消息追加到当前对话末尾。 */
const REWRITE_INSTRUCTION = [
  '现在请把用户刚才说的这句话整理成一条「长期规则」。',
  '',
  '要求：',
  '1. 结合上面的对话理解这句话指的是什么，补上必要的限定或语境，让脱离对话的人也能看懂；',
  '2. 理顺措辞，改成一条清晰、可执行的陈述；',
  '3. 不要扩写：只允许比原话稍长一点，一句话能说清就不要写多句，绝不写成段落；',
  '4. 只输出整理后的那一条规则本身，不要解释、不要引号、不要前后缀、不要列表符号；',
  '5. 用和原话相同的语言。',
  '',
  '用户刚才说的原话：',
].join('\n')

/** 整理结果的上限：过长视为模型没听懂，按失败处理。 */
const REWRITE_MAX_CHARS = 200

const DEFAULTS = {
  rulebookDir: '',
  maxChars: 3000,
  totalMaxChars: 6000,
  order: 700,
  includeWorkspaceRules: true,
  includeSessionRules: true,
  includeSubagents: true,
  commandName: 'rule',
  guardEnabled: true,
  guardedTools: ['write', 'edit', 'pwsh', 'terminal_send'],
  cleanupSessionFiles: false,
}

function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() ? env.trim() : join(homedir(), '.dsh')
}

/** 配置里的路径：绝对路径直接用，~ 展开，相对路径按插件目录解析。 */
function expandPath(input, baseDir) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  if (isAbsolute(raw)) return raw
  return pathResolve(baseDir, raw)
}

function readConfig(config, baseDir) {
  const c = config && typeof config === 'object' ? config : {}
  const num = (value, fallback, min) =>
    Number.isFinite(value) && value >= min ? Math.floor(value) : fallback
  const rulebookDir =
    typeof c.rulebookDir === 'string' && c.rulebookDir.trim()
      ? expandPath(c.rulebookDir.trim(), baseDir)
      : join(dshHome(), 'rulebook')
  const guardedTools = Array.isArray(c.guardedTools)
    ? c.guardedTools
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
    : DEFAULTS.guardedTools
  return {
    rulebookDir,
    maxChars: num(c.maxChars, DEFAULTS.maxChars, 1),
    totalMaxChars: num(c.totalMaxChars, DEFAULTS.totalMaxChars, 1),
    order: Number.isFinite(c.order) ? c.order : DEFAULTS.order,
    includeWorkspaceRules: c.includeWorkspaceRules !== false,
    includeSessionRules: c.includeSessionRules !== false,
    includeSubagents: c.includeSubagents !== false,
    commandName:
      typeof c.commandName === 'string' && /^[a-z][a-z0-9_-]*$/.test(c.commandName.trim())
        ? c.commandName.trim()
        : DEFAULTS.commandName,
    guardEnabled: c.guardEnabled !== false,
    guardedTools,
    cleanupSessionFiles: c.cleanupSessionFiles === true,
  }
}

/** 工作区 key：路径 \ 换成 /，去掉末尾分隔符，转小写。 */
function workspaceKeyOf(cwd) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  return raw ? raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : ''
}

/** 工作区 key → 文件名：Windows 非法文件名字符换成 _。 */
function workspaceFileName(key) {
  return `${key.replace(/[\\/:*?"<>|]/g, '_')}.md`
}

/** 会话 id → 文件名：只保留安全字符，超长截断。 */
function sessionFileName(id) {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (!raw) return ''
  const safe = /^[A-Za-z0-9_.:-]{1,160}$/.test(raw)
    ? raw
    : raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160)
  return `${safe}.md`
}

/** 去掉自动文件头后的正文。 */
function bodyOf(raw) {
  const lines = String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length && lines[0].trim() === AUTO_HEADER) lines.shift()
  return lines.join('\n').trim()
}

/** 规则行：`- ` 开头的行。注释行（#）不计入。 */
function ruleLinesOf(body) {
  return String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
}

/** 归一化后比较两条规则是否相同。 */
function normalizeRule(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 层字母：ID 的第一段，用来把请求路由到对应文件。 */
const LAYER_LETTER = { global: 'g', workspace: 'w', session: 's' }
/** 层名：命令回执用「层」，list 用「规则」。同一套常量，避免两处写法对不上。 */
const LAYER_TITLE = { global: '全局层', workspace: '工作区层', session: '本会话层' }
const LAYER_LABEL = { global: '全局规则', workspace: '工作区规则', session: '本会话规则' }

/**
 * 规则 ID：层字母 + sha256(层 + 归一化文本) 的前 6 位十六进制。
 * ID 由内容派生、不落盘，规则文件仍是纯文本；文本改了 ID 就变，
 * 这在语义上是对的——内容变了就是另一条规则。
 */
function ruleIdOf(layer, text) {
  const letter = LAYER_LETTER[layer] || 'x'
  const digest = createHash('sha256').update(`${layer}\u0000${normalizeRule(text)}`).digest('hex')
  return `${letter}:${digest.slice(0, 6)}`
}

export function apply(ctx, config) {
  const cfg = readConfig(config, HERE)

  /** workingDirectory 是可选服务：headless / tui 这类 profile 里可能没有。 */
  let workingDirectoryService = null
  try {
    ctx.inject(['workingDirectory'], (child) => {
      workingDirectoryService = child.workingDirectory
    })
  } catch {
    // 服务缺席时退到 session.header.cwd
  }

  /** mtime + size 缓存；提示上下文 provider 必须是同步的。 */
  const cache = new Map()
  function readCached(file) {
    if (!file) return ''
    try {
      const st = statSync(file)
      const hit = cache.get(file)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text })
      return text
    } catch {
      cache.delete(file)
      return ''
    }
  }

  function readFileText(file) {
    try {
      return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    } catch {
      return ''
    }
  }

  /**
   * 原子写：写临时文件再 rename。同目录 rename 在本地文件系统上是原子的，
   * 避免读到半截文件。它不解决两个进程同时 read-modify-write 的丢更新，
   * 那是 last-writer-wins，写在已知边界里。
   */
  function writeAtomic(file, content) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, content, 'utf8')
    try {
      renameSync(tmp, file)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw error
    }
    cache.delete(file)
  }

  function agentOf(context) {
    if (!context || typeof context !== 'object') return undefined
    for (const candidate of [context.agent, context.scope]) {
      if (candidate && typeof candidate === 'object' && typeof candidate.id === 'string') return candidate
    }
    return undefined
  }

  /** 会话对象：agent.session 优先，退到 sessions 存储查询。 */
  function sessionOf(agent) {
    if (!agent) return undefined
    try {
      if (agent.session) return agent.session
    } catch {
      // 落到 sessions 查询
    }
    try {
      if (ctx.sessions && typeof ctx.sessions.get === 'function') return ctx.sessions.get(agent.id)
    } catch {
      // 取不到就跳过依赖会话的层
    }
    return undefined
  }

  function workingDirectoryOf() {
    try {
      const svc = ctx.workingDirectory
      if (svc && typeof svc.get === 'function') return svc
    } catch {
      // 落到可选注入的实例
    }
    return workingDirectoryService
  }

  function cwdOf(session) {
    if (!session) return ''
    try {
      const svc = workingDirectoryOf()
      if (svc && typeof svc.get === 'function') {
        const dir = svc.get(session)
        if (typeof dir === 'string' && dir) return dir
      }
    } catch {
      // 落到会话头
    }
    try {
      const cwd = session.header && session.header.cwd
      return typeof cwd === 'string' ? cwd : ''
    } catch {
      return ''
    }
  }

  function isSubagent(session) {
    try {
      return Boolean(session && session.header && session.header.origin === 'subagent')
    } catch {
      return false
    }
  }

  function layerFiles(session, cwd) {
    const workspace = cwd
      ? join(cfg.rulebookDir, 'workspaces', workspaceFileName(workspaceKeyOf(cwd)))
      : ''
    const sessionFile =
      session && session.id ? join(cfg.rulebookDir, 'sessions', sessionFileName(session.id)) : ''
    return {
      global: join(cfg.rulebookDir, 'global.md'),
      workspace,
      session: sessionFile,
    }
  }

  /** 三层正文（已去掉自动文件头），空层不参与。 */
  function layerBodies(session, cwd) {
    const files = layerFiles(session, cwd)
    const out = []
    const push = (key, label, path, enabled) => {
      if (!enabled || !path) return
      const body = bodyOf(readCached(path))
      if (!body) return
      out.push({ key, label, path, body })
    }
    push('global', '全局规则', files.global, true)
    push('workspace', '工作区规则', files.workspace, cfg.includeWorkspaceRules)
    push('session', '本会话规则', files.session, cfg.includeSessionRules)
    return { files, bodies: out }
  }

  /**
   * 总预算分配：按各层正文长度按比例切，总量不超过 totalMaxChars，
   * 每层再受 maxChars 约束，每层保底 MIN_LAYER_CHARS。
   */
  function allocate(entries) {
    const count = entries.length
    if (count === 0) return []
    // 每层保底不能超过单层上限，也不能让三层保底之和超过总预算——
    // 否则配置写小了会被保底反过来顶破（曾经 maxChars:100 实际注入 184）。
    const totalCap = Math.floor(cfg.totalMaxChars / count)
    const floor = Math.max(0, Math.min(MIN_LAYER_CHARS, cfg.maxChars, totalCap))
    const total = entries.reduce((sum, entry) => sum + entry.body.length, 0)
    if (total === 0) return entries.map((entry) => ({ ...entry, limit: 0, truncated: false }))
    if (total <= cfg.totalMaxChars) {
      return entries.map((entry) => ({
        ...entry,
        limit: Math.min(entry.body.length, cfg.maxChars),
        truncated: entry.body.length > cfg.maxChars,
      }))
    }
    const limits = entries.map((entry) =>
      Math.min(
        cfg.maxChars,
        Math.max(floor, Math.floor((cfg.totalMaxChars * entry.body.length) / total)),
      ),
    )
    let sum = limits.reduce((a, b) => a + b, 0)
    while (sum > cfg.totalMaxChars) {
      let idx = 0
      for (let i = 1; i < limits.length; i += 1) if (limits[i] > limits[idx]) idx = i
      if (limits[idx] <= floor) break
      const cut = Math.min(limits[idx] - floor, sum - cfg.totalMaxChars)
      limits[idx] -= cut
      sum -= cut
    }
    return entries.map((entry, i) => ({
      ...entry,
      limit: limits[i],
      truncated: entry.body.length > limits[i],
    }))
  }

  function renderLayers(entries) {
    const parts = []
    for (const entry of entries) {
      const body = entry.truncated
        ? `${entry.body.slice(0, entry.limit).trimEnd()}\n${TRUNCATED_NOTE}`
        : entry.body
      parts.push(`### ${entry.label}（${entry.path}）\n\n${body}`)
    }
    return parts.join('\n\n')
  }

  /** 注入正文。外层兜底：渲染失败不能让整次请求失败。 */
  function renderRules(context) {
    try {
      const agent = agentOf(context)
      const session = sessionOf(agent)
      if (session && isSubagent(session) && !cfg.includeSubagents) return ''
      const cwd = cwdOf(session)
      const { bodies } = layerBodies(session, cwd)
      const allocated = allocate(bodies)
      return [HEADER, renderLayers(allocated), FOOTER].join('\n\n')
    } catch (error) {
      const reason = error && error.message ? error.message : String(error)
      return [HEADER, `（长期规则本次未能载入：${reason}）`, FOOTER].join('\n\n')
    }
  }

  // 每一步模型调用前重新注入（不随会话历史被压缩）。
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'rulebook',
      order: cfg.order,
      interpolate: false,
      text: renderRules,
    }),
  )

  // ---------- 命令通道 ----------

  const HELP = [
    '/rule — 维护长期规则',
    '',
    '用法：',
    '  /rule add [-g|-w|-s] <文本>   追加一条规则到指定层（缺省全局层）',
    '  /rule list                    列出三层规则、各条 ID、文件路径与字符用量',
    '  /rule rm <ID> [ID...]         按 ID 删除一条或多条规则',
    '  /rule help                    本帮助',
    '',
    '层标志：-g/--global 全局、-w/--workspace 工作区、-s/--session 本会话。',
    '每条规则的 ID 由内容派生，形如 g:3f2a1c（首字母是层：g 全局 / w 工作区 / s 本会话），',
    '跑 /rule list 或 /rule add 后都能看到。ID 随文本变化，改过内容的规则要重新取 ID。',
    'ID 精确对应唯一一条规则，不做片段匹配，也不会一次删到别的东西。',
    '只删除 "- " 开头的规则行，"#" 注释行不会被删（要删得手工改文件）。',
  ].join('\n')

  /** 从参数开头剥离层标志，剩下的原文保持不变（供 add 使用）。 */
  function extractScope(arg) {
    let rest = String(arg ?? '')
    let scope = null
    const re = /^\s*(-g|--global|-w|--workspace|-s|--session)(?=\s|$)\s*/
    for (;;) {
      const m = re.exec(rest)
      if (m === null) break
      const flag = m[1]
      const next =
        flag === '-g' || flag === '--global'
          ? 'global'
          : flag === '-w' || flag === '--workspace'
            ? 'workspace'
            : 'session'
      if (scope !== null && scope !== next) return { error: '层标志只能给一个（-g / -w / -s）' }
      scope = next
      rest = rest.slice(m[0].length)
    }
    return { scope, rest }
  }

  function scopeOf(session, cwd, scope) {
    const files = layerFiles(session, cwd)
    if (scope === 'workspace') {
      if (!files.workspace) return { error: '当前会话没有可用的工作区，-w 不可用' }
      if (!cfg.includeWorkspaceRules) {
        return {
          error:
            '工作区层的注入已关闭（includeWorkspaceRules: false），写进去模型也看不到。' +
            '先把它改回 true，或改用 -g / -s。',
        }
      }
      return { file: files.workspace, label: LAYER_TITLE.workspace }
    }
    if (scope === 'session') {
      if (!files.session) return { error: '当前会话不可用，-s 不可用' }
      if (!cfg.includeSessionRules) {
        return {
          error:
            '本会话层的注入已关闭（includeSessionRules: false），写进去模型也看不到。' +
            '先把它改回 true，或改用 -g / -w。',
        }
      }
      return { file: files.session, label: LAYER_TITLE.session }
    }
    return { file: files.global, label: LAYER_TITLE.global }
  }

  function listLayers(session, cwd) {
    const files = layerFiles(session, cwd)
    const specs = [
      { layer: 'global', label: LAYER_LABEL.global, path: files.global, enabled: true },
      { layer: 'workspace', label: LAYER_LABEL.workspace, path: files.workspace, enabled: cfg.includeWorkspaceRules },
      { layer: 'session', label: LAYER_LABEL.session, path: files.session, enabled: cfg.includeSessionRules },
    ]
    const out = []
    for (const spec of specs) {
      if (!spec.path) continue
      const body = bodyOf(readCached(spec.path))
      const rules = ruleLinesOf(body)
      out.push({
        ...spec,
        body,
        rules,
        entries: rules.map((text) => ({ id: ruleIdOf(spec.layer, text), text })),
      })
    }
    return out
  }

  /**
   * 用当前会话模型把用户原话整理成一条规则。
   * 复用当前对话做前缀：messages = session.deriveMessages() + 一条整理指令，
   * header.config（provider/model）原样沿用，system 与历史消息不变，最大化 KV 命中。
   * 失败一律抛出，由调用方拒绝写入。
   * @returns {Promise<string>} 整理后的单行规则
   */
  async function rewriteRule(text, agent, signal) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('模型服务不可用，无法整理规则')
    }
    const session = sessionOf(agent)
    if (!session || typeof session.deriveMessages !== 'function') {
      throw new Error('当前会话不可读，无法整理规则')
    }
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    const config = header && header.config
    if (!config || !config.provider || !config.model) {
      throw new Error('无法确定当前会话的模型，无法整理规则')
    }
    // deriveMessages 返回完整对话（首条通常带 system 文本），作为前缀原样复用。
    const history = Array.isArray(session.deriveMessages()) ? session.deriveMessages() : []
    const instruction = { role: 'user', content: [{ type: 'text', text: REWRITE_INSTRUCTION + '\n' + text }] }
    const messages = [...history, instruction]
    let out = ''
    for await (const chunk of llm.stream({
      provider: config.provider,
      model: config.model,
      messages,
      ...config.reasoningEffort === void 0 ? {} : { reasoningEffort: config.reasoningEffort },
      maxTokens: 256,
      ...signal === void 0 ? {} : { signal },
    })) {
      if (signal && signal.aborted) throw new Error('整理被取消')
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        out += chunk.text
        continue
      }
      if (chunk && chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
        out += chunk.block.text
        continue
      }
      if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        const failure = chunk.reason.failure || {}
        throw new Error('整理失败：' + (failure.message || failure.code || '模型错误'))
      }
    }
    const cleaned = out
      .replace(/^\s*[\-\*]\s+/, '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) throw new Error('整理结果为空')
    if (cleaned.length > REWRITE_MAX_CHARS) throw new Error('整理结果过长，已拒绝写入')
    if (/\n/.test(out.trim())) throw new Error('整理结果不是一条规则，已拒绝写入')
    return cleaned
  }

  function addRule(file, text) {
    const rule = text.trim().replace(/^[-*]\s+/, '')
    if (!rule) return { error: '规则文本不能为空' }
    const existing = readFileText(file)
    const duplicate = ruleLinesOf(bodyOf(existing)).some(
      (line) => normalizeRule(line) === normalizeRule(rule),
    )
    if (duplicate) return { duplicate: true }
    const content =
      existing.trim() === ''
        ? `${AUTO_HEADER}\n\n- ${rule}\n`
        : `${existing.replace(/\s+$/, '')}\n- ${rule}\n`
    writeAtomic(file, content)
    return { added: true, rule }
  }

  /** 只删 `- ` 开头的规则行；文件头与注释行原样保留。 */
  function removeRules(file, predicate) {
    const existing = readFileText(file)
    if (!existing) return { removed: 0, missing: true }
    const lines = existing.split(/\r?\n/)
    let removed = 0
    const kept = lines.filter((line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('- ')) return true
      if (predicate(trimmed.slice(2).trim())) {
        removed += 1
        return false
      }
      return true
    })
    if (removed > 0) writeAtomic(file, `${kept.join('\n').replace(/\s+$/, '')}\n`)
    return { removed }
  }

  ctx.effect(() =>
    ctx.commands.register({
      name: cfg.commandName,
      description: '维护长期规则：全局 / 工作区 / 本会话三层，规则每步注入模型提示。',
      input: { hint: 'add [-g|-w|-s] <文本> | list | rm <ID> [ID...] | help' },
      recordInput: false,
      handler: async (invocation) => {
        const raw = String(invocation && invocation.rawInput ? invocation.rawInput : '').trim()
        if (!raw) return { kind: 'error', text: HELP }
        const m = /^(\S+)\s*([\s\S]*)$/.exec(raw)
        const sub = (m ? m[1] : raw).toLowerCase()
        const arg = m ? m[2] : ''

        if (sub === 'help' || sub === 'h' || sub === '?') return { kind: 'success', text: HELP }

        const parsed = extractScope(arg)
        if (parsed.error) return { kind: 'error', text: parsed.error }
        const scopeGiven = parsed.scope !== null
        const scope = parsed.scope || 'global'
        const rest = parsed.rest.trim()

        const agent = invocation && invocation.agent
        const session = sessionOf(agent)
        const cwd = cwdOf(session)

        if (sub === 'list' || sub === 'ls') {
          const layers = listLayers(session, cwd)
          const lines = []
          let totalChars = 0
          for (const layer of layers) {
            lines.push(`${layer.label}  ${layer.path}`)
            if (layer.entries.length === 0) {
              lines.push('  （无）')
            } else {
              layer.entries.forEach((entry) => lines.push(`  [${entry.id}] ${entry.text}`))
            }
            totalChars += layer.body.length
          }
          lines.push('')
          lines.push(`正文合计 ${totalChars} 字符（单层上限 ${cfg.maxChars}，三层合计上限 ${cfg.totalMaxChars}）`)
          return { kind: 'success', text: lines.join('\n') }
        }

        if (sub === 'add') {
          if (!rest) return { kind: 'error', text: `缺少规则文本。\n\n${HELP}` }
          const target = scopeOf(session, cwd, scope)
          if (target.error) return { kind: 'error', text: target.error }
          // 先用当前会话模型整理原话；失败一律拒绝写入（不写未经整理的原文）。
          let finalText
          try {
            finalText = await rewriteRule(rest, agent, invocation && invocation.signal)
          } catch (error) {
            return {
              kind: 'error',
              text: `整理规则失败，未写入：${error && error.message ? error.message : String(error)}`,
            }
          }
          try {
            const result = addRule(target.file, finalText)
            if (result.error) return { kind: 'error', text: result.error }
            if (result.duplicate) {
              return { kind: 'success', text: `已存在，未重复写入：${target.file}` }
            }
            const count = ruleLinesOf(bodyOf(readFileText(target.file))).length
            const layerName = scope === 'workspace' ? 'workspace' : scope === 'session' ? 'session' : 'global'
            const id = ruleIdOf(layerName, result.rule)
            return {
              kind: 'success',
              text: `已写入${target.label}：${target.file}\n  整理后：${result.rule}\n  ID ${id}（该层现有 ${count} 条规则）`,
            }
          } catch (error) {
            return {
              kind: 'error',
              text: `写入失败：${error && error.message ? error.message : String(error)}`,
            }
          }
        }

        if (sub === 'rm' || sub === 'remove' || sub === 'del') {
          if (!rest) {
            return {
              kind: 'error',
              text: `缺少规则 ID。先跑 /rule list 看每条的 ID，再 /rule rm <ID>。\n\n${HELP}`,
            }
          }
          // rm 只接受 ID，不做片段匹配：一个片段可能命中多条，删完说不清删了哪些。
          const tokens = rest.split(/\s+/).filter(Boolean)
          const invalid = tokens.filter((token) => !/^[gws]:[0-9a-f]{6}$/i.test(token))
          if (invalid.length > 0) {
            return {
              kind: 'error',
              text:
                `无效的规则 ID：${invalid.join('、')}。ID 形如 g:3f2a1c（g 全局 / w 工作区 / s 本会话），` +
                `跑 /rule list 可以看到全部 ID。\n\n${HELP}`,
            }
          }
          const layers = listLayers(session, cwd)
          const byLayer = new Map(layers.map((layer) => [layer.layer, layer]))
          const wanted = new Set(tokens.map((token) => token.toLowerCase()))
          const hits = []
          const missing = []
          for (const token of wanted) {
            const letter = token.slice(0, 1)
            const layerName = letter === 'g' ? 'global' : letter === 'w' ? 'workspace' : 'session'
            const layer = byLayer.get(layerName)
            if (!layer || !layer.path || !existsSync(layer.path)) {
              missing.push(token)
              continue
            }
            const entry = layer.entries.find((item) => item.id === token)
            if (!entry) {
              missing.push(token)
              continue
            }
            const result = removeRules(
              layer.path,
              (text) => normalizeRule(text) === normalizeRule(entry.text),
            )
            if (result.removed > 0) hits.push({ layer, id: token, removed: result.removed })
            else missing.push(token)
          }
          if (hits.length === 0) {
            return {
              kind: 'error',
              text: `未找到这些 ID 对应的规则：${missing.join('、')}。规则文件可能已被手工改过，ID 会随内容变化，重新跑 /rule list 取新 ID。`,
            }
          }
          const lines = hits.map((hit) => `已删除 [${hit.id}]（${hit.layer.label}）：${hit.layer.path}`)
          if (missing.length > 0) lines.push(`未找到：${missing.join('、')}`)
          return { kind: 'success', text: lines.join('\n') }
        }

        return { kind: 'error', text: `未知子命令「${sub}」。\n\n${HELP}` }
      },
    }),
  )

  // ---------- guard ----------

  /** 规则根目录的匹配变体：小写用于比对，display 是给用户看的原始写法。 */
  function pathVariants(dir) {
    const base = pathResolve(dir)
    const forward = base.replace(/\\/g, '/')
    const out = new Map()
    out.set(base.toLowerCase(), base)
    out.set(forward.toLowerCase(), forward)
    return [...out].map(([needle, display]) => ({ needle, display }))
  }

  function resolveUserPath(raw, cwd) {
    let value = raw.replace(/^["']|["']$/g, '').trim()
    if (!value) return ''
    if (value === '~') value = homedir()
    else if (value.startsWith('~/') || value.startsWith('~\\')) value = join(homedir(), value.slice(2))
    try {
      return isAbsolute(value) ? pathResolve(value) : pathResolve(cwd || process.cwd(), value)
    } catch {
      return ''
    }
  }

  function isInside(target, dir) {
    try {
      const t = pathResolve(target).toLowerCase()
      const d = pathResolve(dir).toLowerCase()
      return t === d || t.startsWith(d.endsWith(sep) ? d : d + sep)
    } catch {
      return false
    }
  }

  /** 从 shell 类工具的参数里取出命令文本。 */
  function shellTextOf(toolName, args) {
    if (!args || typeof args !== 'object') return ''
    if (toolName === 'pwsh') return typeof args.command === 'string' ? args.command : ''
    if (toolName === 'terminal_send') return typeof args.text === 'string' ? args.text : ''
    // run_code 默认不在守集合里：按代码文本匹配会误伤读取、注释与日志输出。
    if (toolName === 'run_code') return typeof args.code === 'string' ? args.code : ''
    return ''
  }

  function denial(hit) {
    return `dsh-rulebook：拒绝访问规则目录（${hit}）。规则文件只能由用户通过 /rule 命令写入；模型侧读取规则请用 /rule list。`
  }

  if (cfg.guardEnabled) {
    const variants = pathVariants(cfg.rulebookDir)
    ctx.effect(() =>
      ctx.tools.guard((execution) => {
        const toolName = execution && execution.name
        if (!toolName || !cfg.guardedTools.includes(toolName)) return undefined
        const args = execution.arguments
        if (toolName === 'write' || toolName === 'edit') {
          const raw = args && typeof args.file_path === 'string' ? args.file_path.trim() : ''
          if (!raw) return undefined
          const agent = execution.agent
          const session = agent ? sessionOf(agent) : undefined
          const cwd = cwdOf(session)
          const absolute = resolveUserPath(raw, cwd)
          if (!absolute) return undefined
          return isInside(absolute, cfg.rulebookDir) ? denial(absolute) : undefined
        }
        const text = shellTextOf(toolName, args)
        if (!text) return undefined
        const lower = text.toLowerCase()
        const hit = variants.find((variant) => lower.includes(variant.needle))
        return hit ? denial(hit.display) : undefined
      }),
    )
  }

  // ---------- 会话规则文件清理（默认关闭） ----------

  function sessionPersistedOnDisk(sid) {
    try {
      const root = join(dshHome(), 'sessions')
      const walk = (dir, depth) => {
        if (depth > 3) return false
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return false
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          if (entry.name === sid) return true
          if (walk(join(dir, entry.name), depth + 1)) return true
        }
        return false
      }
      return walk(root, 0)
    } catch {
      return true
    }
  }

  if (cfg.cleanupSessionFiles) {
    ctx.effect(() =>
      ctx.on('session/disposed', (session) => {
        try {
          const sid = session && session.id ? String(session.id) : ''
          if (!sid) return
          const file = join(cfg.rulebookDir, 'sessions', sessionFileName(sid))
          if (!existsSync(file)) return
          const timer = setTimeout(() => {
            try {
              if (sessionPersistedOnDisk(sid)) return
              if (existsSync(file)) unlinkSync(file)
            } catch {
              // 清理失败不影响会话删除
            }
          }, 300000)
          if (typeof timer.unref === 'function') timer.unref()
        } catch {
          // 清理失败不影响会话删除
        }
      }),
    )
  }
}
