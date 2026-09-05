// roleplay 小游戏核心(纯函数,无状态、无 ctx)——规则由宿主判定,AI 只负责用角色口吻扮演。
// 四种游戏: guess 猜数字(1-100,10次) / twenty 二十问(特征表判定) / ttt 井字棋(简单策略) / truth 真心话大冒险(题库按关系档位)。

// ── 猜数字 ────────────────────────────────────────────────────
export function guessStart(range = 100, limit = 10) {
  const r = Math.max(10, Number(range) || 100)
  return { kind: 'guess', secret: 1 + Math.floor(Math.random() * r), range: r, tries: 0, limit, over: false, won: false, history: [] }
}
export function guessMove(st, n) {
  const v = Math.round(Number(n))
  if (st.over) return { ...st, lastResult: 'over' }
  if (!Number.isFinite(v)) return { ...st, lastResult: 'invalid' }
  const next = { ...st, tries: st.tries + 1, history: st.history.concat([v]) }
  if (v === st.secret) {
    return { ...next, over: true, won: true, lastResult: 'win' }
  }
  if (next.tries >= st.limit) {
    return { ...next, over: true, won: false, lastResult: 'lose', secret: st.secret }
  }
  return { ...next, lastResult: v < st.secret ? 'low' : 'high' }
}

// ── 二十问 ────────────────────────────────────────────────────
// 词库: noun(名词), cat(类), features 特征表
export const TWENTY_WORDS = [
  { noun: '苹果', cat: 'fruit', features: { color: 'red', edible: true, canFly: false, size: 'small', living: false, animal: false, youUse: true } },
  { noun: '香蕉', cat: 'fruit', features: { color: 'yellow', edible: true, canFly: false, size: 'small', living: false, animal: false, youUse: true } },
  { noun: '西瓜', cat: 'fruit', features: { color: 'green', edible: true, canFly: false, size: 'big', living: false, animal: false, youUse: true } },
  { noun: '拉面', cat: 'food', features: { color: 'white', edible: true, canFly: false, size: 'small', living: false, animal: false, youUse: true } },
  { noun: '披萨', cat: 'food', features: { color: 'yellow', edible: true, canFly: false, size: 'small', living: false, animal: false, youUse: true } },
  { noun: '手机', cat: 'object', features: { color: 'black', edible: false, canFly: false, size: 'small', living: false, animal: false, youUse: true } },
  { noun: '铅笔', cat: 'object', features: { color: 'yellow', edible: false, canFly: false, size: 'small', living: false, animal: false, youUse: true } },
  { noun: '雨伞', cat: 'object', features: { color: 'black', edible: false, canFly: false, size: 'small', living: false, animal: false, youUse: true } },
  { noun: '狗', cat: 'animal', features: { color: 'white', edible: false, canFly: false, size: 'small', living: true, animal: true, youUse: false } },
  { noun: '猫', cat: 'animal', features: { color: 'white', edible: false, canFly: false, size: 'small', living: true, animal: true, youUse: false } },
  { noun: '大象', cat: 'animal', features: { color: 'grey', edible: false, canFly: false, size: 'big', living: true, animal: true, youUse: false } },
  { noun: '企鹅', cat: 'animal', features: { color: 'black', edible: false, canFly: false, size: 'small', living: true, animal: true, youUse: false } },
]
export function twentyStart() {
  const i = Math.floor(Math.random() * TWENTY_WORDS.length)
  return { kind: 'twenty', secretIndex: i, asks: 0, limit: 20, over: false, won: false, log: [] }
}
// 问题 → 特征条件(关键词匹配; 返回 null 表示无法判定)
export function twentyClassify(q) {
  const s = String(q || '').replace(/\s+/g, '')
  if (!s) return null
  const has = (re) => re.test(s)
  const cond = {}
  if (has(/是动物|动物吗|活物|生物/)) cond.animal = true
  if (has(/是植物|植物吗/)) cond.living = false
  if (has(/水果|是一种水果/)) cond.cat = 'fruit'
  if (has(/吃的|吃吗|能吃|可以吃|可食|食物|可以喝|能喝/)) { cond.edible = true; if (has(/食物|是吃的/)) cond.cat = 'food' }
  if (has(/会飞|能飞|飞吗/)) cond.canFly = true
  if (has(/红的|红色|白色的|白色|黑的|黑色|黄色|绿色|蓝色|紫的|颜色/)) { const m = s.match(/(红|白|黑|黄|绿|蓝|紫)色?/) ; if (m) cond.color = { '红': 'red', '白': 'white', '黑': 'black', '黄': 'yellow', '绿': 'green', '蓝': 'blue', '紫': 'purple' }[m[1]] }
  if (has(/很大|大吗|比.大|大的/)) cond.size = 'big'
  if (has(/很小|小吗|小的/)) cond.size = 'small'
  if (has(/生活用品|用的东西|用过|有这个东西|在.*家里|常见/)) cond.youUse = true
  if (has(/人吗|职业|老师|医生/)) cond.living = true
  if (has(/手机|文具|工具/)) cond.cat = 'object'
  return Object.keys(cond).length ? cond : null
}
export function twentyJudge(word, cond) {
  if (!word || !cond) return null
  const f = word.features || {}
  for (const k of Object.keys(cond)) {
    const want = cond[k]
    if (k === 'cat') { if (f.cat !== want) return 'no'; continue }
    if (f[k] !== want) return 'no'
  }
  return 'yes'
}
export function twentyGuess(word, guess) {
  const g = String(guess || '').trim()
  if (!g) return false
  return g === word.noun || (g.length >= 2 && word.noun.includes(g))
}

// ── 井字棋 ────────────────────────────────────────────────────
export const TTT_EMPTY = ' '.repeat(9)
export const TTT_WINS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]
export function tttWinner(board) {
  const b = String(board || '').padEnd(9, ' ')
  for (const [a, c, d] of TTT_WINS) {
    if (b[a] !== ' ' && b[a] === b[c] && b[a] === b[d]) return b[a]
  }
  return b.indexOf(' ') < 0 ? 'draw' : null
}
export function tttMove(board, cell, p) {
  const b = Array.from(String(board || '').padEnd(9, ' '))
  const i = Number(cell)
  if (!Number.isInteger(i) || i < 0 || i > 8 || b[i] !== ' ') return { board: String(board || '').padEnd(9, ' '), ok: false }
  b[i] = p === 'X' ? 'X' : 'O'
  return { board: b.join(''), ok: true }
}
// AI 落子: 先赢 → 再堵 → 中心 → 角落 → 边
export function tttAiMove(board, ai) {
  const me = ai || 'O', op = me === 'X' ? 'O' : 'X'
  const b = String(board || '').padEnd(9, ' ')
  const tryLine = (p) => {
    for (const [a, c, d] of TTT_WINS) {
      const cells = [b[a], b[c], b[d]]
      let hit = -1
      let others = 0
      for (let i = 0; i < 3; i++) {
        if (cells[i] === ' ') hit = [a, c, d][i]
        else if (cells[i] === p) others++
      }
      if (others === 2 && hit >= 0) return hit
    }
    return null
  }
  const win = tryLine(me)
  if (win !== null) return win
  const block = tryLine(op)
  if (block !== null) return block
  if (b[4] === ' ') return 4
  for (const c of [0, 2, 6, 8]) if (b[c] === ' ') return c
  for (const c of [1, 3, 5, 7]) if (b[c] === ' ') return c
  return -1
}
export function tttStart() {
  return { kind: 'ttt', board: TTT_EMPTY, your: 'X', ai: 'O', over: false, winner: null, moves: 0 }
}
export function tttApply(st, cell) {
  const m = tttMove(st.board, cell, st.your)
  if (!m.ok) return { ...st, lastResult: 'invalid' }
  let b = m.board
  let winner = tttWinner(b)
  let over = winner !== null
  if (!over) {
    const aiCell = tttAiMove(b, st.ai)
    b = tttMove(b, aiCell, st.ai).board
    winner = tttWinner(b)
    over = winner !== null
    return { ...st, board: b, moves: st.moves + 1, aiCell, over, winner }
  }
  return { ...st, board: b, moves: st.moves + 1, over, winner }
}

// ── 真心话大冒险 ──────────────────────────────────────────────
// 题库按关系档位分级: 1=陌生人/普通认识 2=朋友/亲密朋友 3=特殊关系
export const TRUTH_PROMPTS = {
  1: [
    { kind: 'truth', text: '第一次见到我时,你心里在想什么?' },
    { kind: 'truth', text: '如果满分十分,现在给我们今天的相遇打几分?' },
    { kind: 'truth', text: '最近一次开心得想哼歌,是因为什么事?' },
    { kind: 'dare', text: '用一句话模仿我说话的样子,不许笑场。' },
    { kind: 'dare', text: '说一个你现在最想做的、很小很小的事。' },
    { kind: 'dare', text: '假装生气三秒钟,然后立刻破功。' },
  ],
  2: [
    { kind: 'truth', text: '你最喜欢我做的哪一件事?' },
    { kind: 'truth', text: '你有没有偷偷记住过我说过的某句话?' },
    { kind: 'truth', text: '如果我们可以一起做一件事,你想做什么?' },
    { kind: 'dare', text: '连续夸我三句,每一句都不能重复。' },
    { kind: 'dare', text: '用动作表演「想我」的时候,在我面前演一遍。' },
    { kind: 'dare', text: '现在,给我讲一个你心里的小秘密。' },
  ],
  3: [
    { kind: 'truth', text: '如果有一天再也见不到我,你最想留给我什么?' },
    { kind: 'truth', text: '你有没有哪一刻,真的动了「想一直在一起」的念头?' },
    { kind: 'truth', text: '现在,你想牵我的手吗?' },
    { kind: 'dare', text: '把「我喜欢你」小声说一遍,然后假装那是台词。' },
    { kind: 'dare', text: '闭上眼睛十秒,睁开时第一句话要温柔地叫我。' },
    { kind: 'dare', text: '现在许一个关于我们俩的愿望,必须说出口。' },
  ],
}
export function truthTierOf(stage) {
  const s = String(stage || 'stranger')
  if (s === 'special') return 3
  if (s === 'friend' || s === 'close_friend') return 2
  return 1
}
export function truthStart(tier) {
  const pool = TRUTH_PROMPTS[tier] || TRUTH_PROMPTS[1]
  // 按当前问题数轮换(防重复)
  return { kind: 'truth', tier, round: 0, pending: null, over: false }
}
export function truthDraw(tier, round, rnd) {
  const pool = TRUTH_PROMPTS[tier] || TRUTH_PROMPTS[1]
  const i = Math.floor((rnd || Math.random)() * pool.length)
  return pool[i] || pool[0]
}

// ── 展示/注入辅助(宿主事实文本) ────────────────────────────────
export function guessHintText(lastResult, secret) {
  if (lastResult === 'win') return '被猜中了!秘密数是 ' + secret
  if (lastResult === 'lose') return '机会用完了,秘密数是 ' + secret
  if (lastResult === 'high') return '猜大了'
  if (lastResult === 'low') return '猜小了'
  return ''
}
export function tttBoardText(board) {
  const b = String(board || '').padEnd(9, ' ')
  let out = ''
  for (let r = 0; r < 3; r++) {
    out += '[' + Array.from(b.slice(r * 3, r * 3 + 3)).map((c) => c === ' ' ? '·' : c).join('·') + ']'
    if (r < 2) out += '\n'
  }
  return out
}
