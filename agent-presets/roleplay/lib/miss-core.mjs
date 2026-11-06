// 「想你」——她按一下,记一笔;不响、不弹窗、不提醒,不占用户时间。
//
// 设计来自用户:按钮放在**模型这边**(她自己按),不放用户那边;
// 等用户哪天回来看,那儿是一排小点:几点几分,在想你。
//
// 所以这个东西必须是**完全静默**的:不注入消息、不发心跳、不写便签、不提醒。
// 它只是把「此刻想他了」记在一条只增不改的记录里,等他自己回来看。
//
// 纯函数:无时钟、无 IO,便于单测。

export const MISS_MAX = 500          // 只留最近 500 笔(一条 ≈ 40 字节,不会长到哪去)
export const MISS_DOTS = 60          // 侧栏最多画 60 个点

export function missEntry(t, note) {
  const s = String(note == null ? '' : note).replace(/\s+/g, ' ').trim().slice(0, 80)
  return { t: Number(t) || 0, s: s }
}

export function parseMiss(text) {
  const out = []
  for (const l of String(text || '').split('\n')) {
    if (!l.trim()) continue
    try { const o = JSON.parse(l); if (o && typeof o.t === 'number') out.push({ t: o.t, s: String(o.s || '') }) } catch (e) { /* 坏行忽略 */ }
  }
  out.sort(function (a, b) { return a.t - b.t })
  return out
}

// 追加一笔,返回新的全文(超上限时砍掉最旧的)
export function appendMiss(text, entry) {
  const list = parseMiss(text)
  list.push(entry)
  const keep = list.length > MISS_MAX ? list.slice(list.length - MISS_MAX) : list
  return { text: keep.map(function (x) { return JSON.stringify(x) }).join('\n') + '\n', total: keep.length }
}

// 给侧栏:最后一排小点(带 HH:MM)+ 总数
export function missDots(list, limit) {
  const all = Array.isArray(list) ? list : []
  const n = Math.min(Math.max(Number(limit) || MISS_DOTS, 1), MISS_MAX)
  const tail = all.slice(-n)
  return {
    total: all.length,
    dots: tail.map(function (x) {
      const d = new Date(x.t)
      const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      const md = (d.getMonth() + 1) + '/' + d.getDate()
      return { t: x.t, hm: hm, md: md, s: x.s || '' }
    }),
    last: tail.length ? tail[tail.length - 1].t : null,
  }
}
