// 历史原文检索 —— 「每轮正文完整保存,需要时回查原文」。
//
// 为什么要有它(对照 dsh-tavern 的设计):
//   压缩只保主线线索,一定会丢细节;丢掉的细节必须能查回来,压缩才敢做。
//   我们原来的 roleplay_recall 搜的是 mem-*.json 里**模型自己写的记忆条目** —— 摘要的摘要,
//   而且用 includes() 精确子串匹配,错一个字就查不到。
//   这里存的是**逐轮原文**,按轮次索引,可按关键词找、也可按轮次读附近。
//
// 纯函数:输入是消息数组/文件文本,输出是文本;没有 IO、没有时钟,便于单测。

export const HISTORY_MAX_HITS = 6
export const FULL_RECALL_COOLDOWN_TURNS = 10
export const EXCERPT_CHARS = 320
export const TOTAL_CHARS = 2400

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

// 取消息正文。DSH 各版本的形状不完全一样 —— 这里把见过的都认了:
//   · content 是块数组 [{type:'text',text}]  ← 主流
//   · content 是纯字符串                      ← 有的路由会这么给
//   · 只有 message.text                       ← 老形状
// 认窄了会**静默丢消息**(实测:assistant 的回复一条都没进去),所以宁可宽一点。
function textOf(m) {
  const c = m && m.content
  if (typeof c === 'string') return squash(c)
  if (Array.isArray(c)) {
    const parts = []
    for (const b of c) {
      if (!b) continue
      if (typeof b === 'string') { parts.push(b); continue }
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    return squash(parts.join('\n'))
  }
  return squash(m && typeof m.text === 'string' ? m.text : '')
}

// 不算剧情消息的:插件注入 / 隐藏 / DSH 自己塞的上下文包裹。
// 实测漏网过的:<system-reminder>(技能目录)被当成玩家发言记了进去。
const NOISE = /^(<system-reminder>|Current runtime context|This snapshot supersedes|<skill|技能目录)/
const OK_ROLES = new Set(['user', 'assistant', 'model'])

// 一条 DSH 消息 → 一条历史记录(不可记录的返回 null)
export function entryOf(m, turn) {
  if (!m || typeof m !== 'object') return null
  if (!OK_ROLES.has(m.role)) return null
  if (m.hidden) return null
  const src = m.source || {}
  if (src.kind === 'plugin' || String(src.kind || '').indexOf('plugin:') === 0) return null   // 插件注入的心跳/格式提醒不算剧情
  const id = String(m.id || '')
  if (id.startsWith('rp-') || id.startsWith('pet-')) return null
  const text = textOf(m)
  if (!text) return null
  if (NOISE.test(text)) return null
  return { t: Number(turn) || 0, role: m.role === 'model' ? 'assistant' : m.role, text, id: id || (m.role + ':' + text.slice(0, 32)) }
}

// 诊断用:一条消息的形状摘要。留档时发现「看到的形状变了」就打一行日志,
// 免得形状不匹配时**静默丢消息**(assistant 全丢那次就是这么发生的)。
export function describeMessage(m) {
  if (!m || typeof m !== 'object') return 'notobj'
  const c = m.content
  const shape = typeof c === 'string' ? 'str' : Array.isArray(c) ? 'arr[' + c.map((b) => (b && b.type) || typeof b).join('+') + ']' : String(typeof c)
  return [m.role || '?', shape, m.hidden ? 'hidden' : '', (m.source && m.source.kind) || 'nosrc'].filter(Boolean).join('|')
}

// 把新消息追加到已有的 JSONL 文本后面(按 id 去重,顺序保持)
export function appendEntries(existingText, entries) {
  const seen = new Set()
  const lines = String(existingText || '').split('\n').filter(Boolean)
  for (const l of lines) { try { const o = JSON.parse(l); if (o && o.id) seen.add(o.id) } catch (e) { /* 坏行忽略 */ } }
  const add = []
  for (const e of entries) {
    if (!e || seen.has(e.id)) continue
    seen.add(e.id)
    add.push(JSON.stringify(e))
  }
  if (!add.length) return { text: lines.join('\n') + (lines.length ? '\n' : ''), added: 0 }
  return { text: lines.concat(add).join('\n') + '\n', added: add.length }
}

export function parseHistory(text) {
  const out = []
  for (const l of String(text || '').split('\n')) {
    if (!l.trim()) continue
    try { const o = JSON.parse(l); if (o && o.text) out.push(o) } catch (e) { /* 坏行忽略 */ }
  }
  return out
}

// 关键词打分:命中词数 + 出现次数,越长越具体的关键词权重越高
function scoreOf(entry, terms) {
  let s = 0
  for (const t of terms) {
    if (!t) continue
    let n = 0, i = -1
    while ((i = entry.text.indexOf(t, i + 1)) !== -1) n++
    if (n > 0) s += n * Math.min(4, t.length)
  }
  return s
}

// 检索。mode='turn' 时读指定轮次附近;否则按关键词找。
export function searchEntries(entries, opts) {
  const o = opts || {}
  const limit = Math.min(Math.max(Number(o.limit) || 4, 1), HISTORY_MAX_HITS)
  const list = Array.isArray(entries) ? entries : []
  if (o.aroundTurn) {
    const t = Number(o.aroundTurn)
    const span = 2
    return list.filter((e) => Math.abs(e.t - t) <= span)
      .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))
      .slice(0, limit)
  }
  const q = squash(o.query)
  if (!q) return []
  const terms = q.split(/[\s,，、]+/).filter(Boolean)
  const scored = list.map((e) => ({ e, s: scoreOf(e, terms) })).filter((x) => x.s > 0)
  scored.sort((a, b) => b.s - a.s || b.e.t - a.e.t)
  return scored.slice(0, limit).map((x) => x.e)
}

// 渲染成工具返回值。务必带轮次标记 + 明确「这是过去的事」。
export function formatHits(hits, opts) {
  const o = opts || {}
  const list = Array.isArray(hits) ? hits : []
  if (!list.length) return { text: '（没有找到相关的历史原文。可以换个更具体的说法再查一次，比如人名、地点或当时说过的话。）', count: 0 }
  const head = '以下是**过去已经发生过的剧情原文**，用于回忆细节：'
  const tail = '（这些是历史，不是新剧情：不要当成刚发生的事重演；引用时以「之前」「上次」这类口气带出即可。）'
  const out = [head]
  let used = head.length + tail.length
  let shown = 0
  for (const h of list) {
    const body = h.text.length > EXCERPT_CHARS ? h.text.slice(0, EXCERPT_CHARS) + '…' : h.text
    const line = '· 第 ' + h.t + ' 轮 [' + (h.role === 'user' ? '他' : '我') + ']：' + body
    if (used + line.length > TOTAL_CHARS && shown > 0) break
    out.push(line)
    used += line.length
    shown++
  }
  out.push(tail)
  return { text: out.join('\n'), count: shown }
}
