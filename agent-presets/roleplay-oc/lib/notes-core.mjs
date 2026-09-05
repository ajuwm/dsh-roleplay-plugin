// roleplay 便签核心(纯函数,无状态、无 ctx)——供 roleplay-host 调用,也供单测直接验证。
// 便签条目: { id, text, at(显示时间), ts(ms), expiresAt(ms|null), pinned, read, reminded, deleted, pos:{x,y}|null, source }
// 删除用墓碑(deleted:true)而非物理移除:跨实例合并时"谁删了"不会被另一个实例的新增覆盖。

export function noteCreate(list, n) {
  const l = Array.isArray(list) ? list : []
  const note = {
    id: n && n.id ? String(n.id) : 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    text: String((n && n.text) || '').trim().slice(0, 80),
    at: (n && n.at) || new Date().toISOString().slice(0, 16).replace('T', ' '),
    ts: Number((n && n.ts) || Date.now()),
    expiresAt: (n && Number.isFinite(Number(n.expiresAt)) && Number(n.expiresAt) > 0) ? Number(n.expiresAt) : null,
    pinned: !!(n && n.pinned),
    read: !!(n && n.read),
    reminded: !!(n && n.reminded),
    deleted: false,
    pos: (n && n.pos && typeof n.pos.x === 'number' && typeof n.pos.y === 'number') ? { x: n.pos.x, y: n.pos.y } : null,
    source: (n && n.source) || 'ai',
  }
  return { list: l.concat([note]), note }
}

// 操作: read=已读 / pin=置顶(+-) / delete=删除(墓碑) / pos=记录窗口位置
export function noteAck(list, id, action, value) {
  const l = Array.isArray(list) ? list : []
  let changed = false
  const out = l.map((n) => {
    if (!n || n.id !== id) return n
    changed = true
    if (action === 'read') return { ...n, read: true }
    if (action === 'pin') return { ...n, pinned: !!value }
    if (action === 'delete') return { ...n, deleted: true, pinned: false }
    if (action === 'pos' && value && typeof value.x === 'number' && typeof value.y === 'number') {
      return { ...n, pos: { x: Math.round(value.x), y: Math.round(value.y) } }
    }
    changed = false
    return n
  })
  return { list: out, changed, note: out.find((n) => n.id === id) || null }
}

// 可见列表: 未删除; 置顶优先, 其次按时间倒序
export function visibleNotes(list) {
  const l = Array.isArray(list) ? list : []
  return l.filter((n) => n && !n.deleted)
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      return (b.ts || 0) - (a.ts || 0)
    })
}

// 到期且尚未提醒的便签(reminded 标志防止重复提醒)
export function dueNotes(list, now) {
  const l = Array.isArray(list) ? list : []
  const t = Number(now) || Date.now()
  return l.filter((n) => n && !n.deleted && !n.reminded && Number.isFinite(n.expiresAt) && n.expiresAt <= t)
}

// 跨实例合并: 按 id 并集; 同 id 以"删除墓碑优先", 否则以 b(磁盘)为准
export function mergeNotes(a, b) {
  const map = new Map()
  for (const n of a || []) if (n && n.id) map.set(n.id, n)
  for (const n of b || []) {
    if (!n || !n.id) continue
    const me = map.get(n.id)
    if (me && me.deleted && !n.deleted) { map.set(n.id, me); continue }
    map.set(n.id, n)
  }
  return Array.from(map.values())
}
