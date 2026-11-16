/**
 * dsh-rulebook 冒烟测试：不依赖 Cordis 宿主，用假的 ctx 驱动命令、注入与 guard。
 * 运行：node test/smoke.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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

/** 每个用例一套独立实例，避免配置互相污染。 */
function make(cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rulebook-smoke-'))
  const session = { id: 'session-test-1', header: { cwd: CWD } }
  const agent = { id: 'session-test-1', session }
  let section = null
  let command = null
  let guard = null
  const ctx = {
    effect: (fn) => fn(),
    inject: (_deps, cb) => { cb({ workingDirectory: { get: () => CWD } }); return () => {} },
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
  return { dir, agent, run, render, getSection: () => section, getGuard: () => guard }
}

/** 从 list 输出里抓 ID，按出现顺序。 */
function idsOf(text) {
  return [...text.matchAll(/\[([gws]:[0-9a-f]{6})\]/g)].map((m) => m[1])
}

// ---------------------------------------------------------------- 1. add / list / ID
console.log('1. add / list / 规则 ID')
{
  const app = make()
  const add = app.run('add 提交前必须先问我')
  check('add 返回 success', add.kind === 'success', JSON.stringify(add))
  check('add 回执不带规则正文', !add.text.includes('提交前必须先问我'), add.text)
  check('add 回执带 ID', /[gws]:[0-9a-f]{6}/.test(add.text), add.text)

  const dup = app.run('add 提交前必须先问我')
  check('重复 add 提示已存在', dup.text.includes('已存在'), dup.text)
  check(
    '重复 add 后仍只有一条',
    (readFileSync(join(app.dir, 'global.md'), 'utf8').match(/^- /gm) || []).length === 1,
  )

  const list = app.run('list').text
  check('list 显示全局层', list.includes('全局规则'), list)
  check('list 给每条规则一个 ID', idsOf(list).length === 1, list)
  check('list 不显示行号', !/^\s+1\. /.test(list), list)

  app.run('add -w 工作区规则')
  app.run('add -s 会话规则')
  check('工作区文件名规范化', readFileSync(join(app.dir, 'workspaces', 'c__work_dsh_demo.md'), 'utf8').includes('- 工作区规则'))
  check('会话层文件存在', readFileSync(join(app.dir, 'sessions', 'session-test-1.md'), 'utf8').includes('- 会话规则'))

  const full = app.run('list').text
  const ids = idsOf(full)
  check('三层共三个 ID', ids.length === 3, full)
  check('ID 首字母区分层', ids.filter((i) => i[0] === 'g').length === 1 && ids.filter((i) => i[0] === 'w').length === 1 && ids.filter((i) => i[0] === 's').length === 1, ids.join(','))
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 2. rm 按 ID
console.log('2. rm 按 ID 删除')
{
  const app = make()
  app.run('add -s 只在会话层')
  app.run('add -w 只在工作区层')
  app.run('add 只在全局层')
  const ids = idsOf(app.run('list').text)
  const sId = ids.find((i) => i[0] === 's')
  const wId = ids.find((i) => i[0] === 'w')
  const gId = ids.find((i) => i[0] === 'g')

  const rmS = app.run('rm ' + sId)
  check('rm -s 的 ID 能删掉本会话层（旧版永远失败）', rmS.kind === 'success', JSON.stringify(rmS))
  check('删后会话层文件里没这条', !readFileSync(join(app.dir, 'sessions', 'session-test-1.md'), 'utf8').includes('只在会话层'))

  const rmW = app.run('rm ' + wId)
  check('rm 工作区层 ID 成功', rmW.kind === 'success', JSON.stringify(rmW))

  const rmG = app.run('rm ' + gId)
  check('rm 全局层 ID 成功', rmG.kind === 'success', JSON.stringify(rmG))

  const stale = app.run('rm ' + gId)
  check('重复删同一个 ID 报错', stale.kind === 'error', stale.text)

  const badId = app.run('rm 提交前')
  check('非 ID 形式被拒（不做片段匹配）', badId.kind === 'error' && badId.text.includes('无效的规则 ID'), badId.text)

  const noId = app.run('rm')
  check('rm 不带参数报错', noId.kind === 'error', noId.text)
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 3. rm 保留注释 + 一次多条
console.log('3. rm 保留注释行 / 一次删多条')
{
  const app = make()
  const file = join(app.dir, 'global.md')
  writeFileSync(file, HDR + '\n\n# 我的注释\n- 甲规则\n- 乙规则\n- 丙规则\n')
  const ids = idsOf(app.run('list').text)
  check('手写文件里的规则也能拿到 ID', ids.length === 3, ids.join(','))

  const r1 = app.run('rm ' + ids[0] + ' ' + ids[1])
  check('一次删两条成功', r1.kind === 'success', JSON.stringify(r1))
  const after = readFileSync(file, 'utf8')
  check('注释行保留', after.includes('# 我的注释'), after)
  check('目标两条已删', !after.includes('甲规则') && !after.includes('乙规则'), after)
  check('未命中的第三条还在', after.includes('丙规则'), after)
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 4. 注入
console.log('4. 注入')
{
  const app = make()
  app.run('add 全局甲')
  app.run('add -w 工作区甲')
  app.run('add -s 会话甲')
  const out = app.render()
  check('含段首', out.includes('## 长期规则（用户自己维护，必须遵守）'), out.slice(0, 80))
  check('含段尾', out.includes('/rule add'), out.slice(-200))
  check('段尾写明按 ID 删除', out.includes('/rule rm <ID>'), out.slice(-260))
  check('含全局层', out.includes('### 全局规则'), out)
  check('含工作区层', out.includes('### 工作区规则'), out)
  check('含本会话层', out.includes('### 本会话规则'), out)
  check('含规则正文', out.includes('全局甲'), out)
  check('interpolate 关闭', app.getSection().interpolate === false)
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 5. 预算（回归）
console.log('5. 注入预算')
{
  const app = make({ maxChars: 100, totalMaxChars: 6000 })
  writeFileSync(join(app.dir, 'global.md'), HDR + '\n\n' + 'a'.repeat(5000))
  const lines = app.render().split('\n')
  const i = lines.findIndex((l) => l.startsWith('### 全局规则'))
  let j = lines.slice(i + 1).findIndex((l) => l.startsWith('### '))
  j = j < 0 ? lines.length : i + 1 + j
  // 段尾是固定常量，不占预算，量正文时要切掉
  const foot = lines.findIndex((l) => l.startsWith('以上规则由用户通过'))
  if (foot >= 0 && foot < j) j = foot
  const body = lines.slice(i + 1, j).join('\n').trim().replace(/…（本层规则过长，已截断）$/, '').trim()
  check('maxChars=100 时单层不被保底顶破', body.length <= 100, '实测正文 ' + body.length)
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
  check('totalMaxChars=300 时三层合计不被顶破', total <= 300, '实测合计 ' + total)
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 6. 关闭的层拒绝写入（回归）
console.log('6. 关闭注入的层拒绝写入')
{
  const app = make({ includeWorkspaceRules: false })
  const r = app.run('add -w 工作区规则')
  check('includeWorkspaceRules=false 时 add -w 报错', r.kind === 'error', JSON.stringify(r))
  check('报错说明原因', r.text.includes('includeWorkspaceRules'), r.text)
  rmSync(app.dir, { recursive: true, force: true })
}
{
  const app = make({ includeSessionRules: false })
  const r = app.run('add -s 会话规则')
  check('includeSessionRules=false 时 add -s 报错', r.kind === 'error', JSON.stringify(r))
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 7. guard
console.log('7. guard')
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
  check('read 放行（读取另走 /rule list）', g('read', { file_path: join(app.dir, 'global.md') }) === undefined)
  check('run_code 默认不在守集合', g('run_code', { code: 'x' }) === undefined)
  rmSync(app.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 8. 错误分支
console.log('8. 错误分支')
{
  const app = make()
  check('未知子命令报错', app.run('nope').kind === 'error')
  check('add 缺文本报错', app.run('add').kind === 'error')
  check('两个层标志报错', app.run('add -w -s x').kind === 'error')
  check('help 返回 success', app.run('help').kind === 'success')
  rmSync(app.dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED')
process.exit(failures === 0 ? 0 : 1)
