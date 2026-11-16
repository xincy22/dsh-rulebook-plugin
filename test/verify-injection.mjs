/**
 * 验证规则段是否真的进了系统提示词：读会话日志里的 system/message 事件。
 *
 * 用法：
 *   node test/verify-injection.mjs "<会话日志路径>\session.v4.jsonl.zstd"
 *
 * 会话日志路径在 <DSH_HOME>/sessions/<工作区 slug>/<会话 id>/ 下，
 * 取最近修改的那个即可。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const target = process.argv[2]
if (!target) {
  console.error('用法：node test/verify-injection.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}

const text = zstdDecompressSync(readFileSync(target)).toString('utf8')
const events = text
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const systemMessages = events.filter((event) => event.type === 'system/message')
console.log(`system/message 事件：${systemMessages.length} 条`)

const last = systemMessages[systemMessages.length - 1]
if (!last) {
  console.log('没有 system/message 事件，注入无从谈起。')
  process.exit(1)
}
const prompt = (last.data?.message?.content ?? []).map((block) => block.text || '').join('\n')
const marker = '## 长期规则（用户自己维护，必须遵守）'
const has = prompt.includes(marker)
console.log(`最后一条 system 消息：${prompt.length} 字符`)
console.log(`含规则段首：${has ? '是' : '否'}`)
if (has) {
  const i = prompt.indexOf(marker)
  console.log('--- 注入片段 ---')
  console.log(prompt.slice(i, i + 1500))
}
process.exit(has ? 0 : 1)
