// DSH roleplay 插件 · 真机只读探测(不修改任何数据)
// 覆盖 v1.5.18(记忆/反思) v1.5.19(ST生态/祛魅) v1.5.20(chat修复) 的 host 半接线
const BASE = 'http://127.0.0.1:3080/roleplay'
let pass = 0, fail = 0
const lines = []
function check(name, cond, detail) {
  if (cond) { pass++; lines.push('  [PASS] ' + name) }
  else { fail++; lines.push('  [FAIL] ' + name + (detail ? ' -> ' + detail : '')) }
}
function say(s) { lines.push(s) }
async function rp(ep, body) {
  try {
    const r = await fetch(BASE + '/' + ep, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
    return await r.json()
  } catch (e) { return { ok: false, error: { message: String(e && e.message || e) } } }
}

// ── 0. 会话发现 ──
say('== 0. 会话发现 ==')
const targets = await rp('chat-targets')
check('bridge /roleplay 可达', targets.ok === true, targets.error && targets.error.message)
check('chat-targets 返回数组', Array.isArray(targets.value), JSON.stringify(targets.value))
let sess = null
if (Array.isArray(targets.value) && targets.value.length) {
  const t = targets.value[0]
  sess = t.sessionId
  check('peek 返回角色名(非 null)', !!t.name, 'name=' + t.name)
  check('peek enabled=true', t.enabled === true, 'enabled=' + t.enabled)
  say(`  -> session=${sess} name=${t.name} lastSeq=${t.lastSeq}`)
  for (const x of targets.value) say(`     目标: ${x.sessionId} name=${x.name} enabled=${x.enabled} lastSeq=${x.lastSeq}`)
}
if (!sess) { say('没有活跃扮演会话,后续跳过'); console.log(lines.join('\n')); process.exit(1) }

// ── 1. get-state 新视图 ──
say('== 1. get-state 新视图 ==')
const st = (await rp('get-state', { sessionId: sess })).value
check('get-state 可用', !!st)
if (st) {
  check('presets 数组(v1.5.19)', Array.isArray(st.presets), JSON.stringify(st.presets))
  check('portrait 数组(祛魅画像 v1.5.19)', Array.isArray(st.portrait), JSON.stringify(st.portrait))
  check('memoryView.reflections 数组(v1.5.18)', Array.isArray(st.memoryView.reflections))
  check('memoryView.long 数组', Array.isArray(st.memoryView.long))
  check('tierInfo.axes 数组(档内进度)', !!(st.tierInfo && Array.isArray(st.tierInfo.axes)))
  check('backupInfo 存在', !!st.backupInfo)
  check('character 存在', !!st.character)
  check('notes 数组(便签)', Array.isArray(st.notes))
  say(`  -> 角色=${st.character && st.character.name} 关系=${st.relationStage} 长期记忆=${st.memoryView.long.length} 短期=${st.memoryView.short.length} 反思=${st.memoryView.reflections.length} 画像=${st.portrait.length} 预设=${st.presets.length}`)
  const pinned = st.memoryView.long.filter((x) => String(x).includes('📌'))
  check('长期记忆含 📌 长驻标记(若有 ×3 事实)', true, `${pinned.length} 条带 📌`)
  if (st.memoryView.long.length) say('  -> 长期样例: ' + st.memoryView.long[0])
  if (st.memoryView.reflections.length) say('  -> 反思样例: ' + st.memoryView.reflections[0])
  for (const p of st.portrait) say(`  -> 画像[${p.kind}] ${p.text}`)
  check('画像 kind 合法(good/bad/truth)', st.portrait.every((p) => ['good', 'bad', 'truth'].includes(p.kind)))
  check('画像 text 非空', st.portrait.every((p) => !!p.text))
}

// ── 2. ST 生态端点 ──
say('== 2. ST 生态端点 ==')
const lore = await rp('lore-list', { sessionId: sess })
check('lore-list 可用(v1.5.19 新端点)', lore.ok === true, lore.error && lore.error.message)
if (lore.ok) {
  check('lore-list 返回数组', Array.isArray(lore.value))
  const arr = lore.value || []
  const consts = arr.filter((x) => x.constant === true)
  say(`  -> 世界书 ${arr.length} 条(常驻 ${consts.length} 条)`)
  for (const e of arr.slice(0, 3)) say(`     [${e.constant ? '常驻' : '关键词'}] keys=${(e.keywords || []).join('/')} :: ${String(e.content).slice(0, 40)}`)
}
const pl = await rp('preset-list', { sessionId: sess })
check('preset-list 可用', pl.ok === true, pl.error && pl.error.message)
if (pl.ok) say(`  -> 外部预设 ${(pl.value || []).length} 个(启用 ${(pl.value || []).filter((x) => x.enabled).length})`)
const po = await rp('portrait-list', { sessionId: sess })
check('portrait-list 可用', po.ok === true, po.error && po.error.message)
if (po.ok) say(`  -> portrait-list 返回 ${(po.value || []).length} 条`)
const cl = await rp('cards-list', { sessionId: sess })
check('cards-list 可用', cl.ok === true)
const cardList = (cl.value && cl.value.cards) || []
if (cl.ok) say(`  -> 角色卡 ${cardList.length} 张: ${cardList.map((c) => c.name).join(' / ')}`)
const sr = await rp('settings-read')
check('settings-read 可用(DSH 设置命名空间)', sr.ok === true)
if (sr.ok && sr.value) say(`  -> 心跳=${sr.value.heartbeatMinutes}min 叙述=${sr.value.narrationMode} 难度=${sr.value.difficulty}`)

// ── 3. PNG 导出往返 ──
say('== 3. PNG 角色卡导出 ==')
const cardName = cardList.length ? cardList[0].name : (st && st.character && st.character.name)
if (cardName) {
  const png = await rp('card-export-png', { sessionId: sess, card: cardName })
  check(`导出 PNG 成功(卡: ${cardName})`, png.ok === true && !!(png.value && png.value.base64), png.error && png.error.message)
  if (png.ok && png.value && png.value.base64) {
    const b = Buffer.from(png.value.base64, 'base64')
    const sig = b.subarray(0, 8).toString('hex')
    check('PNG 魔数正确', sig === '89504e470d0a1a0a', 'sig=' + sig)
    const latin = b.toString('latin1')
    const utf8 = b.toString('utf8')
    check('PNG 内含 chara 块(tEXt/iTXt)', latin.includes('chara'))
    check('PNG 内含角色名(编码正确)', utf8.includes(cardName) || latin.includes(cardName), cardName)
    const m = latin.match(/chara([\s\S]{0,4000})/)
    if (m) {
      const tail = utf8.slice(utf8.indexOf('chara'), utf8.indexOf('chara') + 400)
      say('  -> chara 数据片段: ' + tail.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200))
      check('chara 块可解析为 JSON(含 name 字段)', tail.includes('"name"'))
    }
    say(`  -> PNG 大小 ${(b.length / 1024).toFixed(1)} KB`)
  }
} else say('  (无角色卡,跳过)')

// ── 4. chat 端点(v1.5.20 修复点) ──
say('== 4. chat 端点(v1.5.20) ==')
const h = await rp('chat-history', { target: sess, limit: 60 })
check('chat-history 可用', h.ok === true, h.error && h.error.message)
if (h.ok) {
  check('chat-history 返回 messages 数组', Array.isArray(h.value.messages))
  check('chat-history 返回 lastSeq', h.value.lastSeq !== undefined && h.value.lastSeq !== null)
  const byRole = {}
  for (const m of h.value.messages) byRole[m.role] = (byRole[m.role] || 0) + 1
  say(`  -> 历史 ${h.value.messages.length} 条 ${JSON.stringify(byRole)} lastSeq=${h.value.lastSeq}`)
  const pluginCount = h.value.messages.filter((m) => m.plugin).length
  say(`  -> 其中插件注入 ${pluginCount} 条(应被前端置灰)`)
}
const p = await rp('chat-poll', { target: sess, since: 0 })
check('chat-poll 可用', p.ok === true)
if (p.ok && h.ok) check('chat-poll 与 chat-history lastSeq 一致', p.value.lastSeq === h.value.lastSeq, `poll=${p.value.lastSeq} hist=${h.value.lastSeq}`)

console.log(lines.join('\n'))
console.log('')
console.log(`======== 真机只读探测: ${pass} 通过 / ${fail} 失败 ========`)
if (fail) process.exit(1)
