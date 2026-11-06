// 记忆自动召回 —— 纯函数(无时钟、无 IO),便于单测。
//
// 设计(2026-11-06):不再依赖模型主动调 roleplay_recall。
//   1) 每条记忆带 tags(标签)与 weight(权重);
//   2) 每轮拿用户刚说的话去命中标签,挑 8 条最相关的;
//   3) 最近两轮注入过的排除掉,保证「每轮都在变」。
//
// 为什么标签不让模型当唯一来源:1200+ 条历史记忆没有标签,靠模型补不现实;
// 所以 deriveTags 永远能用文本自己推出标签,模型给不给 tags 都不影响。
//
// 为什么权重是「每条记忆一个数」而不是「标签权重表」:
//   两级权重参数多、难调、也解释不清;
//   一个 0~100 的记忆权重 + 「命中标签数」当乘数,已经够用且好解释。

export const PICK_COUNT = 8            // 每轮注入条数
export const ROTATE_AVOID = 16         // 最近 16 条(约两轮)不重复
export const TAG_MAX = 5               // 每条记忆最多几个标签
export const DIGEST_CHARS = 240        // 当日摘要上限

// 手选标签表:必须是「用户说的话里也可能出现的词」,否则永远匹配不上。
export const TAG_SEED = [
  // 日常/学校
  '补课', '作业', '考试', '上课', '学校', '同学', '老师', '放学', '暑假', '周末',
  // 家/家人
  '妈妈', '爸爸', '家里', '做饭', '早饭', '晚饭', '睡觉', '起床', '小熊', '收拾',
  // 恋爱/关系
  '喜欢', '告白', '表白', '约定', '答应', '拥抱', '抱', '牵手', '亲吻', '亲',
  '想他', '想你', '想念', '吃醋', '害羞', '撒娇', '生气', '难过', '哄',
  '宝宝', '爱酱', '亲爱的', '称呼', '昵称', '暗号', '生日', '礼物', '惊喜',
  // 她的世界
  '网球', '球拍', '练习', '比赛', '社团', '教室', '图书室', '天台', '走廊', '夜市',
  '照片', '头像', '背景', '旅行', '水族馆', '晚霞', '星星', '月亮', '雨', '雪',
  // 他的事
  '游戏', '解包', '插件', '代码', '电脑', '手机', '耳机', '英文歌', '动漫', '电影',
  'GPT', '模型', 'AI', '画画', '写作业', '复习', '眼镜', '外套', '自行车',
  // 其他
  '日记', '梦', '心跳', '便签', '真心话', '大冒险',
]

export const STOP_TAGS = ['用户', '角色', '事情', '感觉', '时候', '今天', '昨天', '现在', '然后', '因为', '所以', '一个', '什么', '自己', '已经', '有点', '还是', '就是']

function squash(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\u3000-\u303f\uff00-\uffef!-/:-@\[-\`{-~]/g, ' ').trim()
}

// 从一段文本里抽「候选标签」:中文 2~4 字滑窗 + 英文词,去掉停用词。
export function tokenize(text) {
  const s = squash(text)
  const out = []
  if (!s) return out
  const chunks = s.split(' ').filter(Boolean)
  for (const c of chunks) {
    if (/^[A-Za-z][A-Za-z0-9]+$/.test(c)) { out.push(c.toLowerCase()); continue }
    const zh = c.replace(/[A-Za-z0-9]/g, '')
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= zh.length; i++) {
        const t = zh.slice(i, i + n)
        if (STOP_TAGS.indexOf(t) >= 0) continue
        out.push(t)
      }
    }
  }
  return out
}

// 一段文本命中了哪些「种子标签」(子串匹配;种子表里的词才可能成为标签)
export function seedHits(text) {
  const s = squash(text)
  if (!s) return []
  const hits = []
  for (const t of TAG_SEED) if (s.indexOf(t) >= 0) hits.push(t)
  return hits
}

// 生成一条记忆的标签:种子命中 > subject > 文本候选 > 兜底「日常」。上限 TAG_MAX。
export function deriveTags(event, subject, kind) {
  const out = []
  const push = (t) => {
    const v = String(t || '').trim()
    if (!v || v.length > 6) return
    if (STOP_TAGS.indexOf(v) >= 0) return
    if (out.indexOf(v) >= 0) return
    if (out.length < TAG_MAX) out.push(v)
  }
  for (const h of seedHits(event)) push(h)
  if (subject) push(String(subject).slice(0, 6))
  if (kind) push(String(kind).slice(0, 6))
  if (!out.length) {
    const toks = tokenize(event).filter((t) => t.length >= 3)
    toks.sort((a, b) => b.length - a.length)
    for (const t of toks) { push(t); if (out.length >= 2) break }
  }
  if (!out.length) out.push('日常')
  return out
}

// 权重 0~100。pinned > importance;count 多更重;越靠数组尾部越新
// (first/last 大面积为空,只能用数组顺序当新旧)。
export function weightOf(m, index, total) {
  if (!m) return 0
  const base = m.pinned ? 90 : (m.importance === 'high' ? 60 : m.importance === 'mid' ? 40 : 20)
  const cnt = Math.max(0, Number(m.count || 1) - 1)
  const countBonus = Math.min(cnt, 5) * 4
  const n = Math.max(1, Number(total) || 1)
  const recencyBonus = Math.round(15 * ((Number(index) || 0) / Math.max(1, n - 1)))
  return Math.max(0, Math.min(100, base + countBonus + recencyBonus))
}

function keyOf(m, i) {
  const e = String((m && m.event) || '')
  return e.length > 48 ? e.slice(0, 48) : (e || ('#' + i))
}

// 打分:命中标签数 × 40 + 权重 × 0.6;没命中返回 0(由 pickForTurn 决定兜底)
export function scoreMemory(m, ctxTags, index) {
  const tags = Array.isArray(m && m.tags) ? m.tags : []
  let hits = 0
  for (const t of tags) {
    if (ctxTags && typeof ctxTags.has === 'function' ? ctxTags.has(t) : (Array.isArray(ctxTags) && ctxTags.indexOf(t) >= 0)) hits++
  }
  const w = typeof (m && m.weight) === 'number' ? m.weight : weightOf(m, index, 1)
  if (hits === 0) return 0
  return hits * 40 + w * 0.6
}

// 每轮挑 count 条。
//   ctxText: 用户刚说的话;recentKeys: 最近注入过的 key(排除 → 每轮都变);
//   有命中 → 只取命中的(不硬凑无关记忆);一个都没命中 → 退回权重最高的几条(同样轮换)。
export function pickForTurn(list, ctxText, recentKeys, count) {
  const arr = Array.isArray(list) ? list : []
  const n = Math.max(1, Math.min(Number(count) || PICK_COUNT, 32))
  const ctxTags = new Set(seedHits(ctxText))
  const avoid = new Set(Array.isArray(recentKeys) ? recentKeys : [])
  const scored = []
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i]
    if (!m || !m.event) continue
    const key = keyOf(m, i)
    if (avoid.has(key)) continue
    const s = scoreMemory(m, ctxTags, i)
    if (s > 0) scored.push({ m, key, s })
  }
  let pick = scored
  if (pick.length) {
    pick.sort((a, b) => b.s - a.s)
    pick = pick.slice(0, n)
  } else {
    const rest = []
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i]
      if (!m || !m.event) continue
      const key = keyOf(m, i)
      if (avoid.has(key)) continue
      rest.push({ m, key, s: typeof m.weight === 'number' ? m.weight : weightOf(m, i, arr.length) })
    }
    rest.sort((a, b) => b.s - a.s)
    pick = rest.slice(0, n)
  }
  return { pick: pick.map((x) => x.m), keys: pick.map((x) => x.key) }
}

// 当日摘要:只收「今天写下的」记忆(first 或 last 等于 day)。没有就返回空,不硬编。
export function digestOf(list, day, maxChars) {
  const d = String(day || '')
  const max = Math.max(60, Number(maxChars) || DIGEST_CHARS)
  const arr = Array.isArray(list) ? list : []
  if (!d) return { text: '', tags: [] }
  // 注意:m.last 是 stamp() 格式(2026-11-06 20:30),只比前 10 位日期
  const sameDay = (v) => String(v || '').slice(0, 10) === d
  const todays = arr.filter((m) => m && m.event && (sameDay(m.last) || sameDay(m.first)))
  if (!todays.length) return { text: '', tags: [] }
  const sorted = todays.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
  const tags = []
  let text = ''
  for (const m of sorted) {
    const piece = String(m.event).replace(/\s+/g, ' ').trim()
    if (!piece) continue
    const next = text ? (text + '；' + piece) : piece
    if (next.length > max) break
    text = next
    for (const t of (Array.isArray(m.tags) ? m.tags : [])) if (tags.indexOf(t) < 0 && tags.length < 6) tags.push(t)
  }
  return { text: text, tags: tags }
}
