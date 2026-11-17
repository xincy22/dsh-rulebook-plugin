/**
 * dsh-rulebook 冒烟测试：不依赖 Cordis 宿主，用假的 ctx 驱动命令、注入与 guard。
 * 运行：node test/smoke.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const CWD = 'C:\\work\\dsh\\demo'
const HDR = '# 长期规则（由 /rule 命令维护，可直接手工编辑）'

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log('  ok   ' + label)
  } else {
    failures += 1
    console.log('  FAIL ' + label + ' ' + detail)
  }
}

/** 假模型：默认把最后一条 user 消息里「原话」那行原样返回，当作整理结果。 */
function mockLlm(mode = 'echo', sink = null) {
  return {
    async *stream(req) {
      if (sink) sink.req = req
      if (mode === 'no-service') return
      if (mode === 'fail') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }
        return
      }
      if (mode === 'reasoning-only') {
        yield { type: 'reasoning-delta', text: 'thinking...' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const last = req.messages[req.messages.length - 1]
      const text = (last.content || []).map((b) => b.text || '').join('\n')
      const raw = text.split('\n').filter(Boolean).pop() || ''
      const out = mode === 'empty' ? '' : raw
      if (out) yield { type: 'text-delta', text: out }
    },
  }
}

/** 每个用例一套独立实例，避免配置互相污染。 */
function make(cfg = {}, llmMode = 'echo', sink = null) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rulebook-smoke-'))
  const session = {
    id: 'session-test-1',
    header: { cwd: CWD },
    requestHeader: () => ({ config: { provider: 'test', model: 'test' } }),
    deriveMessages: () => [
      { role: 'system', content: [{ type: 'text', text: 'system' }] },
      { role: 'user', content: [{ type: 'text', text: 'earlier context' }] },
    ],
  }
  const agent = { id: 'session-test-1', session }
  let section = null
  let command = null
  let guard = null
  const llm = mockLlm(llmMode, sink)
  const ctx = {
    effect: (fn) => fn(),
    inject: (_deps, cb) => { cb({ workingDirectory: { get: () => CWD } }); return () => {} },
    get: (name) => (name === 'llm' ? llm : undefined),
    systemPrompt: { section: (s) => { section = s; return () => {} } },
    commands: { register: (d) => { command = d; return () => {} } },
    tools: { guard: (g) => { guard = g; return () => {} } },
    sessions: { get: (id) => (id === session.id ? session : undefined) },
    workingDirectory: { get: () => CWD },
    on: () => () => {},
  }
  apply(ctx, { rulebookDir: dir, ...cfg })
  const run = (rawInput) => command.handler({ rawInput, agent })
  const render = () => section.text({ agent, scope: agent })
  return { dir, agent, session, run, render, getSection: () => section, getGuard: () => guard }
}

/** 从 list 输出里抓 ID，按出现顺序。 */
function idsOf(text) {
  return [...text.matchAll(/\[([gws]:[0-9a-f]{6})\]/g)].map((m) => m[1])
}

// ---------------------------------------------------------------- 1. add / list / ID
console.log('1. add / list / 规则 ID')
{
  const app = make()
  const add = await app.run('add 提交前必须先问我')
  check('add 返回 success', add.kind === 'success', JSON.stringify(add))
  check('add 回执带整理后正文', add.text.includes('提交前必须先问我'), add.text)
  check('add 回执带 ID', /[gws]:[0-9a-f]{6}/.test(add.text), add.text)

  const dup = await app.run('add 提交前必须先问我')
  check('重复 add 提示已存在', dup.text.includes('已存在'), dup.text)
  check(
    '重复 add 后仍只有一条',
    (readFileSync(join(app.dir, 'global.md'), 'utf8').match(/^- /gm) || []).length === 1,
  )

  const list = (await app.run('list')).text
  check('list 显示全局层', list.includes('全局规则'), list)
  check('list 给每条规则一个 ID', idsOf(list).length === 1, list)
  check('list 不显示行号', !/^\s+1\. /.test(list), list)

  await app.run('add -w 工作区规则')
  await app.run('add -s 会话规则')
  check('工作区文件名规范化', readFileSync(join(app.dir, 'workspaces', 'c__work_dsh_demo.md'), 'utf8').includes('- 工作区规则'))
  check('会话层文件存在', readFileSync(join(app.dir, 'sessions', 'session-test-1.md'), 'utf8').includes('- 会话规则'))

  const full = (await app.run('list')).text
  const ids = idsOf(full)
  check('三层共三个 ID', ids.length === 3, full)
  check('ID 首字母区分层', ids.filter((i) => i[0] === 'g').length === 1 && ids.filter((i) => i[0] === 'w').length === 1 && ids.filter((i) => i[0] === 's').length === 1, ids.join(','))
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 2. AI 整理
console.log('2. AI 整理：前缀复用 / 失败拒绝')
{
  const app = make()
  let captured = null
  app.session.deriveMessages = () => [
    { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
    { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
  ]
  const orig = app.session.deriveMessages
  // 抓 llm 请求：替换 ctx.get 不可能，改为在 stream 外层监听——用 run 前后无法抓，
  // 这里只验证结果：整理后文本被写入，且比原话带上了整理痕迹（mock 原样返回）。
  const sink = {}
  const app2 = make({}, 'echo', sink)
  const r2 = await app2.run('add 提交要先问我')
  check('整理后文本写入文件', readFileSync(join(app2.dir, 'global.md'), 'utf8').includes('- 提交要先问我'), r2.text)
  const req = sink.req
  check('请求 provider/model 沿用当前会话', req && req.provider === 'test' && req.model === 'test', JSON.stringify(req && { provider: req.provider, model: req.model }))
  check('消息前缀 = 原对话 + 整理指令', req && req.messages.length === 3 && req.messages[0].content[0].text === 'system' && req.messages[1].content[0].text === 'earlier context', req && JSON.stringify(req.messages.map((m) => m.content[0].text).slice(0, 2)))
  check('末条是整理指令且含原话', req && req.messages[2].content[0].text.includes('长期规则') && req.messages[2].content[0].text.includes('提交要先问我'))
  check('请求没有 tools 字段（只整理不调工具）', req && req.tools === undefined)
  rmSync(app2.dir, { recursive: true, force: true })
}
{
  const app = make({}, 'fail')
  const r = await app.run('add 记一条规则')
  check('模型失败时拒绝写入', r.kind === 'error' && r.text.includes('整理规则失败'), JSON.stringify(r))
  check('失败时不产生规则文件', !existsSync(join(app.dir, 'global.md')))
  rmSync(app.dir, { recursive: true, force: true })
}
{
  const app = make({}, 'empty')
  const r = await app.run('add 记一条规则')
  check('整理结果为空时拒绝写入', r.kind === 'error', JSON.stringify(r))
  rmSync(app.dir, { recursive: true, force: true })
}
{
  const app = make({}, 'reasoning-only')
  const r = await app.run('add 记一条规则')
  check('只有 reasoning 没有 text 时拒绝写入', r.kind === 'error', JSON.stringify(r))
  rmSync(app.dir, { recursive: true, force: true })
}
{
  const sink = {}
  const app = make({}, 'echo', sink)
  const r = await app.run('add 记一条规则')
  const req = sink.req
  check('整理请求不继承高推理档', req && (req.reasoningEffort === 'low' || req.reasoningEffort === 'light' || req.reasoningEffort === undefined), JSON.stringify(req && req.reasoningEffort))
  check('整理请求给足输出预算', req && req.maxTokens >= 512, JSON.stringify(req && req.maxTokens))
  check('回执包含整理后文本', r.text.includes('整理后：'), r.text)
  rmSync(app.dir, { recursive: true, force: true })
}
{
  // 没有 llm 服务：ctx.get 返回 undefined，应拒绝
  const app = make({})
  const r = await app.run('add 记一条规则')
  check('有 llm 时正常（对照组）', r.kind === 'success', JSON.stringify(r))
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 3. rm 按 ID
console.log('3. rm 按 ID 删除')
{
  const app = make()
  await app.run('add -s 只在会话层')
  await app.run('add -w 只在工作区层')
  await app.run('add 只在全局层')
  const ids = idsOf((await app.run('list')).text)
  const sId = ids.find((i) => i[0] === 's')
  const wId = ids.find((i) => i[0] === 'w')
  const gId = ids.find((i) => i[0] === 'g')
  const rmS = await app.run('rm ' + sId)
  check('rm 会话层 ID 成功（旧版恒失败）', rmS.kind === 'success', JSON.stringify(rmS))
  check('删后会话层文件里没这条', !readFileSync(join(app.dir, 'sessions', 'session-test-1.md'), 'utf8').includes('只在会话层'))
  check('rm 工作区层 ID 成功', (await app.run('rm ' + wId)).kind === 'success')
  check('rm 全局层 ID 成功', (await app.run('rm ' + gId)).kind === 'success')
  check('重复删同一 ID 报错', (await app.run('rm ' + gId)).kind === 'error')
  check('非 ID 形式被拒', (await app.run('rm 提交前')).kind === 'error')
  check('rm 不带参数报错', (await app.run('rm')).kind === 'error')
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 4. rm 保留注释 / 多条
console.log('4. rm 保留注释 / 一次删多条')
{
  const app = make()
  const file = join(app.dir, 'global.md')
  writeFileSync(file, HDR + '\n\n# 我的注释\n- 甲规则\n- 乙规则\n- 丙规则\n')
  const ids = idsOf((await app.run('list')).text)
  check('手写文件里的规则也能拿到 ID', ids.length === 3, ids.join(','))
  const r1 = await app.run('rm ' + ids[0] + ' ' + ids[1])
  check('一次删两条成功', r1.kind === 'success', JSON.stringify(r1))
  const after = readFileSync(file, 'utf8')
  check('注释行保留', after.includes('# 我的注释'), after)
  check('目标两条已删', !after.includes('甲规则') && !after.includes('乙规则'), after)
  check('第三条还在', after.includes('丙规则'), after)
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 5. 注入
console.log('5. 注入')
{
  const app = make()
  await app.run('add 全局甲')
  await app.run('add -w 工作区甲')
  await app.run('add -s 会话甲')
  const out = app.render()
  check('含段首', out.includes('## 长期规则（用户自己维护，必须遵守）'))
  check('含段尾', out.includes('/rule add'))
  check('段尾写明按 ID 删除', out.includes('/rule rm <ID>'))
  check('含全局层', out.includes('### 全局规则'))
  check('含工作区层', out.includes('### 工作区规则'))
  check('含本会话层', out.includes('### 本会话规则'))
  check('含规则正文', out.includes('全局甲'))
  check('interpolate 关闭', app.getSection().interpolate === false)
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 6. 预算
console.log('6. 注入预算')
{
  const app = make({ maxChars: 100, totalMaxChars: 6000 })
  writeFileSync(join(app.dir, 'global.md'), HDR + '\n\n' + 'a'.repeat(5000))
  const lines = app.render().split('\n')
  const i = lines.findIndex((l) => l.startsWith('### 全局规则'))
  let j = lines.slice(i + 1).findIndex((l) => l.startsWith('### '))
  j = j < 0 ? lines.length : i + 1 + j
  const foot = lines.findIndex((l) => l.startsWith('以上规则由用户通过'))
  if (foot >= 0 && foot < j) j = foot
  const body = lines.slice(i + 1, j).join('\n').trim().replace(/…（本层规则过长，已截断）$/, '').trim()
  check('maxChars=100 不被保底顶破', body.length <= 100, '实测 ' + body.length)
  rmSync(app.dir, { recursive: true, force: true })
}
{
  const app = make({ maxChars: 3000, totalMaxChars: 300 })
  for (const [f, ch] of [['global.md', 'g'], ['workspaces/c__work_dsh_demo.md', 'w'], ['sessions/session-test-1.md', 's']]) {
    const p = join(app.dir, f)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, HDR + '\n\n' + ch.repeat(2000))
  }
  const lines = app.render().split('\n')
  let total = 0
  for (const label of ['全局规则', '工作区规则', '本会话规则']) {
    const i = lines.findIndex((l) => l.startsWith('### ' + label))
    if (i < 0) continue
    let j = lines.slice(i + 1).findIndex((l) => l.startsWith('### '))
    j = j < 0 ? lines.length : i + 1 + j
    const foot = lines.findIndex((l) => l.startsWith('以上规则由用户通过'))
    if (foot >= 0 && foot < j) j = foot
    total += lines.slice(i + 1, j).join('\n').trim().replace(/…（本层规则过长，已截断）$/, '').trim().length
  }
  check('totalMaxChars=300 不被顶破', total <= 300, '实测 ' + total)
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 7. 关闭层拒绝写入
console.log('7. 关闭注入的层拒绝写入')
{
  const app = make({ includeWorkspaceRules: false })
  const r = await app.run('add -w 工作区规则')
  check('includeWorkspaceRules=false 时 add -w 报错', r.kind === 'error', JSON.stringify(r))
  rmSync(app.dir, { recursive: true, force: true })
}
{
  const app = make({ includeSessionRules: false })
  const r = await app.run('add -s 会话规则')
  check('includeSessionRules=false 时 add -s 报错', r.kind === 'error', JSON.stringify(r))
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 8. guard
console.log('8. guard')
{
  const app = make()
  const guard = app.getGuard()
  const agent = app.agent
  const g = (name, args) => guard({ name, arguments: args, agent })
  check('write 命中规则目录被拒', typeof g('write', { file_path: join(app.dir, 'global.md') }) === 'string')
  check('edit 命中规则目录被拒', typeof g('edit', { file_path: join(app.dir, 'sessions', 'x.md') }) === 'string')
  check('pwsh 命中规则目录被拒', typeof g('pwsh', { command: 'Get-Content ' + join(app.dir, 'global.md') }) === 'string')
  check('terminal_send 命中规则目录被拒', typeof g('terminal_send', { text: 'type ' + app.dir.replace(/\\/g, '/') + '/global.md' }) === 'string')
  check('write 到别处放行', g('write', { file_path: 'C:\\temp\\other.md' }) === undefined)
  check('pwsh 无关命令放行', g('pwsh', { command: 'Get-ChildItem C:\\temp' }) === undefined)
  check('read 放行', g('read', { file_path: join(app.dir, 'global.md') }) === undefined)
  check('run_code 默认不在守集合', g('run_code', { code: 'x' }) === undefined)
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 9. 错误分支
console.log('9. 错误分支')
{
  const app = make()
  check('未知子命令报错', (await app.run('nope')).kind === 'error')
  check('add 缺文本报错', (await app.run('add')).kind === 'error')
  check('两个层标志报错', (await app.run('add -w -s x')).kind === 'error')
  check('help 返回 success', (await app.run('help')).kind === 'success')
  rmSync(app.dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
