// roleplay 关系核心（纯函数，无状态、无 ctx）——供 roleplay-host 调用，也供单测直接验证。
// 行为与 roleplay-host 内联版完全一致（行为保持重构，不改变任何数值规则）。
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
export function axisTier(v) { return v <= 33 ? 1 : v <= 66 ? 2 : 3 }
export function bfMeanOf(bf) {
  const b = bf || { reliability: 50, empathy: 50, stability: 50, ambition: 50 }
  return (b.reliability + b.empathy + b.stability + b.ambition) / 4
}
export function boyfriendFactorOf(bf) { return 0.6 + 0.8 * (bfMeanOf(bf) / 100) }
export function tierLabelOf(tierLabels, key, v) {
  const t = tierLabels && tierLabels[key]
  return t ? t[axisTier(v) - 1] : String(v)
}

// 里程碑满足度校验（不满足返回缺什么）
export function reqCheck(m, rel, tierLabels = {}) {
  const r = rel || {}
  const tier = (key) => axisTier(r[key] ?? 0)
  if (m.req && m.req.favorTier && tier('favor') < m.req.favorTier) return '好感还差一点（' + tierLabelOf(tierLabels, 'favor', r.favor) + '）'
  if (m.req && m.req.trustTier && tier('trust') < m.req.trustTier) return '信任还差一点（' + tierLabelOf(tierLabels, 'trust', r.trust) + '）'
  if (m.req && m.req.heartTier && tier('heart') < m.req.heartTier) return '心动还差一点（' + tierLabelOf(tierLabels, 'heart', r.heart) + '）'
  return null
}

// 关系阶段推导(纯函数)：档位 + 里程碑数 → 阶段
export function relationStageOf(rel, milestoneCount) {
  const r = rel || {}
  const ft = axisTier(r.favor), tt = axisTier(r.trust), ht = axisTier(r.heart)
  const n = milestoneCount || 0
  if (n >= 7 && ft >= 3 && tt >= 3 && ht >= 3) return 'special'
  if (n >= 5 && ft >= 3 && tt >= 2) return 'close_friend'
  if (n >= 3 && ft >= 2 && tt >= 2) return 'friend'
  if (n >= 1 && ft >= 2) return 'acquaintance'
  return 'stranger'
}

// 事件次数 → 阶段(纯函数)：order[0] 为基础档，后续档达到 60% 要求即晋升
export function computeStageOf(eventsCount, order, reqs) {
  const ev = eventsCount || {}
  let stage = (order && order[0]) || 'stranger'
  for (const s of (order || []).slice(1)) {
    const rq = (reqs && reqs[s]) || []
    const have = rq.filter((k) => (ev[k] || 0) > 0).length
    const need = Math.ceil(rq.length * 0.6)
    if (have >= need) stage = s
    else break
  }
  return stage
}

// 应用一次关系判断增量（好感/信任/心动 × 男友力缩放 + 心动锁 + 里程碑校验/反哺）
// opts: { isFriend, milestonesDef, tierLabels, bfLabels, keyLabels }
export function applyDelta(rel, bf, milestones, delta, opts = {}) {
  const { isFriend = false, milestonesDef = [], tierLabels = {}, bfLabels = {}, keyLabels = {} } = opts
  const r = { ...(rel || {}) }
  const b = { ...(bf || {}) }
  const fact = boyfriendFactorOf(b)
  const ms = Array.isArray(milestones) ? [...milestones] : []
  const changed = []
  let heartLocked = false
  const tierDelta = (key, before, after) => {
    const labels = tierLabels[key]
    return (labels && labels[0]) ? (keyLabels[key] || key) + ' ' + (after - before > 0 ? '+' : '') + Math.round(after - before) : null
  }
  const setAxis = (key, base) => {
    if (base === undefined) return
    const scaled = base >= 0 ? base * fact : base * (1.6 - 0.6 * fact)
    // 心动锁：favor/trust 未到二档禁止正增（locked 上报给调用方，避免静默吞掉）
    if (key === 'heart' && scaled > 0 && (axisTier(r.favor) < 2 || axisTier(r.trust) < 2)) { heartLocked = true; return }
    const before = r[key] || 0
    r[key] = clamp((r[key] || 0) + scaled, 0, 100)
    if (Math.abs(r[key] - before) >= 0.5) changed.push(tierDelta(key, before, r[key]))
  }
  for (const k of ['favor', 'trust', 'heart']) {
    if (isFriend && k === 'heart') continue
    if (typeof delta[k] === 'number') setAxis(k, delta[k])
  }
  // 朋友向：无男友力轴（恋爱向专属）
  if (!isFriend) {
    for (const k of ['reliability', 'empathy', 'stability', 'ambition']) {
      const v = delta.boyfriend && typeof delta.boyfriend[k] === 'number' ? delta.boyfriend[k] : undefined
      if (v !== undefined) {
        const before = b[k] || 0
        b[k] = clamp((b[k] || 0) + v, 0, 100)
        if (Math.abs(b[k] - before) >= 0.5) changed.push((bfLabels[k] || k) + ' ' + (v > 0 ? '+' : '') + v)
      }
    }
  }
  // 里程碑触发：校验 + 反哺
  let milestoneMsg = null
  const mId = delta.milestone
  if (mId) {
    const m = milestonesDef.find((x) => x.id === mId)
    if (m) {
      if (ms.includes(mId)) {
        milestoneMsg = { ok: false, message: '（里程碑「' + m.name + '」已触发过）' }
      } else {
        const miss = reqCheck(m, r, tierLabels)
        if (miss) {
          milestoneMsg = { ok: false, message: '（她心里还差一点：' + miss + '）' }
        } else {
          ms.push(mId)
          const rw = m.reward || {}
          if (rw.favor) r.favor = clamp(r.favor + rw.favor, 0, 100)
          if (rw.trust) r.trust = clamp(r.trust + rw.trust, 0, 100)
          if (rw.heart) r.heart = clamp(r.heart + rw.heart, 0, 100)
          if (rw.bfReliability) b.reliability = clamp(b.reliability + rw.bfReliability, 0, 100)
          milestoneMsg = { ok: true, message: '（里程碑触发：' + m.name + '）', milestone: m }
        }
      }
    }
  }
  return { relation: r, boyfriend: b, milestones: ms, changed, milestoneMsg, heartLocked }
}

// ── 重复行为递减（引擎侧"同一行为反复刷分"的兜底）────────────────
// recent: 最近几次评估的增量快照（旧→新，条目含 favor/trust/heart，可为 null 表示该轴未动；
//        decay:true 的条目表示"久别自动衰减"，视为行为计数中断）
// axis + dir（+1/-1）→ 本轴继续加同向增量时适用的系数：第 1 次 1.0 → 第 2 次 0.6 → 第 3+ 次 0.3
export function repeatDimOf(recent, axis, dir) {
  if (!dir) return 1
  const arr = Array.isArray(recent) ? recent : []
  let n = 0
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i]
    if (e && e.decay) return 1
    const v = e && typeof e[axis] === 'number' ? e[axis] : 0
    if (v === 0) continue
    if ((v > 0 ? 1 : -1) !== dir) break
    n++
  }
  if (n === 0) return 1
  if (n === 1) return 0.6
  return 0.3
}

// 按递减系数缩放 delta（favor/trust/heart 独立判定方向；男友力/里程碑/note 原样传递）
// 返回 { delta, dims }：dims 记录每轴实际系数（0 轴为 1），供调用方在消息里说明
export function dimDelta(delta, recent) {
  const d = delta || {}
  const out = {}
  const dims = { favor: 1, trust: 1, heart: 1 }
  for (const k of ['favor', 'trust', 'heart']) {
    const v = d[k]
    if (typeof v !== 'number') continue
    if (v === 0) { out[k] = 0; continue }
    const dim = repeatDimOf(recent, k, v > 0 ? 1 : -1)
    dims[k] = dim
    out[k] = Math.round(v * dim * 10) / 10
  }
  if (d.boyfriend && typeof d.boyfriend === 'object') out.boyfriend = { ...d.boyfriend }
  if (d.milestone !== undefined) out.milestone = d.milestone
  if (d.note !== undefined) out.note = d.note
  return { delta: out, dims }
}

// ── 久别衰减（负向保底：冷落她她会真的疏远）───────────────────────
// 超过 48h 未互动：每满 24h 信任 -1，封顶 cap（默认 5）；返回 { loss, next }
// next = 下一次应当基准的时间戳（避免同一天重复扣）；玩家回来（lastSeen 更新）后应重置基准
export function decayLossOf(lastSeen, lastDecayAt, now, cap = 5) {
  const EVEN = 48 * 3600 * 1000
  const DAY = 24 * 3600 * 1000
  if (!lastSeen) return { loss: 0, next: null }
  // 首次(无基准): 从 lastSeen 起算并含 48h 宽限；有基准: 从基准起算(宽限只给一次)
  const start = lastDecayAt || (lastSeen + EVEN)
  if (now < start) return { loss: 0, next: null }
  const days = Math.floor((now - start) / DAY)
  if (days < 1) return { loss: 0, next: null }
  return { loss: Math.min(days, cap), next: start + days * DAY }
}
