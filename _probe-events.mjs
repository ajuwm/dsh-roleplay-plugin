import { readFileSync } from 'fs'
import zlib from 'node:zlib'

const f = process.argv[2]
const raw = zlib.zstdDecompressSync(readFileSync(f)).toString('utf8')
const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log('事件总数:', events.length)

const types = {}
for (const e of events) types[e.type || '?'] = (types[e.type || '?'] || 0) + 1
console.log('事件类型分布:', JSON.stringify(types, null, 0))

// 复用引擎的提取逻辑(同 chat-core)
function extractText(ev) {
  const raw = ev && ev.data ? ev.data : null
  if (!raw) return null
  const m = raw.message && typeof raw.message === 'object' ? raw.message : (raw.content ? raw : null)
  if (!m) return null
  const blocks = Array.isArray(m.content) ? m.content : []
  const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  if (!text) return null
  const id = m.id || raw.id || null
  const src = m.source || raw.source || null
  const plugin = !!((id && typeof id === 'string' && id.startsWith('rp-')) || (src && (src.kind === 'plugin' || src.kind === 'contextual')))
  return { text, id, plugin }
}
function extractMessage(ev) {
  if (!ev || typeof ev.type !== 'string') return null
  if (ev.type === 'user/message') { const x = extractText(ev); return x ? { role: 'user', ...x } : null }
  if (ev.type === 'assistant/message') { const x = extractText(ev); return x ? { role: 'assistant', ...x } : null }
  return null
}

let extracted = 0
const byRole = {}
console.log('\n--- 消息类事件逐个分析 ---')
for (const e of events) {
  const isMsgLike = /message/.test(String(e.type || ''))
  const m = extractMessage(e)
  if (m) { extracted++; byRole[m.role] = (byRole[m.role] || 0) + 1 }
  if (isMsgLike) {
    const hasText = m ? 'YES' : 'no '
    const dataKeys = e.data ? Object.keys(e.data).join(',') : '(no data)'
    const contentInfo = (() => {
      const d = e.data || {}
      const mm = d.message || d
      if (Array.isArray(mm.content)) return mm.content.map((b) => b && b.type).join('+')
      return '(no content array)'
    })()
    const idInfo = (e.data && ((e.data.message && e.data.message.id) || e.data.id)) || '-'
    console.log(`  seq=${String(e.seq).padStart(3)} ${String(e.type).padEnd(20)} extracted=${hasText} content=[${contentInfo}] id=${idInfo} dataKeys=${dataKeys}`)
  }
}
console.log('\n提取结果:', JSON.stringify(byRole), '共', extracted, '条')
const nonMsgWithText = events.filter((e) => !/message/.test(String(e.type || '')) && extractText(e))
console.log('非 message 类型但含文本的事件:', nonMsgWithText.length, nonMsgWithText.slice(0, 3).map((e) => e.type))
