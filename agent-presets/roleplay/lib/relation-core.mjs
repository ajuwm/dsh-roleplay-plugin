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

// 应用一次关系判断增量（好感/信任/心动 × 男友力缩放 + 心动锁 + 里程碑校验/反哺）
// opts: { isFriend, milestonesDef, tierLabels, bfLabels, keyLabels }
export function applyDelta(rel, bf, milestones, delta, opts = {}) {
  const { isFriend = false, milestonesDef = [], tierLabels = {}, bfLabels = {}, keyLabels = {} } = opts
  const r = { ...(rel || {}) }
  const b = { ...(bf || {}) }
  const fact = boyfriendFactorOf(b)
  const ms = Array.isArray(milestones) ? [...milestones] : []
  const changed = []
  const tierDelta = (key, before, after) => {
    const labels = tierLabels[key]
    return (labels && labels[0]) ? (keyLabels[key] || key) + ' ' + (after - before > 0 ? '+' : '') + Math.round(after - before) : null
  }
  const setAxis = (key, base) => {
    if (base === undefined) return
    const scaled = base >= 0 ? base * fact : base * (1.6 - 0.6 * fact)
    // 心动锁：favor/trust 未到二档禁止正增
    if (key === 'heart' && scaled > 0 && (axisTier(r.favor) < 2 || axisTier(r.trust) < 2)) return
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
  return { relation: r, boyfriend: b, milestones: ms, changed, milestoneMsg }
}
