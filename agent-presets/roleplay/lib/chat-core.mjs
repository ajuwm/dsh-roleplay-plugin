// roleplay 对话侧边栏核心(纯函数,无状态、无 ctx)——供 roleplay-host 调用,也供单测直接验证。
// 行为:从 session.events 里提取用户/助手文本消息(增量 or 历史),并标记插件注入消息。
// 事件形状(与 deskpet.checkPending 同口径):
//   user/message    → data.id(消息 id) / data.message.content[].text
//   assistant/message → data.message.content[].text / data.message.id / data.message.source

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
  const plugin = !!(
    (id && typeof id === 'string' && id.startsWith('rp-')) ||
    (src && (src.kind === 'plugin' || src.kind === 'contextual'))
  )
  return { text, id, plugin }
}

export function extractMessage(ev) {
  if (!ev || typeof ev.type !== 'string') return null
  if (ev.type === 'user/message') {
    const x = extractText(ev)
    return x ? { role: 'user', ...x } : null
  }
  if (ev.type === 'assistant/message') {
    const x = extractText(ev)
    return x ? { role: 'assistant', ...x } : null
  }
  return null
}

// 取 seq > sinceSeq 的消息(增量子集,尾部截断 limit 条);lastSeq = 所见最大 seq(含未提取文本的事件)。
export function pickMessages(events, sinceSeq = 0, limit = 200) {
  const out = []
  if (!Array.isArray(events)) return { messages: out, lastSeq: Number(sinceSeq) || 0 }
  let last = Number(sinceSeq) || 0
  for (const ev of events) {
    if (!ev || typeof ev.seq !== 'number') continue
    if (ev.seq > last) last = ev.seq
    if (ev.seq <= (Number(sinceSeq) || 0)) continue
    const m = extractMessage(ev)
    if (m) out.push({ seq: ev.seq, ...m })
  }
  if (out.length > limit) out.splice(0, out.length - limit)
  return { messages: out, lastSeq: last }
}

// 历史视图:从 0 开始取最近 limit 条(不论 seq 高低,保持原序尾部)。
export function historyMessages(events, limit = 60) {
  if (!Array.isArray(events)) return []
  const picked = []
  for (const ev of events) {
    const m = extractMessage(ev)
    if (m) picked.push({ seq: ev.seq, ...m })
  }
  const n = Math.max(1, Number(limit) || 60)
  return picked.length > n ? picked.slice(picked.length - n) : picked
}
