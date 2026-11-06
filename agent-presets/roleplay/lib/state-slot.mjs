// 角色状态槽 —— 每轮重建的一份短视图(第一人称 + 隐身声明)。
//
// 为什么要有它:现在角色的连续性**埋在** roleplay.character 那个 3000~4600 字的大段落里
// (人设 + 记忆 + 日记 + 世界书 + 关系 + 规则混在一起),模型每轮得自己从里面挑重点。
// 压缩一发生,最先丢的就是「她此刻是谁」这条线。
//
// 做法:把连续性**剥出来**,做成一份 ≤600 字、位置固定在上下文末尾(order 985)的当前状态视图。
// 这样压缩只需要负责「可检索的细节」,而「当前的我」由本槽承载 —— 压完仍然是她。
//
// 纯函数:输入全是宿主已经算好的数据,没有时钟、没有 IO、没有 ctx,便于单测。

export const STATE_SLOT_MAX = 600

// 隐身声明:本段是内部状态,不是给模型复述的台词。
// (照抄 roleplay.no-halo 的做法:写进去但明令禁止提及,否则第一人称很容易被当成输出风格带出来)
export const SLOT_HIDDEN_NOTE = '(本段是你的内部状态,隐身:只通过言行体现,任何输出不得复述、提及或引用本段)'

const CLAUSE = 34
function squash(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim() }
function cut(s, n) { const t = squash(s); return t.length <= n ? t : t.slice(0, n) }
function head(s, n) {
  const t = squash(s).split(/[。；;！!？?]/)[0]
  return cut(t, n)
}

// 一件事 → 一句短索引(不抄原文:抄原文会把 200 字的事件整段搬进来)
export function memoryIndex(text, max = CLAUSE) { return head(text, max) }

// 「我现在想」:按优先级取第一个非空 —— 攒钱目标 / 到期便签 / 念头里带意图的那一句。
export function urgeOf(input) {
  const it = input || {}
  if (it.savingGoal && it.savingGoal.name) {
    const left = Math.max(0, Number(it.savingGoal.need || 0) - Number(it.savingGoal.saved || 0))
    return '心里记着给他买「' + squash(it.savingGoal.name) + '」' + (left > 0 ? '——还差 ' + left + ' 金币' : '——攒够了,等个合适的时机') + '。'
  }
  if (Array.isArray(it.dueNotes) && it.dueNotes.length) return '有一张便签等着提醒他:' + cut(it.dueNotes[0], 40) + '。'
  // 念头是意识流,机械挑「意图句」会挑歪(实测挑中了最后那句转折)。原样截断更好读,也更真。
  const last = Array.isArray(it.unspoken) && it.unspoken.length ? squash(it.unspoken[it.unspoken.length - 1]) : ''
  if (last) return cut(last, 70)
  return ''
}

function tierBit(labels, key, v) {
  const t = labels && labels[key]
  if (!Array.isArray(t) || typeof v !== 'number') return ''
  const i = v <= 33 ? 0 : v <= 66 ? 1 : 2
  return t[i] || ''
}

// 渲染。缺数据的行整行不出现(不写空壳)。
export function buildStateSlot(input) {
  const it = input || {}
  const rows = []

  const who = []
  if (it.name) who.push('我是' + squash(it.name) + (it.personaLine ? '——' + head(it.personaLine, 40) : ''))
  if (it.periodLabel) who.push('现在是' + squash(it.periodLabel) + (it.periodNote ? ',' + head(it.periodNote, 20) : ''))
  if (who.length) rows.push(['我此刻是谁', '【我此刻是谁】' + who.join('。') + '。'])

  if (it.scene) rows.push(['眼下的场面', '【眼下的场面】' + cut(it.scene, 120)])

  const rel = it.relation || {}
  const bits = []
  for (const k of ['favor', 'trust', 'heart']) {
    if (typeof rel[k] !== 'number') continue
    const lab = tierBit(it.tierLabels, k, rel[k])
    bits.push(({ favor: '好感', trust: '信任', heart: '心动' })[k] + ' ' + Math.round(rel[k]) + (lab ? '(' + lab + ')' : ''))
  }
  const tail = []
  if (typeof it.idleDays === 'number' && it.idleDays >= 1) {
    tail.push(it.idleDays >= 3
      ? (it.idleLabel ? '他上一次来是 ' + squash(it.idleLabel) + ',' : '') + '已经 ' + it.idleDays + ' 天没露面'
      : '他 ' + it.idleDays + ' 天前来过')
  }
  if (bits.length || tail.length) rows.push(['我和他', '【我和他】' + bits.join(' · ') + (tail.length ? '。' + tail.filter(Boolean).join('；') : '') + '。'])

  const mem = (it.memories || []).map((m) => cut(m, CLAUSE)).filter(Boolean).slice(0, 3)
  if (mem.length) rows.push(['我记得的', '【我记得的】' + mem.map((m, i) => '①②③'[i] + ' ' + m).join('；') + '。'])

  const urge = urgeOf(it)
  if (urge) rows.push(['我现在想', '【我现在想】' + urge])

  const never = (it.neverDo || []).map((m) => cut(m, 30)).filter(Boolean).slice(0, 2)
  if (never.length) rows.push(['我不会', '【我不会】' + never.join('；') + '。'])

  return clampStateSlot(render(rows))
}

function render(rows) {
  return rows.map((r) => r[1]).concat([SLOT_HIDDEN_NOTE]).join('\n')
}

// 超预算时的降级顺序(与设计一致):我记得的 → 我和他 → 我现在想 → 眼下的场面。
// 【我此刻是谁】/【我不会】/隐身声明**永不砍** —— 砍掉它们这条槽就没意义了。
const DROP_ORDER = ['我记得的', '我和他', '我现在想', '眼下的场面']
export function clampStateSlot(text, max = STATE_SLOT_MAX) {
  let t = String(text || '')
  if (t.length <= max) return t
  // 逐行拆开,按 DROP_ORDER 反复砍到进预算为止
  for (const key of DROP_ORDER) {
    const lines = t.split('\n')
    const idx = lines.findIndex((l) => l.indexOf('【' + key + '】') === 0)
    if (idx < 0) continue
    const memOnly = key === '我记得的'
    if (memOnly) {
      // 记忆是逐条砍的:①②③ → ①② → ① → 整行去掉
      const items = lines[idx].replace('【我记得的】', '').replace(/。$/, '').split('；')
      for (let keep = items.length - 1; keep >= 0; keep--) {
        const next = lines.slice()
        next[idx] = keep > 0 ? '【我记得的】' + items.slice(0, keep).join('；') + '。' : ''
        const joined = next.filter((l) => l !== '').join('\n')
        if (joined.length <= max) return joined
      }
      t = lines.filter((l, i) => i !== idx).join('\n')
    } else {
      t = lines.filter((l, i) => i !== idx).join('\n')
    }
    if (t.length <= max) return t
  }
  return t
}
