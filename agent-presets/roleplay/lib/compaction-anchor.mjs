// 「压缩锚点」—— 官方把老历史折成摘要时,我们额外塞进去的那一段。
//
// 为什么需要它:官方 compaction 的摘要模板是工程向的(Primary Request / Files and Code /
// Errors and Fixes / Pending Jobs…),而且指令明确要求「concise English engineering prose」。
// 一个中文扮演会话被压完之后,她的过去就变成了一份英文工单。
//
// 我们的做法**不是**替换官方摘要(那是 1000 行不导出的后端逻辑,抄过来会随 DSH 升级漂移),
// 而是**在官方摘要前面补一段中文第一人称的「我记得的」**:
//   · 事实兜底仍由官方摘要提供(时间线、大事件都在)
//   · 语气/关系/未了结/承诺由我们这段提供
// 两段并存,谁都不丢。
//
// 纯函数:输入全是已经读好的数据,没有 IO、没有时钟,便于单测。

export const ANCHOR_MAX = 900

const cut = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n) }
const head = (s, n) => cut(String(s == null ? '' : s).split(/[。；;！!？?]/)[0], n)
// 去掉结尾残留的标点(拼进列表时统一用「；」分隔,否则会出现「；；」「，。」)
const stripTail = (s) => String(s == null ? '' : s).replace(/[，。；、,.;\s]+$/, '')
const uniq = (arr) => { const seen = new Set(); const out = []; for (const x of arr) { const k = stripTail(x); if (!k || seen.has(k)) continue; seen.add(k); out.push(k) } return out }
// 软截断:超长时回退到最近的断句处(避免出现「他笑我；」这种半句)
function cutSoft(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  const slice = t.slice(0, n)
  const at = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('，'), slice.lastIndexOf('；'), slice.lastIndexOf('、'))
  return at >= Math.floor(n * 0.5) ? slice.slice(0, at + 1) : slice
}

// 超预算时的降级顺序(从最不必要开始砍);标题行与「一直没说的」永不砍。
const DROP_ORDER = ['chapters', 'anniversary', 'goal', 'longTerm', 'recentActs', 'memories']

export function buildCompactionAnchor(input) {
  const it = input || {}
  const rows = {}

  // 关系现状(含「多久没来」——压缩后最容易丢的就是时间感)
  const rel = it.relation || {}
  const bits = []
  for (const k of ['favor', 'trust', 'heart']) {
    if (typeof rel[k] !== 'number') continue
    const lab = it.tierLabels && Array.isArray(it.tierLabels[k]) ? it.tierLabels[k][rel[k] <= 33 ? 0 : rel[k] <= 66 ? 1 : 2] : ''
    bits.push(({ favor: '好感', trust: '信任', heart: '心动' })[k] + ' ' + Math.round(rel[k]) + (lab ? '(' + lab + ')' : ''))
  }
  const when = typeof it.idleDays === 'number' && it.idleDays >= 1
    ? (it.idleDays >= 3 ? (it.idleLabel ? '他上次是 ' + it.idleLabel + '来的,已经 ' : '已经 ') + it.idleDays + ' 天没露面' : '他 ' + it.idleDays + ' 天前来过')
    : ''
  if (bits.length || when) rows.now = '- 我和他:' + bits.join('、') + (when ? ';' + when : '') + '。'

  // 关键记忆(索引式,不抄原文)
  const mem = uniq((it.memories || []).map((m) => cutSoft(m, 38))).slice(0, 3)
  if (mem.length) rows.memories = '- 我记得:' + mem.map((m, i) => '①②③'[i] + ' ' + m).join('；') + '。'

  // 未了结 / 没说出口的 —— 压缩里最贵的连续性资产,永不砍
  const uns = uniq((it.unspoken || []).map((u) => stripTail(cutSoft(u, 70)))).slice(-1)
  if (uns.length) rows.unspoken = '- 一直没说的:' + uns.join(' / ')

  // 长期锚点(次数最多 / 置顶的那几条)
  const lt = uniq((it.longTerm || []).map((m) => cutSoft(m, 40))).slice(0, 2)
  if (lt.length) rows.longTerm = '- 一直记着的:' + lt.join('；') + '。'

  // 他做过的事(最近 2 条)
  const acts = uniq((it.recentActs || []).map((a) => cut(a, 30))).slice(-2)
  if (acts.length) rows.recentActs = '- 最近他:' + acts.join('；') + '。'

  // 纪念日 / 攒钱目标
  if (it.anniversary) rows.anniversary = '- 还没到的日子:' + cut(it.anniversary, 60)
  if (it.goal) rows.goal = '- 心里的小目标:' + cut(it.goal, 60)

  // 更早的章节(有才写)
  if (it.chapter) rows.chapters = '- 更早以前:' + cut(it.chapter, 120)

  // 一条都没有 → 返回空串，调用方据此跳过（别塞一个只有标题的空壳进去）
  if (Object.keys(rows).length === 0) return ''
  const lineOf = (k) => rows[k] || ''
  let body = ['now', 'memories', 'unspoken', 'longTerm', 'recentActs', 'anniversary', 'goal', 'chapters'].map(lineOf).filter(Boolean)
  let text = header() + '\n' + body.join('\n')
  for (const key of DROP_ORDER) {
    if (text.length <= ANCHOR_MAX) break
    if (!rows[key]) continue
    delete rows[key]
    body = ['now', 'memories', 'unspoken', 'longTerm', 'recentActs', 'anniversary', 'goal', 'chapters'].map(lineOf).filter(Boolean)
    text = header() + '\n' + body.join('\n')
  }
  return text.length <= ANCHOR_MAX ? text : text.slice(0, ANCHOR_MAX)
}

function header() {
  return '【那段时间,我记得的是】(这是被折叠掉的那段历史留在你脑子里的东西 —— 不是刚发生的事,不要当成新事件复述)'
}
