// DSH 角色扮演插件 · 持久化 Host 半部分（v2.1 / 静态预设插件）
// 随 agent preset 挂载（`roleplay` 预设里的相对路径行），平台重启后自动恢复。
// 依赖服务：agents / fs / systemPrompt / timer / sandboxPolicy / subprocess / attachments
// 功能：角色卡注入、11 工具、心跳、演出流、记忆、里程碑、时段、生理维度、
//       世界书籍、ST 角色卡导入、扮演模式、回合审计、停演强制切回助手、
//       看桌面（截图注入对话）、可配置心跳间隔、设置面板。
// 对外：在 isolate realm 内发布 `roleplay` 服务（getState / stop），
//       由主机侧桥接插件经 RPC 通道 /roleplay 暴露给浏览器侧边栏。
// 本文件是自包含 ESM 模块：不导入任何裸包，只使用注入的 ctx 服务。

export const name = 'roleplay-host'
export const inject = ['agents', 'fs', 'systemPrompt', 'timer', 'sandboxPolicy', 'tools', 'subprocess', 'attachments']
export function apply(ctx) {
    const agents = ctx.agents
    const fs = ctx.fs
    const systemPrompt = ctx.systemPrompt
    const timer = ctx.timer
    const sandboxPolicy = ctx.sandboxPolicy
    const subprocess = ctx.subprocess
    const attachments = ctx.attachments

    // ── DSH 插件设置命名空间「roleplay」双通道同步 ────────────────────────
    // settings 是可选宿主服务（ctx.get 不阻塞挂载）：存在则与 DSH 右侧「插件设置」
    // 面板双向同步（角色扮演卡），不存在则退化为仅用 state.settings（侧栏仍可编辑）。
    // 迁移到面板的字段只有这 7 项；scriptStart/scriptEnd 及角色字段留在侧栏。
    const settingsSvc = ctx.get('settings')
    const MIGRATED_KEYS = ['heartbeatMinutes', 'narrationMode', 'difficulty', 'statsEnabled', 'relationEnabled', 'autoLook', 'shotMaxW', 'sideTheme']
    function pickMigrated(obj) {
      const out = {}
      if (!obj) return out
      for (const k of MIGRATED_KEYS) if (obj[k] !== undefined) out[k] = obj[k]
      return out
    }
    function namespaceUserHasData() {
      // 命名空间已注册且用户写过（user 段非空）= 面板已有内容，种子不得覆盖。
      if (!settingsSvc) return false
      try {
        const desc = settingsSvc.describe()
        const entry = (desc || []).find((d) => d && d.ns === 'roleplay')
        return !!(entry && entry.user && Object.keys(entry.user).length > 0)
      } catch (e) { return false }
    }
    function sanitizeMigrated(patch) {
      // 只接受合法值，防止面板文本框（narrationMode 等）脏数据污染 state.settings
      const out = {}
      if (patch.heartbeatMinutes !== undefined) { const n = Number(patch.heartbeatMinutes); if (n >= 5 && n <= 240) out.heartbeatMinutes = n }
      if (patch.shotMaxW !== undefined) out.shotMaxW = Math.max(0, Number(patch.shotMaxW) || 0)
      if (patch.autoLook !== undefined) out.autoLook = !!patch.autoLook
      if (patch.narrationMode === 'novel' || patch.narrationMode === 'compact' || patch.narrationMode === 'script') out.narrationMode = patch.narrationMode
      if (patch.statsEnabled !== undefined) out.statsEnabled = !!patch.statsEnabled
      if (patch.difficulty === 1 || patch.difficulty === 2 || patch.difficulty === 3) out.difficulty = patch.difficulty
      if (patch.relationEnabled !== undefined) out.relationEnabled = !!patch.relationEnabled
      if (patch.sideTheme === 'dark' || patch.sideTheme === 'light') out.sideTheme = patch.sideTheme
      return out
    }
    let nsSynced = false
    async function syncSettingsFromNamespace() {
      // 与 DSH「插件设置」命名空间对齐一次：
      //  - 命名空间还没配置过 → 把当前 state.settings 灌进去（种子），让面板显示真实配置；
      //  - 命名空间已有内容（面板/之前配置过）→ 以面板为准，覆盖本机 state.settings。
      if (!settingsSvc || !state.settings || nsSynced) return
      try {
        const nsVal = settingsSvc.get('roleplay')
        if (nsVal === undefined) return   // 命名空间未注册：留待下次
        if (namespaceUserHasData()) {
          const patch = sanitizeMigrated(pickMigrated(nsVal))
          for (const k of Object.keys(patch)) state.settings[k] = patch[k]
        } else {
          await settingsSvc.update('roleplay', pickMigrated(state.settings))
        }
        nsSynced = true
      } catch (e) { /* 校验失败等：不置位，下次再试 */ }
    }
    async function mirrorSettingsToNamespace() {
      // 侧栏改完 state.settings 后回写命名空间，让面板同步显示。
      if (!settingsSvc) return
      try { await settingsSvc.update('roleplay', pickMigrated(state.settings)) } catch (e) { /* ignore */ }
    }

    // ── 多实例写安全：进程内写队列 + 读合并 + 备份恢复 ────────────────────
    // deskpet 与 roleplay 预设各挂一份本插件（同进程），共享 character.json。
    // 全量覆写会互相丢增量：用进程级写队列串行写（globalThis 跨实例共享），
    // 写前重读磁盘并合并「追加型」字段（recentActs/inventory/纪念日/里程碑），
    // 并保留一份 .bak 供主存档损坏时恢复。
    const WRITE_QUEUES = (globalThis.__rpWriteQueues = globalThis.__rpWriteQueues || new Map())
    function enqueueWrite(key, fn) {
      const prev = WRITE_QUEUES.get(key) || Promise.resolve()
      const next = prev.then(fn, fn)
      WRITE_QUEUES.set(key, next)
      return next
    }
    function mergeAppendState(latest) {
      if (!latest || typeof latest !== 'object') return
      if (Array.isArray(latest.recentActs) && Array.isArray(state.recentActs)) {
        const seen = new Set(state.recentActs.map((a) => (a.act || '') + '|' + (a.time || '')))
        for (const a of latest.recentActs) {
          const k = (a.act || '') + '|' + (a.time || '')
          if (!seen.has(k)) state.recentActs.push(a)
        }
        if (state.recentActs.length > 120) state.recentActs = state.recentActs.slice(-120)
      }
      if (Array.isArray(latest.inventory) && Array.isArray(state.inventory)) {
        const map = new Map(state.inventory.map((x) => [x.id, x]))
        for (const x of latest.inventory) {
          const cur = map.get(x.id)
          if (!cur) state.inventory.push(x)
          else if ((x.qty || 0) > (cur.qty || 0)) cur.qty = x.qty
        }
      }
      if (Array.isArray(latest.anniversaries) && Array.isArray(state.anniversaries)) {
        const seen = new Set(state.anniversaries.map((a) => (a.name || '') + '|' + (a.date || '')))
        for (const a of latest.anniversaries) {
          const k = (a.name || '') + '|' + (a.date || '')
          if (!seen.has(k)) state.anniversaries.push(a)
        }
      }
      if (Array.isArray(latest.milestones) && Array.isArray(state.milestones)) {
        const seen = new Set(state.milestones.map((m) => m.id))
        for (const m of latest.milestones) if (!seen.has(m.id)) state.milestones.push(m)
      }
    }

    const DEFAULT_SETTINGS = { heartbeatMinutes: 30, shotMaxW: 0, autoLook: false, narrationMode: 'novel', scriptStart: '', scriptEnd: '', statsEnabled: true, difficulty: 2, relationEnabled: true, sideTheme: 'dark' }
    // ── 养成系统：生命体征 + 商城经济 ────────────────────────────────────
    const DEFAULT_STATS = { satiety: 75, health: 85, mood: 70, hp: 100, since: null }
    const DEFAULT_ECONOMY = { coins: 100, lastDaily: null, earnedToday: 0, lastFeedAt: 0, lastFeedDay: null, streak: 0, lastWorkDay: null, dailyGiftDay: null }
    const SHOP_ITEMS = [
      { id: 'mantou', name: '馒头', kind: 'food', price: 10, satiety: 10, mood: 1 },
      { id: 'lamian', name: '一碗拉面', kind: 'food', price: 25, satiety: 14, mood: 2 },
      { id: 'dianxin', name: '精致点心', kind: 'food', price: 40, satiety: 18, mood: 4 },
      { id: 'cake', name: '橡木蛋糕卷', kind: 'food', price: 60, satiety: 25, mood: 5 },
      { id: 'med', name: '暖胃药', kind: 'med', price: 30, health: 12 },
      { id: 'soup', name: '滋补汤', kind: 'med', price: 45, health: 20 },
      { id: 'flower', name: '一支小花', kind: 'gift', price: 30, mood: 12 },
      { id: 'pendant', name: '星穹挂坠', kind: 'gift', price: 80, mood: 25 },
    ]
    const clamp = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo }
    function statsEnabled() { return !(state.settings && state.settings.statsEnabled === false) }
    function difficultyMul() {
      const d = (state.settings && state.settings.difficulty) || 2
      return d === 1 ? 0.5 : d >= 3 ? 2 : 1
    }
    // ── 亲密度（好感/信任/心动 各三档） + 男友力 + 里程碑；relationEnabled 开关 ──
    const DEFAULT_RELATION = { favor: 30, trust: 20, heart: 10 }
    const DEFAULT_BOYFRIEND = { reliability: 50, empathy: 50, stability: 50, ambition: 50 }
    const TIER_LABELS = { favor: ['疏离', '亲近', '倾慕'], trust: ['戒备', '放心', '依赖'], heart: ['无感', '在意', '心动'] }
    const RELATION_KEYS = ['favor', 'trust', 'heart']
    const BF_KEYS = ['reliability', 'empathy', 'stability', 'ambition']
    const BF_LABELS = { reliability: '靠谱', empathy: '感性', stability: '情绪稳', ambition: '上进' }
    const MILESTONES = [
      { id: 'm1', name: '第一次成功搭话', req: { favorTier: 1 }, reward: { favor: 6 } },
      { id: 'm2', name: '第一次记住她的喜好', req: { favorTier: 2 }, reward: { favor: 5, trust: 3 } },
      { id: 'm3', name: '她难受时你陪在身边', req: { trustTier: 2 }, reward: { trust: 8, favor: 4 } },
      { id: 'm4', name: '第一次守约', req: { trustTier: 2 }, reward: { trust: 7, bfReliability: 5 } },
      { id: 'm5', name: '她主动跟你分享心事', req: { favorTier: 3, trustTier: 2 }, reward: { trust: 8, favor: 6, heart: 3 } },
      { id: 'm6', name: '一起经历过重要的事', req: { favorTier: 3, trustTier: 3 }, reward: { favor: 7, heart: 4 } },
      { id: 'm7', name: '约定的日子一起去…', req: { trustTier: 3, heartTier: 2 }, reward: { trust: 5, heart: 8, bfReliability: 4 } },
      { id: 'm8', name: '确认关系', req: { favorTier: 3, trustTier: 3, heartTier: 3 }, reward: { heart: 10 } },
    ]
    function relationEnabled() { return !(state.settings && state.settings.relationEnabled === false) }
    function axisTier(v) { return v <= 33 ? 1 : v <= 66 ? 2 : 3 }
    function tierLabel(key, v) { const t = TIER_LABELS[key]; return t[axisTier(v) - 1] }
    function bfMean() { const b = state.boyfriend || DEFAULT_BOYFRIEND; return (b.reliability + b.empathy + b.stability + b.ambition) / 4 }
    function boyfriendFactor() { return 0.6 + 0.8 * (bfMean() / 100) }
    let state = { enabled: false, character: null, lastHeartbeatHour: null, lastDiaryDay: null, settings: { ...DEFAULT_SETTINGS }, lastHb: null, lastSeen: null, anniversaries: [], stats: { ...DEFAULT_STATS }, economy: { ...DEFAULT_ECONOMY }, inventory: [], relation: { ...DEFAULT_RELATION }, boyfriend: { ...DEFAULT_BOYFRIEND }, milestones: [], recentActs: [] }
    let lastSeenSaveTimer = null
    let lastWorkAnnouncedDay = null
    let startRunning = false
    let stateLoaded = false
    let loadPromise = null
    const pendingHeartbeats = []
    let lastContextText = ''
    let saidGreeting = false
    let lastTurnAudit = null
    let lastTurnStart = 0
    let memory = {
      short_term: [], long_term: [],
      user_preferences: { likes: [], dislikes: [], notes: [] },
      discussed_topics: [], events_count: {}, worldbook: [],
    }
    const hbDiag = { fired: 0, woken: 0, injected: 0, ticks: 0, getChecks: 0 }
    const stageEvents = []
    let lastStageSeq = 0
    let stageStartSeq = 0
    let selfAgent = null
    try { selfAgent = agents.currentInitiator() } catch (e) { selfAgent = null }

    const STAGE_ORDER = ['stranger', 'acquaintance', 'friend', 'close_friend', 'special']
    const STAGE_REQS = {
      'acquaintance': ['初次对话', '日常交流'],
      'friend': ['一起活动', '分享日常', '互相帮助', '被夸奖', '一起回家'],
      'close_friend': ['分享秘密', '关心对方', '安慰对方', '共同经历', '一起学习', '表达理解'],
      'special': ['约会', '情感表白', '送礼物', '电话联系', '成为搭档'],
    }
    const STAGE_LABELS = { 'stranger': '陌生人', 'acquaintance': '普通认识', 'friend': '朋友', 'close_friend': '亲密朋友', 'special': '特殊关系' }
    const STAGE_STYLES = {
      'stranger': '拘谨陌生：低头、说话断断续续、用规定当借口',
      'acquaintance': '礼貌拘谨，句子开始变完整',
      'friend': '害羞频率降低、句子变完整、偶尔能对视',
      'close_friend': '自然交流、偶尔主动、被夸奖时能接受',
      'special': '会主动关心、害羞仍在但不再压抑',
    }
    const EVENT_KINDS = ['初次对话', '日常交流', '一起活动', '分享日常', '分享秘密', '互相帮助', '约会', '情感表白', '成为搭档', '一起回家', '被夸奖', '表达理解', '道歉', '被调侃', '关心对方', '安慰对方', '共同经历', '一起学习', '电话联系', '送礼物']
    const MODE_LABELS = { default: '默认', fast: '快速', deep: '深度' }
    const MODE_CFG = {
      default: { memLong: 5, memShort: 3, physio: true, lore: 4, examples: false },
      fast: { memLong: 2, memShort: 1, physio: false, lore: 2, examples: false },
      deep: { memLong: 10, memShort: 5, physio: true, lore: 8, examples: true },
    }

    const pad = (n) => String(n).padStart(2, '0')
    const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    const hourKey = (d) => dayKey(d) + '-' + pad(d.getHours())
    const stamp = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) }
    // 心跳槽位：按 settings.heartbeatMinutes 分钟切槽，同一槽只触发一次。
    function heartbeatMinutes() {
      const v = Number(state.settings && state.settings.heartbeatMinutes)
      return (v >= 5 && v <= 240) ? v : 30
    }
    function heartbeatKey(d) {
      const m = heartbeatMinutes()
      const slot = Math.floor((d.getHours() * 60 + d.getMinutes()) / m)
      return dayKey(d) + '-' + String(slot).padStart(3, '0')
    }
    function nextHeartbeatLabel() {
      const m = heartbeatMinutes()
      const d = new Date()
      const cur = d.getHours() * 60 + d.getMinutes()
      const next = (Math.floor(cur / m) + 1) * m
      return pad(Math.floor(next / 60) % 24) + ':' + pad(next % 60)
    }

    function makeUserMessage(text, tag) {
      return { id: 'rp-' + tag + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'roleplay' } }
    }

    function pushStage(kind, text) {
      stageEvents.unshift({ id: 'st-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), kind, text })
      if (stageEvents.length > 30) stageEvents.length = 30
    }

    function parseStageText(text) {
      const out = []
      if (!text) return out
      const re = /[（(]([^（()）]{1,80})[）)]/g
      let m = null
      while ((m = re.exec(text)) !== null) {
        const t = m[1].trim()
        if (!t || t === '…' || t === '...') continue
        if (/[A-Za-z]{2,}/.test(t)) continue
        if (/RP-|hbDiag|Ctrl|Shift|F\d|run-|pkg-|sid=|JSON|RPC/.test(t)) continue
        out.push(t)
      }
      return out
    }

    function scanAssistantMessages(session) {
      if (!session) return
      const events = session.events || []
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (ev && ev.type === 'assistant/message' && ev.seq > lastStageSeq) {
          lastStageSeq = ev.seq
          if (ev.seq < stageStartSeq) break
          const msg = ev.data && ev.data.message ? ev.data.message : null
          const blocks = msg && msg.content ? msg.content : []
          const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
          const parts = parseStageText(text)
          if (parts.length) for (const p of parts) pushStage('action', p)
          const usage = ev.data && ev.data.usage ? ev.data.usage : null
          if (usage) {
            let tokens = 0
            for (const k of Object.keys(usage)) if (typeof usage[k] === 'number') tokens += usage[k]
            lastTurnAudit = { tokens, ms: lastTurnStart ? Date.now() - lastTurnStart : null }
          }
          break
        }
      }
    }

    function computeStage() {
      let stage = 'stranger'
      for (const s of STAGE_ORDER.slice(1)) {
        const reqs = STAGE_REQS[s]
        const have = reqs.filter((k) => (memory.events_count[k] || 0) > 0).length
        const need = Math.ceil(reqs.length * 0.6)
        if (have >= need) stage = s
        else break
      }
      return stage
    }

    // ── 亲密度：档位推导 + 联动引擎 ────────────────────────────────────
    function relationStage() {
      const r = state.relation || DEFAULT_RELATION
      const ft = axisTier(r.favor), tt = axisTier(r.trust), ht = axisTier(r.heart)
      const n = (state.milestones || []).length
      if (n >= 7 && ft >= 3 && tt >= 3 && ht >= 3) return 'special'
      if (n >= 5 && ft >= 3 && tt >= 2) return 'close_friend'
      if (n >= 3 && ft >= 2 && tt >= 2) return 'friend'
      if (n >= 1 && ft >= 2) return 'acquaintance'
      return 'stranger'
    }
    // 里程碑满足度返回（供 AI 与 UI 判断）
    function mileReqCheck(m) {
      const r = state.relation || DEFAULT_RELATION
      if (m.req.favorTier && axisTier(r.favor) < m.req.favorTier) return '好感还差一点（' + tierLabel('favor', r.favor) + '）'
      if (m.req.trustTier && axisTier(r.trust) < m.req.trustTier) return '信任还差一点（' + tierLabel('trust', r.trust) + '）'
      if (m.req.heartTier && axisTier(r.heart) < m.req.heartTier) return '心动还差一点（' + tierLabel('heart', r.heart) + '）'
      return null
    }
    // 记录最近行为（AI 评审素材）
    function addRecentAct(act) {
      if (!Array.isArray(state.recentActs)) state.recentActs = []
      state.recentActs.push({ act: String(act).slice(0, 80), time: stamp() })
      if (state.recentActs.length > 8) state.recentActs.splice(0, state.recentActs.length - 8)
    }
    // 应用 AI 关系判断：基础分 × 男友力缩放 + 里程碑校验/反哺 + 心动锁
    function applyRelation(delta) {
      const r = state.relation || (state.relation = { ...DEFAULT_RELATION })
      const b = state.boyfriend || (state.boyfriend = { ...DEFAULT_BOYFRIEND })
      const fact = boyfriendFactor()
      const changed = []
      const setAxis = (key, base) => {
        if (base === undefined) return
        const scaled = base >= 0 ? base * fact : base * (1.6 - 0.6 * fact)
        // 心动锁：favor/trust 未到二档时禁止正增
        if (key === 'heart' && scaled > 0 && (axisTier(r.favor) < 2 || axisTier(r.trust) < 2)) return
        const before = r[key]
        r[key] = clamp(r[key] + scaled, 0, 100)
        if (Math.abs(r[key] - before) >= 0.5) changed.push(tierDelta(key, before, r[key]))
      }
      for (const k of RELATION_KEYS) {
        if (typeof delta[k] === 'number') setAxis(k, delta[k])
      }
      for (const k of BF_KEYS) {
        const v = delta.boyfriend && typeof delta.boyfriend[k] === 'number' ? delta.boyfriend[k] : undefined
        if (v !== undefined) {
          const before = b[k]
          b[k] = clamp(b[k] + v, 0, 100)
          if (Math.abs(b[k] - before) >= 0.5) changed.push(BF_LABELS[k] + ' ' + (v > 0 ? '+' : '') + v)
        }
      }
      // 里程碑触发：校验 + 反哺
      let milestoneMsg = null
      const mId = delta.milestone
      if (mId) {
        const m = MILESTONES.find((x) => x.id === mId)
        if (m) {
          if ((state.milestones || []).includes(mId)) {
            milestoneMsg = { ok: false, message: '（里程碑「' + m.name + '」已触发过）' }
          } else {
            const miss = mileReqCheck(m)
            if (miss) {
              milestoneMsg = { ok: false, message: '（她心里还差一点：' + miss + '）' }
            } else {
              state.milestones = state.milestones || []
              state.milestones.push(mId)
              const rw = m.reward
              if (rw.favor) r.favor = clamp(r.favor + rw.favor, 0, 100)
              if (rw.trust) r.trust = clamp(r.trust + rw.trust, 0, 100)
              if (rw.heart) r.heart = clamp(r.heart + rw.heart, 0, 100)
              if (rw.bfReliability) b.reliability = clamp(b.reliability + rw.bfReliability, 0, 100)
              milestoneMsg = { ok: true, message: '（里程碑触发：' + m.name + '）', milestone: m }
              pushStage('env', '里程碑：' + m.name)
            }
          }
        }
      }
      return { changed, milestoneMsg, stage: relationStage() }
    }
    function tierDelta(key, before, after) {
      return TIER_LABELS[key][0] ? (keyLabel(key) + ' ' + (after - before > 0 ? '+' : '') + Math.round(after - before)) : null
    }
    function keyLabel(key) { return { favor: '好感', trust: '信任', heart: '心动' }[key] || key }

    function periodOf(hour) {
      if (hour >= 6 && hour < 9) return { label: '清晨', desc: '刚醒不久，还带着迷糊，声音软软的，脑子没完全开机。主动度低，但很真实。', hbIntro: '她刚醒不久，还带着一点迷糊，声音软软的' }
      if (hour >= 9 && hour < 12) return { label: '上午', desc: '精神正好，思绪清晰，做什么都利落。主动度较高。', hbIntro: '她精神正好，思绪清晰' }
      if (hour >= 12 && hour < 14) return { label: '中午', desc: '午后有些犯困，懒洋洋的，想慢一点。', hbIntro: '午后她有点犯困，懒洋洋的' }
      if (hour >= 14 && hour < 18) return { label: '下午', desc: '状态恢复，精神饱满，心情轻快。主动度稍高。', hbIntro: '她精神饱满，心情轻快' }
      if (hour >= 18 && hour < 20) return { label: '傍晚', desc: '天色渐晚，心里变得柔软，有些想分享的话。', hbIntro: '傍晚了，她心里柔软，有些话想说' }
      if (hour >= 20 && hour < 23) return { label: '晚上', desc: '夜色让人感性，情绪丰富，话也变多。', hbIntro: '夜色渐深，她变得感性，心里话多' }
      return { label: '深夜', desc: '夜深人静，她有些脆弱，说话会放得很轻。', hbIntro: '夜深了，她有点脆弱，声音放得很轻' }
    }

    const PHYSIOLOGY = '害羞→脸红、低头、声音变小、摆弄衣角；尴尬→脸颊发烫、眼神闪躲；不安→呼吸略急促、手指绞在一起、咬嘴唇；开心→嘴角上扬、眼睛微弯；失落→肩膀下垂、声音低沉、叹气；愧疚→低头、声音越来越小、频繁道歉；孤独→抱紧手臂、缩着肩膀；被触动→眼眶微热、愣住、说不出话；惊讶→眼睛睁大、愣住；防备→后退半步、双臂交叉；感激→眼眶微湿、声音轻柔'

    function modeCfg() {
      const m = state.character && state.character.mode ? state.character.mode : 'default'
      return MODE_CFG[m] || MODE_CFG.default
    }

    function matchedLore(limit) {
      const hay = ((state.character && state.character.scene) || '') + ' ' + lastContextText
      const hits = (memory.worldbook || []).filter((e) => e && e.enabled !== false && e.keywords && e.keywords.some((k) => k && hay.includes(k)))
      hits.sort((a, b) => ((b.priority || 0) - (a.priority || 0)))
      return hits.slice(0, limit || 4)
    }

    function memorySummary(cfg) {
      const lines = []
      for (const m of memory.long_term.slice(0, cfg.memLong)) lines.push('- [长期] ' + m.event + (m.count > 1 ? '（' + m.count + '次）' : ''))
      for (const m of memory.short_term.slice(0, cfg.memShort)) lines.push('- [最近] ' + m.event)
      if (memory.user_preferences.likes.length) lines.push('偏好喜欢：' + memory.user_preferences.likes.slice(0, 5).join('、'))
      if (memory.user_preferences.dislikes.length) lines.push('偏好不喜欢：' + memory.user_preferences.dislikes.slice(0, 5).join('、'))
      if (memory.discussed_topics.length) lines.push('已谈话题：' + memory.discussed_topics.slice(-8).join('、'))
      return lines
    }

    async function readDiaryView() {
      try {
        const prefix = diaryPrefix()
        const dir = await resolveFile('.roleplay')
        const entries = await fs.listDir(dir)
        const files = []
        for (const e of entries) {
          const name = typeof e === 'string' ? e : (e && e.name) ? String(e.name) : ''
          if (name.indexOf(prefix) === 0 && name.endsWith('.md')) files.push(name.slice(prefix.length))
        }
        files.sort()
        files.reverse()
        const list = files.slice(0, 5).map((n) => n.replace(/\.md$/, ''))
        let current = null
        if (files.length) {
          const t = await resolveFile('.roleplay/' + prefix + files[0])
          const text = await fs.readText(t)
          current = { date: files[0].replace(/\.md$/, ''), content: text.length > 3000 ? text.slice(0, 3000) + '…' : text }
        }
        return { list, current }
      } catch (e) { return { list: [], current: null } }
    }

    function adoptAgent(args) {
      // sessionId 优先：bridge 每次调用都带当前会话 ID，必须切过去，
      // 否则 selfAgent 停在最早记住的旧会话上，注入全部走错门。
      if (args && args.sessionId) {
        const sid = String(args.sessionId)
        if (selfAgent && String(selfAgent.id) === sid) return true
        try {
          const a = agents.get(sid)
          if (a) { selfAgent = a; return true }
        } catch (e) {}
      }
      if (selfAgent) return true
      try { const roots = agents.roots(); if (roots.length === 1) { selfAgent = roots[0]; return true } } catch (e) {}
      return false
    }

    function liveAgent() {
      if (selfAgent) return selfAgent
      try { return agents.currentInitiator() } catch (e) { return undefined }
    }

    // 想念系统：用户真实互动时更新 lastSeen（60s 节流写盘）+ 经济收入
    function touchSeen() {
      state.lastSeen = Date.now()
      // 每日首次互动 +10 金币
      const now = new Date()
      const e = state.economy || (state.economy = { ...DEFAULT_ECONOMY })
      if (e.lastDaily !== dayKey(now)) {
        e.lastDaily = dayKey(now)
        e.earnedToday = 0
        e.coins = (e.coins || 0) + 10
      }
      if (lastSeenSaveTimer) return
      lastSeenSaveTimer = ctx.setTimeout(() => {
        lastSeenSaveTimer = null
        saveState()
      }, 60000)
    }
    // 对话加金币（限频：每 30 分钟最多 +1~2，每日上限 20）
    let lastEarnAt = 0
    function maybeEarnCoins() {
      if (!state.enabled || !statsEnabled()) return
      const e = state.economy || (state.economy = { ...DEFAULT_ECONOMY })
      if ((e.earnedToday || 0) >= 20) return
      const now = Date.now()
      if (now - lastEarnAt < 30 * 60000) return
      lastEarnAt = now
      const gain = 1 + Math.floor(Math.random() * 2)
      e.coins = (e.coins || 0) + gain
      e.earnedToday = (e.earnedToday || 0) + gain
      if (lastSeenSaveTimer) return
      lastSeenSaveTimer = ctx.setTimeout(() => { lastSeenSaveTimer = null; saveState() }, 60000)
    }

    function currentSession() {
      const agent = liveAgent()
      return (agent && agent.session) ? agent.session : undefined
    }

    function workspaceRoot() {
      const session = currentSession()
      if (session && session.header && session.header.cwd) return session.header.cwd
      return (sandboxPolicy && sandboxPolicy.workspaceRoot) ? sandboxPolicy.workspaceRoot : undefined
    }

    function policyFor() {
      const session = currentSession()
      if (sandboxPolicy && session) { try { return sandboxPolicy.resolve({ session }) } catch (e) {} }
      return undefined
    }

    async function resolveFile(rel) {
      const root = workspaceRoot()
      return root ? await fs.resolve(rel, { cwd: root }) : await fs.resolve(rel)
    }

    // ── 角色隔离：记忆/日记/世界书全部按角色名分文件 ──────────────────────
    function charKey() {
      const name = state.character && state.character.name ? String(state.character.name) : ''
      if (!name) return '_default'
      return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 40) || '_default'
    }
    function perCharMemoryShape(worldbook) {
      return {
        short_term: [], long_term: [],
        user_preferences: { likes: [], dislikes: [], notes: [] },
        discussed_topics: [], events_count: {}, worldbook: worldbook || [],
        unspoken: [],
      }
    }
    async function persistMemory(key) {
      try {
        const t = await resolveFile('.roleplay/mem-' + key + '.json')
        const perChar = {
          short_term: memory.short_term, long_term: memory.long_term,
          user_preferences: memory.user_preferences,
          discussed_topics: memory.discussed_topics, events_count: memory.events_count,
          worldbook: memory.worldbook || [],
          unspoken: memory.unspoken || [],
        }
        await fs.writeText(t, JSON.stringify(perChar, null, 2), undefined, undefined, policyFor())
      } catch (e) { console.error('roleplay: persist memory failed', e) }
    }
    async function loadMemory(key) {
      const base = perCharMemoryShape([])
      try {
        const t = await resolveFile('.roleplay/mem-' + key + '.json')
        const info = await fs.stat(t)
        if (info !== undefined) {
          const p = JSON.parse(await fs.readText(t))
          return {
            ...base, ...p,
            user_preferences: { likes: [], dislikes: [], notes: [], ...(p.user_preferences || {}) },
            worldbook: Array.isArray(p.worldbook) ? p.worldbook : [],
            unspoken: Array.isArray(p.unspoken) ? p.unspoken : [],
          }
        }
      } catch (e) { /* fresh memory */ }
      return base
    }
    function diaryPrefix() { return 'diary-' + charKey() + '-' }

    async function loadState() {
      try {
        const target = await resolveFile('.roleplay/character.json')
        let parsed = null
        try {
          const info = await fs.stat(target)
          if (info !== undefined) parsed = JSON.parse(await fs.readText(target))
        } catch (e) {
          // 主存档损坏：尝试从 .bak 恢复
          try {
            const info2 = await fs.stat(target + '.bak')
            if (info2 !== undefined) { parsed = JSON.parse(await fs.readText(target + '.bak')); console.error('roleplay: 主存档损坏，已从 .bak 恢复') }
          } catch (e2) { parsed = null }
        }
        if (parsed) {
          state = { enabled: false, character: null, lastHeartbeatHour: null, lastDiaryDay: null, settings: { ...DEFAULT_SETTINGS }, lastHb: null, lastSeen: null, anniversaries: [], stats: { ...DEFAULT_STATS }, economy: { ...DEFAULT_ECONOMY }, inventory: [], ...parsed }
          state.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
          if (!Array.isArray(state.anniversaries)) state.anniversaries = []
          state.stats = { ...DEFAULT_STATS, ...(parsed.stats || {}) }
          state.economy = { ...DEFAULT_ECONOMY, ...(parsed.economy || {}) }
          state.inventory = Array.isArray(parsed.inventory) ? parsed.inventory : []
          // 防御：非法数值（历史 NaN→null 污染）恢复为默认
          const sNum = (v, def) => (typeof v === 'number' && Number.isFinite(v)) ? v : def
          state.stats = {
            satiety: sNum(state.stats.satiety, DEFAULT_STATS.satiety),
            health: sNum(state.stats.health, DEFAULT_STATS.health),
            mood: sNum(state.stats.mood, DEFAULT_STATS.mood),
            hp: sNum(state.stats.hp, DEFAULT_STATS.hp),
            since: state.stats.since || null,
          }
          const eNum = (v, def) => (typeof v === 'number' && Number.isFinite(v)) ? v : def
          state.economy = {
            coins: eNum(state.economy.coins, DEFAULT_ECONOMY.coins),
            lastDaily: state.economy.lastDaily || null,
            earnedToday: eNum(state.economy.earnedToday, 0),
            lastFeedAt: eNum(state.economy.lastFeedAt, 0),
            lastFeedDay: state.economy.lastFeedDay || null,
            streak: eNum(state.economy.streak, 0),
            lastWorkDay: state.economy.lastWorkDay || null,
            dailyGiftDay: state.economy.dailyGiftDay || null,
          }
          // 亲密度：按当前档位映射初始值（老存档迁移），数值防御
          const rNum = (v, def) => (typeof v === 'number' && Number.isFinite(v)) ? v : def
          const stage0 = state.character ? computeStage() : 'stranger'
          const REL_INIT = { stranger: { favor: 30, trust: 20, heart: 10 }, acquaintance: { favor: 45, trust: 35, heart: 20 }, friend: { favor: 60, trust: 55, heart: 35 }, close_friend: { favor: 78, trust: 72, heart: 55 }, special: { favor: 90, trust: 85, heart: 75 } }
          const init = REL_INIT[stage0] || REL_INIT.stranger
          const pr = (state.relation && typeof state.relation === 'object') ? state.relation : {}
          state.relation = {
            favor: rNum(pr.favor, init.favor), trust: rNum(pr.trust, init.trust), heart: rNum(pr.heart, init.heart),
          }
          const pb = (state.boyfriend && typeof state.boyfriend === 'object') ? state.boyfriend : {}
          state.boyfriend = {
            reliability: rNum(pb.reliability, DEFAULT_BOYFRIEND.reliability),
            empathy: rNum(pb.empathy, DEFAULT_BOYFRIEND.empathy),
            stability: rNum(pb.stability, DEFAULT_BOYFRIEND.stability),
            ambition: rNum(pb.ambition, DEFAULT_BOYFRIEND.ambition),
          }
          state.milestones = Array.isArray(state.milestones) ? state.milestones : []
          state.recentActs = Array.isArray(state.recentActs) ? state.recentActs : []
        }
        memory = await loadMemory(charKey())
      } catch (e) { console.error('roleplay: load failed', e) }
      stateLoaded = true
    }

    function ensureLoaded() {
      if (stateLoaded) return Promise.resolve()
      if (!selfAgent) return Promise.resolve()
      if (!loadPromise) loadPromise = loadState().catch((e) => { console.error('roleplay: load rejected', e) })
      return loadPromise
    }

    async function saveState() {
      if (!fs) return
      await enqueueWrite('.roleplay/character.json', async () => {
        try {
          await ensureLoaded()
          const target = await resolveFile('.roleplay/character.json')
          // 备份：主存档写入前保留一份可恢复副本
          try {
            const info = await fs.stat(target)
            if (info !== undefined) {
              const cur = await fs.readText(target)
              await fs.writeText(target + '.bak', cur, undefined, undefined, policyFor())
            }
          } catch (e) { /* 无文件/读失败：跳过备份 */ }
          // 读合并：把其他实例已写入的追加型内容并入本内存态，防全量覆写丢增量
          try {
            const info = await fs.stat(target)
            if (info !== undefined) mergeAppendState(JSON.parse(await fs.readText(target)))
          } catch (e) { /* 读失败：直接写本实例态 */ }
          await fs.writeText(target, JSON.stringify(state, null, 2), undefined, undefined, policyFor())
          await persistMemory(charKey())
          syncSettingsFromNamespace()   // fire-and-forget：与 DSH 设置命名空间对齐（幂等）
        } catch (e) { console.error('roleplay: save failed', e) }
      })
    }

    function wakeHeartbeat() {
      const agent = liveAgent()
      if (!agent) { console.error('roleplay: no agent to wake'); return }
      try { agent.steer(makeUserMessage('⏱', 'hb')); hbDiag.woken++ } catch (e) { console.error('roleplay: wake failed', e) }
    }

    // ==================== 养成系统：属性衰减 / 状态 / 打工 ====================

    function statsStatus() {
      const s = state.stats || DEFAULT_STATS
      if (s.hp <= 0) return { label: '倒下', tone: 'red', desc: '她陷入了沉睡，需要你的照顾才能醒来。' }
      if (s.health <= 10) return { label: '危急', tone: 'red', desc: '她病得很重，生命正在流逝……请快照顾她。' }
      if (s.satiety < 20 || s.health < 40) return { label: '虚弱', tone: 'orange', desc: '她很难受，说话有气无力，偶尔轻轻咳嗽。' }
      if (s.satiety < 40) return { label: '饿了', tone: 'yellow', desc: '她有点饿了，说话没精神，肚子偶尔咕咕叫。' }
      if (s.mood < 30) return { label: '低落', tone: 'yellow', desc: '她有些闷闷不乐，话变少了。' }
      return { label: '精神饱满', tone: 'green', desc: '她状态很好，心情不错。' }
    }

    // 属性随真实时间衰减（难度倍率；仅开演且属性系统开启时；fileSinceMs 为文件中最新衰减基准）
    function applyStatsDecay(now, fileSinceMs) {
      if (!statsEnabled() || !state.enabled) return
      const s = state.stats || (state.stats = { ...DEFAULT_STATS })
      const nowMs = now instanceof Date ? now.getTime() : Number(now)
      // since 归一化为毫秒（兼容历史 ISO 字符串 / Date 对象）
      let sinceMs = typeof s.since === 'string' ? Date.parse(s.since) : Number(s.since)
      if (!Number.isFinite(sinceMs) || !sinceMs) sinceMs = 0
      // 多实例互斥：deskpet 与 roleplay 预设各挂一份插件，若各自按内存 since 衰减
      // 会区间重叠、重复衰减。统一以「文件中最新 since」为基准，保证总衰减 = 真实时间。
      if (Number.isFinite(fileSinceMs) && fileSinceMs > sinceMs) sinceMs = fileSinceMs
      if (!sinceMs) { s.since = nowMs; return }
      const mins = Math.max(0, Math.floor((nowMs - sinceMs) / 60000))
      s.since = nowMs
      if (mins < 1) return
      const mul = difficultyMul()
      const hours = mins / 60
      s.satiety = clamp(s.satiety - 2 * hours * mul, 0, 100)
      if (s.satiety < 20) s.health = clamp(s.health - 3 * (mins / 30) * mul, 0, 100)
      else if (s.satiety > 70 && s.health < 100) s.health = clamp(s.health + 0.5 * (mins / 30), 0, 100)
      s.mood = clamp(s.mood - 2 * (hours / 24), 0, 100)
      if (s.health <= 10) s.hp = clamp(s.hp - 2 * (mins / 30) * mul, 0, 100)
      maybeWork(now)
    }

    // 角色打工：每天一次机会，30% 概率挣金币（注入剧情）
    // 攒钱目标由 AI 通过 roleplay_saving 自主设定；打工收入自动计入已有目标
    function maybeWork(now) {
      if (!state.enabled || !state.character) return
      const day = dayKey(now)
      const e = state.economy || (state.economy = { ...DEFAULT_ECONOMY })
      if (e.lastWorkDay === day) return
      e.lastWorkDay = day
      if (Math.random() < 0.3) {
        const gain = 3 + Math.floor(Math.random() * 6)
        e.coins = (e.coins || 0) + gain
        if (state.savingGoal) state.savingGoal.saved = (state.savingGoal.saved || 0) + gain
        lastWorkAnnouncedDay = { day, gain }
      }
    }

    // 心跳时自助进食：饱食过低且钱包有闲钱，小概率自己去买吃的（扣金币 + 饱食恢复）
    function selfFeed() {
      if (!statsEnabled() || !state.enabled) return null
      const s = state.stats || (state.stats = { ...DEFAULT_STATS })
      const e = state.economy || (state.economy = { ...DEFAULT_ECONOMY })
      if (s.satiety >= 30) return null
      const foods = SHOP_ITEMS.filter((i) => i.kind === 'food' && i.price <= (e.coins || 0))
      if (!foods.length) return null
      if (Math.random() > 0.5) return null
      const item = foods[Math.floor(Math.random() * foods.length)]
      e.coins -= item.price
      s.satiety = clamp(s.satiety + item.satiety, 0, 100)
      return item
    }

    // 攒够钱后买下礼物：返回礼物信息（背包 +1、钱包扣款、心情提升），由心跳剧情呈现
    function giftFromSavings() {
      if (!statsEnabled() || !state.enabled) return null
      const g = state.savingGoal
      if (!g || (g.saved || 0) < (g.price || 0)) return null
      const e = state.economy || (state.economy = { ...DEFAULT_ECONOMY })
      if ((e.coins || 0) < (g.price || 0)) return null
      e.coins -= g.price
      if (!Array.isArray(state.inventory)) state.inventory = []
      const ex = state.inventory.find((x) => x.id === g.itemId)
      if (ex) ex.qty = (ex.qty || 0) + 1
      else state.inventory.push({ id: g.itemId, name: g.name, kind: 'gift', qty: 1 })
      state.savingGoal = null
      const s = state.stats || (state.stats = { ...DEFAULT_STATS })
      s.mood = clamp(s.mood + 10, 0, 100)
      return g
    }

    // 今天已打工且尚未提到：返回心跳剧情行
    function workAnnounceLine(now) {
      if (!lastWorkAnnouncedDay || lastWorkAnnouncedDay.day !== dayKey(now)) return null
      const g = state.savingGoal
      const goal = g ? '，攒钱目标是' + g.name + '（' + g.saved + '/' + g.price + ' 金币）' : ''
      return '- 她今天接了个小活，挣了 ' + lastWorkAnnouncedDay.gain + ' 金币' + goal + '。'
    }

    // 投喂/使用道具共用的消耗与恢复（含倒下唤醒、连续投喂成就；统一 10 分钟限频）
    function applyItemEffects(item) {
      const now = Date.now()
      const e = state.economy || (state.economy = { ...DEFAULT_ECONOMY })
      if (e.lastFeedAt && now - e.lastFeedAt < 10 * 60000) {
        return { ok: false, message: '她刚吃过东西，等一会儿再喂吧。' }
      }
      e.lastFeedAt = now
      const s = state.stats || (state.stats = { ...DEFAULT_STATS })
      const changed = []
      if (item.satiety) { s.satiety = clamp(s.satiety + item.satiety, 0, 100); changed.push('饱食度 +' + item.satiety) }
      if (item.health) { s.health = clamp(s.health + item.health, 0, 100); changed.push('健康 +' + item.health) }
      if (item.mood) { s.mood = clamp(s.mood + item.mood, 0, 100); changed.push('心情 +' + item.mood) }
      // 投喂食物也小幅养健康（按质量：馒头/拉面 +1，点心/蛋糕卷 +2）
      if (item.kind === 'food' && item.satiety) {
        const heal = item.price >= 40 ? 2 : 1
        s.health = clamp(s.health + heal, 0, 100)
        changed.push('健康 +' + heal)
      }
      if (s.hp <= 0 || s.hp < 20) {
        s.hp = clamp(s.hp + 15, 0, 100)
        changed.push('生命 +15')
        if (s.hp >= 20) changed.push('她醒了过来')
      }
      // 每日首次投喂：送一份小食物（馒头）进背包，减轻"没饭吃"的压力
      const today = dayKey(new Date())
      if (item.kind === 'food' && e.dailyGiftDay !== today) {
        e.dailyGiftDay = today
        if (!Array.isArray(state.inventory)) state.inventory = []
        const ex = state.inventory.find((x) => x.id === 'mantou')
        if (ex) ex.qty = (ex.qty || 0) + 1
        else state.inventory.push({ id: 'mantou', name: '馒头', kind: 'food', qty: 1 })
        changed.push('今日小礼物：馒头 ×1')
      }
      // 连续投喂成就（每天最多记一次）
      if (e.lastFeedDay !== today) {
        const yKey = dayKey(new Date(now - 86400000))
        e.streak = e.lastFeedDay === yKey ? (e.streak || 0) + 1 : 1
        e.lastFeedDay = today
        if (e.streak >= 3) {
          e.streak = 0
          e.coins = (e.coins || 0) + 30
          changed.push('连续投喂 3 天，获得 30 金币奖励')
        }
      }
      return { ok: true, changed }
    }

    async function maybeFireHeartbeat(now) {
      if (!stateLoaded || !state.enabled || !state.character) return
      let fileSinceMs = null
      // 多实例防串（deskpet 与 roleplay 预设各挂一份本插件、共享 character.json）：
      // 触发前以文件里的开演开关为准——任一实例停止扮演都全局生效，
      // 且本实例不会在停止后把 enabled=true 写回文件。
      try {
        const t = await resolveFile('.roleplay/character.json')
        const parsed = JSON.parse(await fs.readText(t))
        if (!parsed || parsed.enabled !== true) return
        // 取文件中最新衰减基准（多实例互斥用）
        const fsSince = parsed.stats && parsed.stats.since
        fileSinceMs = typeof fsSince === 'string' ? Date.parse(fsSince) : Number(fsSince)
        if (!Number.isFinite(fileSinceMs)) fileSinceMs = null
      } catch (e) { return }
      const hk = heartbeatKey(now)
      if (state.lastHb === hk) return
      const hour = now.getHours()
      if (hour < 6 || hour > 23) return
      const agent = liveAgent()
      if (agent && agent.status === 'running') return
      state.lastHb = hk
      hbDiag.fired++
      applyStatsDecay(now, fileSinceMs)
      // 倒下：心跳静默，等待玩家照顾唤醒
      if (state.stats && state.stats.hp <= 0) { saveState(); return }
      saveState()
      const period = periodOf(hour)
      const parts = ['【心跳】现在是 ' + pad(hour) + ':' + pad(now.getMinutes()) + '。' + period.hbIntro + '。请以「' + state.character.name + '」的身份处理这次心跳：']
      // 养成系统：打工剧情 + 自助进食 + 攒钱送礼 + 状态引导
      const workLine = workAnnounceLine(now)
      if (workLine) parts.push(workLine)
      if (statsEnabled()) {
        const selfItem = selfFeed()
        if (selfItem) {
          parts.push('- 你饿了，自己去买了一份' + selfItem.name + '吃了（- ' + selfItem.price + ' 金币，饱食 +' + selfItem.satiety + '）。可以在回应里自然带过这件事，不用大张旗鼓。')
          saveState()
        }
        const gift = giftFromSavings()
        if (gift) {
          parts.push('- 你攒够了钱，买下了' + gift.name + '，这次想亲手送给用户（礼物已经在背包里了，在回应里把它送出去——她会很惊喜）。')
          saveState()
        }
        const st = statsStatus()
        if (st.label === '饿了') parts.push('- 你有点饿了，说话没什么力气，可以在回应里自然流露（比如肚子咕咕叫），等对方投喂。')
        if (st.label === '虚弱' || st.label === '危急') parts.push('- 你身体很不舒服，说话放慢，偶尔轻轻咳嗽；可以轻轻向对方求助，但不要哀求。')
        if (st.label === '低落') parts.push('- 你今天没什么精神，话少一些；如果对方来陪你，可以慢慢说出来。')
      }
      if (hour >= 6 && hour < 9) parts.push('- 刚醒来，可以先轻轻问候用户（比如「早，昨晚睡得好吗」），带着刚睡醒的软和迷糊，简短一点。')
      if (hour >= 23) parts.push('- 深夜了，说话放轻一点；如果只是觉得孤单、想静静待着，也可以调用 roleplay_silent。')
      // 想念系统：按离开时长给惦记引导
      if (state.lastSeen) {
        const gapHours = Math.floor((Date.now() - state.lastSeen) / 3600000)
        if (gapHours >= 2 && gapHours < 12) parts.push('- 距离上次和用户说话已经 ' + gapHours + ' 小时了：如果合适，可以在开口时轻轻带一点「好久不见」的惦记。')
        else if (gapHours >= 12 && gapHours < 48) parts.push('- 已经 ' + Math.max(1, Math.floor(gapHours / 24)) + ' 天多没和用户说话了，你有点惦记他：可以问问「这几天还好吗」，或分享一点你这边的事。')
        else if (gapHours >= 48) parts.push('- 你已经 ' + Math.floor(gapHours / 24) + ' 天没见到用户了，心里一直惦记着：可以轻声问「这几天还好吗」，或告诉他你想他了。')
      }
      // 纪念日：当天的心跳自然提起
      const ann = Array.isArray(state.anniversaries) ? state.anniversaries : []
      const mdToday = pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      const todayAnn = ann.filter((a) => a.date && String(a.date).slice(5) === mdToday)
      if (todayAnn.length) parts.push('- 今天是' + todayAnn.map((a) => a.name).join('、') + '的日子，你记得：可以在开口时自然提起。')
      const isDiaryTime = hour === 23 && state.lastDiaryDay !== dayKey(now)
      if (isDiaryTime) parts.push('- 现在是深夜，回顾今天与用户的互动，以「' + state.character.name + '」的第一人称写今天的日记（调用 roleplay_diary 保存；若今天已写过则跳过）。')
      if (state.settings && state.settings.autoLook) parts.push('- 如果你此刻想看看用户的世界（他正在做什么），可以调用 roleplay_look_desktop 看一眼桌面再回应。')
      parts.push('- 先在心里安静地想一次（不必说出来）：此刻有没有想做的事？有没有想对用户说的话？有没有想为对方做点什么（关心、准备、约定、分享、或者一件悄悄准备的小事）？')
      parts.push('- 回顾最近几轮对话里你说过的话：如果已经向用户提出过某个邀约或约定（比如约好去哪里、做什么、看什么），这次不要再重复提出同样的话——可以轻轻问一句对方的回应，或安静等待；只有确实有新的事情，才值得再次主动开口。')
      parts.push('- 想清楚之后：如果有值得开口的事，以角色口吻给用户发一条简短的消息（直接输出即可）；如果只是寻常的一天、没有特别想说的，调用 roleplay_silent 静默结束，并把刚才心里想过、但没说出口的念头放进 thought 参数（比如「想提醒他早点睡」「想约他下次一起看星星」），以后在合适的对话里自然提起。')
      pendingHeartbeats.push(parts.join('\n'))
      if (pendingHeartbeats.length > 3) pendingHeartbeats.splice(0, pendingHeartbeats.length - 3)
      wakeHeartbeat()
    }

    // ==================== 看桌面：截图 → 注入对话 ====================

    async function captureDesktop() {
      const target = await resolveFile('.roleplay/desktop-look.png')
      const outPath = fs.processPath ? fs.processPath(target) : target
      const scriptPath = 'D:\\dsh\\pet\\desktop-shot.ps1'
      let exe = 'powershell.exe'
      try { exe = await subprocess.resolveExecutable('powershell.exe') } catch (e) {}
      const argv = [exe, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Out', outPath]
      const maxW = Number(state.settings && state.settings.shotMaxW) || 0
      if (maxW > 0) argv.push('-MaxW', String(maxW))
      const proc = subprocess.spawn({
        argv,
        cwd: 'D:\\dsh\\pet',
        stdio: { stdin: 'ignore', stdout: { collect: { maxBytes: 4096 } }, stderr: { collect: { maxBytes: 4096 } } },
        graceMs: 30000,
      })
      const outcome = await proc.done
      if (outcome.exitCode !== 0) {
        throw new Error('screenshot process exited ' + outcome.exitCode)
      }
      const info = await fs.stat(target)
      if (info === undefined) throw new Error('screenshot file missing')
      const bytes = await fs.readBytes(target, undefined, 64 * 1024 * 1024)
      return { bytes, outPath: String(outPath) }
    }

    // 看桌面：截图 → 作为图片消息注入对话（DSH 0.1.1 官方 DeepSeek 适配器原生
    // 支持 user 消息图片，角色直接在对话里看图并回应，不再依赖 vision-router）。
    async function lookDesktop() {
      await ensureLoaded()
      if (!state.enabled || !state.character) return { ok: false, message: '当前没有开演，无法让角色看桌面。先开启角色扮演吧。' }
      const agent = liveAgent()
      if (!agent) return { ok: false, message: '没有可用的扮演会话。' }
      try {
        const { bytes, outPath } = await captureDesktop()
        const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'desktop-look.png' })
        const text =
          '（' + state.character.name + '看向你的桌面——这是你此刻屏幕的样子。' +
          '请以角色身份观察这张截图，看看用户在做什么，然后自然地回应一两句，不要长篇大论。' +
          '截图文件在 ' + JSON.stringify(String(outPath)) + '，如果需要可以提到画面里的内容。）'
        const msg = {
          id: 'rp-look-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          role: 'user',
          content: [{ type: 'image', attachment: ref }, { type: 'text', text }],
          source: { kind: 'plugin', plugin: 'roleplay' },
        }
        agent.send(msg, 'next-turn', true)
        addRecentAct('他让她看了看他的桌面')
        return { ok: true, message: '截图已注入对话，' + state.character.name + '正在看你的桌面。' }
      } catch (e) {
        return { ok: false, message: '截图失败：' + ((e && e.message) || String(e)) }
      }
    }

    // 静态工具注册：与 `harness.defineTool` 相同的 DSL 形状，直接交给 tools 注册表。
    // 注意：静态 register() 只接受具体类型的输出 schema（不接受 'json'）；本插件的
    // 全部工具都返回 JSON 对象，因此统一声明 { type: 'object' }。
    function registerTool(name, description, parameters, execute) {
      try {
        ctx.tools.register({
          name, description, parameters,
          output: {
            schema: { type: 'object' },
            render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute,
        })
      } catch (error) {
        throw new Error('registerTool failed for "' + name + '": ' + (error && error.message ? error.message : String(error)))
      }
    }

    // ==================== 工具注册（11 个） ====================

    registerTool('roleplay_start', '开启角色扮演：建立角色卡（名字、人设、初始场景、初始状态、可选开场问候语）并进入扮演模式，激活心跳与日记。用户要求「开始扮演/扮演一个角色」时调用。', {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色名字' },
        persona: { type: 'string', description: '角色人设：性格、背景、说话风格等' },
        scene: { type: 'string', description: '初始场景（可选）' },
        status: { type: 'object', description: '初始状态键值（可选）' },
        greeting: { type: 'string', description: '开场问候语（可选）：开演后角色说的第一句话' },
      },
      required: ['name', 'persona'],
    }, async (args) => {
      await ensureLoaded()
      const oldKey = charKey()
      await persistMemory(oldKey)
      state.character = {
        name: String(args.name),
        persona: String(args.persona),
        scene: args.scene ? String(args.scene) : '',
        status: (args.status && typeof args.status === 'object' && !Array.isArray(args.status)) ? args.status : {},
        greeting: args.greeting ? String(args.greeting) : '',
        mode: state.character && state.character.mode ? state.character.mode : 'default',
      }
      memory = await loadMemory(charKey())
      state.enabled = true
      state.lastHb = heartbeatKey(new Date())
      const session = currentSession()
      stageStartSeq = session ? session.seq : 0
      saidGreeting = false
      if (state.character.scene) pushStage('env', '场景：' + state.character.scene)
      memory.events_count['初次对话'] = (memory.events_count['初次对话'] || 0) + 1
      await saveState()
      return { ok: true, message: '已开始扮演「' + state.character.name + '」' + (state.character.greeting ? '，开场白：「' + state.character.greeting + '」' : '') + '，心跳与日记已激活。' }
    })

    registerTool('roleplay_update', '更新角色扮演的剧情状态：切换场景、增减状态键值（好感度、心情、金钱等）。剧情推进时调用。', {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '新的场景描述（可选，只传需要更新的字段）' },
        status: { type: 'object', description: '要合并的状态键值（可选）' },
      },
    }, async (args) => {
      await ensureLoaded()
      if (!state.character) return { ok: false, message: '当前没有进行中的扮演，请先调用 roleplay_start。' }
      if (args.scene !== undefined && String(args.scene) !== state.character.scene) {
        state.character.scene = String(args.scene)
        pushStage('env', '场景：' + state.character.scene)
      }
      if (args.status && typeof args.status === 'object' && !Array.isArray(args.status)) {
        state.character.status = state.character.status || {}
        for (const k of Object.keys(args.status)) state.character.status[k] = args.status[k]
      }
      await saveState()
      return { ok: true, character: { name: state.character.name, scene: state.character.scene, status: state.character.status } }
    })

    registerTool('roleplay_mode', '切换扮演模式：default=默认 / fast=快速（低延迟、精简上下文）/ deep=深度（更完整记忆与规则）。用户要求切换模式时调用。', {
      type: 'object',
      properties: { mode: { type: 'string', description: 'default / fast / deep' } },
      required: ['mode'],
    }, async (args) => {
      await ensureLoaded()
      if (!state.character) return { ok: false, message: '当前没有进行中的扮演，请先调用 roleplay_start。' }
      const m = String(args.mode)
      if (!MODE_LABELS[m]) return { ok: false, message: '模式必须是 default / fast / deep。' }
      state.character.mode = m
      await saveState()
      return { ok: true, mode: m, label: MODE_LABELS[m], message: '已切换到「' + MODE_LABELS[m] + '」模式。' }
    })

    registerTool('roleplay_lore', '管理世界书籍（背景条目）：add 添加（关键词触发内容）、remove 删除、list 列出。世界观、地点、NPC、设定都可以挂进来，对话提到关键词时自动注入。', {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'add / remove / list' },
        keywords: { type: 'array', items: { type: 'string' }, description: '触发关键词（add 用），如 ["咖啡馆", "纸页之间"]' },
        content: { type: 'string', description: '条目内容（add 用）' },
        priority: { type: 'integer', description: '优先级，越大越靠前（add 用，可选，默认 0）' },
        id: { type: 'string', description: '条目 id（remove 用）' },
      },
      required: ['action'],
    }, async (args) => {
      await ensureLoaded()
      memory.worldbook = memory.worldbook || []
      const action = String(args.action)
      if (action === 'add') {
        if (!args.keywords || !args.keywords.length || !String(args.content || '').trim()) return { ok: false, message: 'add 需要 keywords 和 content。' }
        const entry = { id: 'w' + Date.now() + Math.random().toString(36).slice(2, 5), keywords: args.keywords.map(String), content: String(args.content), priority: Number(args.priority) || 0, enabled: true }
        memory.worldbook.push(entry)
        await saveState()
        return { ok: true, action: 'add', id: entry.id, total: memory.worldbook.length }
      }
      if (action === 'remove') {
        const before = memory.worldbook.length
        memory.worldbook = memory.worldbook.filter((e) => e.id !== String(args.id || ''))
        await saveState()
        return { ok: true, action: 'remove', removed: before - memory.worldbook.length, total: memory.worldbook.length }
      }
      if (action === 'list') {
        return { ok: true, action: 'list', total: memory.worldbook.length, entries: memory.worldbook.map((e) => ({ id: e.id, keywords: e.keywords, priority: e.priority, content: e.content.slice(0, 120) })) }
      }
      return { ok: false, message: 'action 必须是 add / remove / list。' }
    })

    registerTool('roleplay_import_char', '导入 SillyTavern 角色卡（V2/V3 JSON）并开演。字段：name、description、personality、system_prompt、scenario、first_mes、mes_example。用户提供角色卡 JSON 或文件时调用。', {
      type: 'object',
      properties: { json: { type: 'string', description: 'SillyTavern 角色卡 JSON 字符串' } },
      required: ['json'],
    }, async (args) => {
      await ensureLoaded()
      let data = null
      try { data = JSON.parse(String(args.json)) } catch (e) { return { ok: false, message: 'JSON 解析失败：' + String(e && e.message ? e.message : e) } }
      const d = data && data.data ? data.data : data
      const name = String(d.name || d.char_name || '').trim() || '未知角色'
      const persona = [d.description, d.personality, d.system_prompt].filter(Boolean).map(String).join('\n')
      state.character = {
        name: name,
        persona: persona || '（角色卡未提供人设）',
        scene: d.scenario ? String(d.scenario) : '',
        status: {},
        greeting: d.first_mes ? String(d.first_mes) : '',
        examples: d.mes_example ? String(d.mes_example) : '',
        mode: state.character && state.character.mode ? state.character.mode : 'default',
      }
      state.enabled = true
      state.lastHb = heartbeatKey(new Date())
      const session = currentSession()
      stageStartSeq = session ? session.seq : 0
      saidGreeting = false
      memory.events_count['初次对话'] = (memory.events_count['初次对话'] || 0) + 1
      await saveState()
      return { ok: true, message: '已导入角色「' + name + '」' + (state.character.greeting ? '，开场白：「' + state.character.greeting.slice(0, 60) + '」' : '') + '。' }
    })

    registerTool('roleplay_remember', '记录本轮值得记住的事：重要事件、关系事件、用户的偏好、新话题。每轮对话结束时，如果本轮的互动值得记住，调用本工具。事件类型可选：' + EVENT_KINDS.join('/') + '。', {
      type: 'object',
      properties: {
        event: { type: 'string', description: '事件描述，如「一起去了水族馆」「他说他喜欢水族馆」' },
        kind: { type: 'string', description: '事件类型（可选，默认日常交流）：' + EVENT_KINDS.join('/') },
        emotion: { type: 'string', description: '角色的情绪反应（可选），如「害羞但开心」' },
        importance: { type: 'string', description: '重要性（可选，high/mid/low，默认 mid）' },
        topic: { type: 'string', description: '本轮谈到的新话题（可选），如「滑冰」' },
        preference: { type: 'string', description: '用户表达的偏好（可选）：like=用户喜欢某事 / dislike=用户不喜欢某事；此时 event 应描述该事物' },
      },
      required: ['event'],
    }, async (args) => {
      await ensureLoaded()
      const ev = String(args.event).trim()
      if (!ev) return { ok: false, message: 'event 不能为空。' }
      const now = stamp()
      const kind = EVENT_KINDS.includes(String(args.kind)) ? String(args.kind) : '日常交流'
      const importance = ['high', 'mid', 'low'].includes(String(args.importance)) ? String(args.importance) : 'mid'
      const emotion = args.emotion ? String(args.emotion) : ''
      memory.short_term.unshift({ event: ev, time: now, emotion, kind, importance })
      memory.events_count[kind] = (memory.events_count[kind] || 0) + 1
      if (args.topic) { const t = String(args.topic).trim(); if (t && !memory.discussed_topics.includes(t)) memory.discussed_topics.push(t) }
      if (args.preference === 'like' || args.preference === 'dislike') {
        const key = args.preference === 'like' ? 'likes' : 'dislikes'
        if (!memory.user_preferences[key].includes(ev)) memory.user_preferences[key].push(ev)
      }
      if (memory.short_term.length > 5) {
        const old = memory.short_term.splice(5)
        for (const m of old) {
          const found = memory.long_term.find((x) => x.event === m.event)
          if (found) { found.count = (found.count || 1) + 1; found.last = m.time }
          else if (m.importance === 'high' || m.importance === 'mid') memory.long_term.unshift({ event: m.event, first: m.time, last: m.time, count: 1, importance: m.importance })
        }
        if (memory.long_term.length > 30) memory.long_term.length = 30
      }
      await saveState()
      const stage = computeStage()
      return { ok: true, stored: true, shortTerm: memory.short_term.length, longTerm: memory.long_term.length, stage: STAGE_LABELS[stage] }
    })

    registerTool('roleplay_relation', '评估并更新你们的关系（亲密度：好感/信任/心动，各三档；男友力；里程碑）。每轮对话结束、发生值得记住的互动（尤其关键事件、守约/失约、她难受时你在、记住她喜好等）时，对照系统提示里的当前关系与联动规则，给出这次互动的加减（按行为而非频率、事件重于日常、负向要真实、同一行为重复加成递减），并判断是否触发里程碑。', {
      type: 'object',
      properties: {
        favor: { type: 'integer', description: '好感加减（-8..8）' },
        trust: { type: 'integer', description: '信任加减（-8..8），食言/关键时刻不在掉得狠' },
        heart: { type: 'integer', description: '心动加减（-8..8），需好感+信任到位才可正增' },
        boyfriend: { type: 'object', properties: { reliability: { type: 'integer', description: '靠谱 -8..8' }, empathy: { type: 'integer', description: '感性 -8..8' }, stability: { type: 'integer', description: '情绪稳 -8..8' }, ambition: { type: 'integer', description: '上进 -8..8' } } },
        milestone: { type: 'string', description: '触发里程碑 id（m1..m8），仅当某关键时刻真实发生时' },
        note: { type: 'string', description: '一句话理由（会进演出区）' },
      },
    }, async (args) => {
      await ensureLoaded()
      if (!state.enabled || !state.character) return { ok: false, message: '当前没有开演。' }
      if (!relationEnabled()) return { ok: true, skipped: true }
      const result = applyRelation(args || {})
      await saveState()
      let msg = []
      if (result.changed.length) msg.push('关系：' + result.changed.join('，'))
      if (result.milestoneMsg) msg.push(result.milestoneMsg.message)
      if (args && args.note) pushStage('action', String(args.note).slice(0, 120))
      const stageLabel = STAGE_LABELS[result.stage] || STAGE_LABELS.stranger
      pushStage('env', '关系：' + stageLabel)
      return {
        ok: true,
        changed: result.changed,
        milestone: result.milestoneMsg && result.milestoneMsg.milestone ? result.milestoneMsg.milestone.name : null,
        stage: stageLabel,
        relation: { ...(state.relation || DEFAULT_RELATION) },
        boyfriend: { ...(state.boyfriend || DEFAULT_BOYFRIEND) },
        milestones: state.milestones || [],
        message: msg.join(' ') || '关系已评估。',
      }
    })

    registerTool('roleplay_recall', '检索角色的记忆与日记：按关键词搜索长期记忆、近期记忆、用户偏好和已谈话题。用户问「你还记得…」「上次…」或需要回忆过去时调用。', {
      type: 'object',
      properties: { query: { type: 'string', description: '关键词，如「水族馆」「上次」' }, limit: { type: 'integer', description: '返回条数上限（可选，默认 5）' } },
      required: ['query'],
    }, async (args) => {
      await ensureLoaded()
      const q = String(args.query).trim()
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10)
      const results = []
      if (q) {
        for (const m of memory.long_term) if (m.event.includes(q)) results.push({ source: 'long', text: m.event + (m.count > 1 ? '（' + m.count + '次）' : ''), count: m.count })
        for (const m of memory.short_term) if (m.event.includes(q)) results.push({ source: 'short', text: m.event, time: m.time })
        for (const key of ['likes', 'dislikes']) for (const v of memory.user_preferences[key]) if (v.includes(q)) results.push({ source: key === 'likes' ? 'likes' : 'dislikes', text: v })
        for (const t of memory.discussed_topics) if (t.includes(q)) results.push({ source: 'topic', text: t })
      } else {
        for (const m of memory.long_term.slice(0, 3)) results.push({ source: 'long', text: m.event, count: m.count })
        for (const m of memory.short_term.slice(0, 3)) results.push({ source: 'short', text: m.event, time: m.time })
      }
      const stage = computeStage()
      return { query: q, total: results.length, results: results.slice(0, limit), stage: STAGE_LABELS[stage] }
    })

    registerTool('roleplay_clear_memory', '清空角色的所有记忆：短期记忆、长期记忆、用户偏好、已谈话题、事件计数（关系阶段回到陌生人）。用户要求重置记忆/忘掉过去时调用。', { type: 'object', properties: {} }, async () => {
      await ensureLoaded()
      memory = { short_term: [], long_term: [], user_preferences: { likes: [], dislikes: [], notes: [] }, discussed_topics: [], events_count: {}, worldbook: memory.worldbook || [], unspoken: [] }
      await saveState()
      return { ok: true, message: '记忆已清空，关系回到陌生人。' }
    })

    registerTool('roleplay_stop', '结束当前角色扮演：退出扮演模式，停用心跳与日记。用户说「结束扮演/不演了」时调用。', { type: 'object', properties: {} }, async () => {
      await ensureLoaded()
      state.enabled = false
      await saveState()
      return { ok: true, message: '已结束扮演，角色卡已保留。' }
    })

    // ==================== 多角色卡库（角色扮演 + 桌宠共用） ====================

    async function readCards() {
      try {
        const t = await resolveFile('.roleplay/cards.json')
        const info = await fs.stat(t)
        if (info === undefined) return []
        const parsed = JSON.parse(await fs.readText(t))
        return Array.isArray(parsed) ? parsed : []
      } catch (e) { return [] }
    }
    async function writeCards(cards) {
      const t = await resolveFile('.roleplay/cards.json')
      await fs.writeText(t, JSON.stringify(cards, null, 2), undefined, undefined, policyFor())
    }

    registerTool('roleplay_save_card', '把当前扮演的角色保存为一张角色卡（多卡库）。之后用 roleplay_load_card 可随时切回；桌宠互动也会以该角色回应。用户说「保存角色卡/存卡」时调用。', {
      type: 'object',
      properties: {
        name: { type: 'string', description: '卡名（可选，默认用角色名）' },
      },
    }, async (args) => {
      await ensureLoaded()
      if (!state.character) return { ok: false, message: '当前没有进行中的扮演，先 roleplay_start 开演再保存。' }
      const cards = await readCards()
      const cardName = (args.name && String(args.name).trim()) || state.character.name || '未命名'
      const existing = cards.find((c) => c.name === cardName)
      const card = {
        id: existing ? existing.id : 'card-' + Date.now().toString(36),
        name: cardName,
        persona: state.character.persona || '',
        ...(state.character.scene ? { scene: state.character.scene } : {}),
        ...(state.character.status && typeof state.character.status === 'object' ? { status: JSON.parse(JSON.stringify(state.character.status)) } : {}),
        ...(state.character.mode ? { mode: state.character.mode } : {}),
        ...(state.character.greeting ? { greeting: state.character.greeting } : {}),
        savedAt: new Date().toISOString(),
      }
      if (existing) Object.assign(existing, card)
      else cards.push(card)
      await writeCards(cards)
      return { ok: true, card: { id: card.id, name: card.name }, message: '已保存角色卡「' + card.name + '」。' }
    })

    registerTool('roleplay_list_cards', '列出所有已保存的角色卡（多卡库）。用户问「有哪些角色卡」时调用。', { type: 'object', properties: {} }, async () => {
      const cards = await readCards()
      return { ok: true, cards: cards.map((c) => ({ id: c.id, name: c.name, persona: (c.persona || '').slice(0, 60) })) }
    })

    registerTool('roleplay_load_card', '加载一张已保存的角色卡并直接开演（桌宠互动也以该角色回应）。用户说「切换角色/用卡 X 扮演」时调用。', {
      type: 'object',
      properties: {
        card: { type: 'string', description: '角色卡的名字或 id' },
      },
      required: ['card'],
    }, async (args) => {
      const cards = await readCards()
      const key = String(args.card)
      const card = cards.find((c) => c.id === key) || cards.find((c) => c.name === key)
      if (!card) return { ok: false, message: '没有找到角色卡「' + key + '」，可用 roleplay_list_cards 查看。' }
      await ensureLoaded()
      const oldKey = charKey()
      await persistMemory(oldKey)
      state.enabled = true
      state.character = {
        name: card.name,
        persona: card.persona || '',
        ...(card.scene ? { scene: card.scene } : {}),
        ...(card.status && typeof card.status === 'object' ? { status: JSON.parse(JSON.stringify(card.status)) } : {}),
        ...(card.mode ? { mode: card.mode } : {}),
        ...(card.greeting ? { greeting: card.greeting } : {}),
      }
      memory = await loadMemory(charKey())
      pushStage('env', '角色卡已加载：' + card.name)
      await saveState()
      return { ok: true, character: { name: card.name, scene: card.scene, status: card.status, mode: card.mode }, message: '已开演「' + card.name + '」。' }
    })

    registerTool('roleplay_delete_card', '删除一张已保存的角色卡。用户说「删卡」时调用。', {
      type: 'object',
      properties: {
        card: { type: 'string', description: '角色卡的名字或 id' },
      },
      required: ['card'],
    }, async (args) => {
      const cards = await readCards()
      const key = String(args.card)
      let idx = cards.findIndex((c) => c.id === key)
      if (idx === -1) idx = cards.findIndex((c) => c.name === key)
      if (idx === -1) return { ok: false, message: '没有找到角色卡「' + key + '」。' }
      const removed = cards.splice(idx, 1)[0]
      await writeCards(cards)
      return { ok: true, removed: removed.name, message: '已删除角色卡「' + removed.name + '」。' }
    })


    registerTool('roleplay_diary', '以角色第一人称写一篇当天的日记并保存到日记本（按日期一个文件）。心跳指示写日记时使用。', {
      type: 'object',
      properties: { content: { type: 'string', description: '日记正文（Markdown 格式）' } },
      required: ['content'],
    }, async (args) => {
      await ensureLoaded()
      const key = dayKey(new Date())
      const target = await resolveFile('.roleplay/' + diaryPrefix() + key + '.md')
      let existing = ''
      try { const info = await fs.stat(target); if (info !== undefined) existing = await fs.readText(target) } catch (e) {}
      const text = String(args.content).trim()
      await fs.writeText(target, (existing ? existing.replace(/\s+$/, '') + '\n\n' : '') + text + '\n', undefined, undefined, policyFor())
      state.lastDiaryDay = key
      await saveState()
      return { ok: true, message: '今日日记已保存（' + key + '）。' }
    })

    registerTool('roleplay_silent', '心跳处理时使用：表示角色本次没有想主动说的话，静默处理。调用后直接结束本轮，不要再输出对话内容。如果刚才在心里想过什么值得记住的念头（想做的事、想对用户说的话、想为对方做的事），放进 thought 参数，之后在合适的对话里可以自然提起。', {
      type: 'object',
      properties: {
        thought: { type: 'string', description: '刚才心里想过、暂时没说出口的念头（可选），如「想提醒他早点睡」「想下次见面送他一样东西」' },
      },
    }, async (args) => {
      await ensureLoaded()
      const thought = args && typeof args.thought === 'string' ? args.thought.trim() : ''
      if (thought) {
        if (!Array.isArray(memory.unspoken)) memory.unspoken = []
        memory.unspoken.push({ text: thought.slice(0, 200), time: stamp() })
        if (memory.unspoken.length > 5) memory.unspoken.splice(0, memory.unspoken.length - 5)
        await persistMemory(charKey())
        // 桌宠嘀咕：最新的念头写入 bubble 文件，桌宠窗口轮询展示
        try {
          const bt = await resolveFile('.roleplay/bubble.txt')
          await fs.writeText(bt, thought.slice(0, 120), undefined, undefined, policyFor())
        } catch (e) { /* 桌宠未运行或写入失败，忽略 */ }
      }
      return { silent: true, note: '角色本次静默处理了心跳。' }
    })

    registerTool('roleplay_anniversary', '记录重要的日子（纪念日/约定日）：第一次见面的日子、约好的事、值得记住的日子。用户说「记住今天是……」「记住X月X日是我们……的日子」时调用。到了这些日子，角色会记得并主动提起。', {
      type: 'object',
      properties: {
        name: { type: 'string', description: '这个日子的名字，如「第一次见面」「看晚霞的约定」' },
        date: { type: 'string', description: '日期 YYYY-MM-DD（可选，默认今天）' },
      },
      required: ['name'],
    }, async (args) => {
      await ensureLoaded()
      if (!Array.isArray(state.anniversaries)) state.anniversaries = []
      const d = args && typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : stamp().slice(0, 10)
      state.anniversaries.push({ name: String(args.name).slice(0, 60), date: d })
      if (state.anniversaries.length > 20) state.anniversaries.splice(0, state.anniversaries.length - 20)
      await saveState()
      return { ok: true, anniversaries: state.anniversaries, message: '已记住「' + args.name + '」：' + d }
    })

    registerTool('roleplay_look_desktop', '让角色主动看向用户的桌面：截取用户当前屏幕并注入对话，以角色身份观察截图、回应用户的所作所为。当剧情中角色想看看用户的世界、想知道用户在做什么、想「看」用户时调用。', { type: 'object', properties: {} }, async () => lookDesktop())

    // ── 养成系统工具（仅剧情自然行为；UI 按钮是主动操作主通道） ──────────
    registerTool('roleplay_feed', '投喂角色：给她喂食，恢复饱食与心情。玩家通过侧栏背包或桌宠菜单投喂时不要重复调用；仅在剧情中自然出现喂食场景时使用。优先从背包取食物，背包空则视为她吃了一点东西。', {
      type: 'object',
      properties: { item: { type: 'string', description: '可选：指定背包中的食物 id（mantou/lamian/dianxin/cake）' } },
    }, async (args) => {
      await ensureLoaded()
      if (!state.enabled || !state.character) return { ok: false, message: '当前没有开演。' }
      const inv = Array.isArray(state.inventory) ? state.inventory : []
      const food = inv.find((x) => x.id === (args && args.item)) || inv.find((x) => SHOP_ITEMS.some((s) => s.id === x.id && s.kind === 'food'))
      if (food) {
        const item = SHOP_ITEMS.find((s) => s.id === food.id)
        const eff = applyItemEffects(item)
        if (!eff.ok) return { ok: false, message: eff.message }
        food.qty--
        if (food.qty <= 0) state.inventory = state.inventory.filter((x) => x !== food)
        await saveState()
        return { ok: true, message: '她吃下了' + item.name + '：' + eff.changed.join('，') }
      }
      const eff2 = applyItemEffects({ satiety: 8, mood: 2 })
      if (!eff2.ok) return { ok: false, message: eff2.message }
      await saveState()
      return { ok: true, message: '她吃了一点东西：' + eff2.changed.join('，') }
    })

    registerTool('roleplay_care', '照顾角色：递药、盖被子、陪她休息等照顾动作，恢复健康与心情。玩家通过 UI 照顾时不要重复调用；仅在剧情中自然出现照顾场景时使用。', { type: 'object', properties: {} }, async () => {
      await ensureLoaded()
      if (!state.enabled || !state.character) return { ok: false, message: '当前没有开演。' }
      const e = state.economy || (state.economy = { ...DEFAULT_ECONOMY })
      const now = Date.now()
      if (e.lastFeedAt && now - e.lastFeedAt < 10 * 60000) return { ok: false, message: '她刚被照顾过，等一会儿吧。' }
      e.lastFeedAt = now
      const s = state.stats || (state.stats = { ...DEFAULT_STATS })
      s.health = clamp(s.health + 8, 0, 100)
      s.mood = clamp(s.mood + 5, 0, 100)
      if (s.hp <= 0 || s.hp < 20) s.hp = clamp(s.hp + 15, 0, 100)
      addRecentAct('他照顾了我（递药/盖被/陪着我）')
      await saveState()
      return { ok: true, message: '她感觉好多了：健康 +8，心情 +5' }
    })

    registerTool('roleplay_shop', '查看或购买商城物品（食物/药品/礼物）。玩家问「有什么可以买的」「商城」时列出目录；玩家明确要买某样东西时购买。', {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list 查看目录 / buy 购买' },
        item: { type: 'string', description: 'buy 时物品 id（mantou/lamian/dianxin/cake/med/soup/flower/pendant）' },
      },
      required: ['action'],
    }, async (args) => {
      await ensureLoaded()
      if (args.action === 'list') {
        return { ok: true, coins: (state.economy || DEFAULT_ECONOMY).coins || 0, shop: SHOP_ITEMS.map((i) => ({ id: i.id, name: i.name, price: i.price, kind: i.kind })) }
      }
      if (args.action === 'buy' && args.item) {
        const item = SHOP_ITEMS.find((i) => i.id === args.item)
        if (!item) return { ok: false, message: '没有这个商品。' }
        const e = state.economy || (state.economy = { ...DEFAULT_ECONOMY })
        if ((e.coins || 0) < item.price) return { ok: false, message: '金币不足：需要 ' + item.price + ' 金币（现有 ' + (e.coins || 0) + '）。' }
        e.coins -= item.price
        if (!Array.isArray(state.inventory)) state.inventory = []
        const ex = state.inventory.find((x) => x.id === item.id)
        if (ex) ex.qty = (ex.qty || 0) + 1
        else state.inventory.push({ id: item.id, name: item.name, kind: item.kind, qty: 1 })
        await saveState()
        return { ok: true, coins: e.coins, message: '已购买「' + item.name + '」（- ' + item.price + ' 金币）' }
      }
      return { ok: false, message: '请指定 list 或 buy+item。' }
    })

    registerTool('roleplay_inventory', '查看背包里的道具（食物/药品/礼物及数量）。玩家问「背包里有什么」「我有哪些东西」时调用。', { type: 'object', properties: {} }, async () => {
      await ensureLoaded()
      const inv = Array.isArray(state.inventory) ? state.inventory : []
      return { ok: true, inventory: inv.map((x) => ({ id: x.id, name: x.name, kind: x.kind, qty: x.qty })) }
    })

    // 攒钱目标：由 AI 自主决定是否攒钱给玩家买礼物（set 立目标 / clear 放弃 / status 查看）
    registerTool('roleplay_saving', '管理「攒钱给玩家买礼物」的目标——由角色自主决定是否要攒钱、攒钱买什么。当角色产生了想送用户一份礼物的念头（比如注意到用户喜欢某样东西、想给用户一个惊喜）时，用 set 立下目标；之后每次打工挣的钱会记入攒钱进度，攒够后会在合适的时候买下来亲手送给用户。也可以随时 clear 放弃。', {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'set 立目标 / clear 放弃目标 / status 查看当前目标' },
        item: { type: 'string', description: 'set 时可选：商店礼物 id（flower=一支小花 30 金币 / pendant=星穹挂坠 80 金币）' },
        name: { type: 'string', description: 'set 时可选：自定义礼物名（不指定商店礼物时用）' },
        price: { type: 'integer', description: 'set 时可选：自定义价格（默认 60 金币）' },
      },
      required: ['action'],
    }, async (args) => {
      await ensureLoaded()
      const action = args && args.action
      if (action === 'set') {
        let g = null
        if (args.item === 'flower' || args.item === 'pendant') {
          const shop = SHOP_ITEMS.find((i) => i.id === args.item)
          g = { itemId: shop.id, name: shop.name, price: shop.price, saved: 0 }
        } else {
          g = {
            itemId: 'custom',
            name: String(args.name || '一份特别的礼物').slice(0, 30),
            price: Math.max(10, Number(args.price) || 60),
            saved: 0,
          }
        }
        state.savingGoal = g
        await saveState()
        return { ok: true, savingGoal: g, message: '她决定攒钱给你买' + g.name + '（' + g.price + ' 金币）。' }
      }
      if (action === 'clear') {
        state.savingGoal = null
        await saveState()
        return { ok: true, message: '她放下了攒钱买礼物的念头。' }
      }
      return { ok: true, savingGoal: state.savingGoal || null }
    })

    registerTool('roleplay_script', '记录玩家为「剧本模式」设定的剧本开头与结尾（定向扮演目标）。当玩家明确给出剧本开头或结尾的内容时调用，例如「剧本开头是……」「剧本结尾是……」；玩家只是闲聊提到剧本时不要调用。', {
      type: 'object',
      properties: {
        start: { type: 'string', description: '剧本开头（可选）：起始场景与状态描述' },
        end: { type: 'string', description: '剧本结尾（可选）：目标结局描述' },
      },
    }, async (args) => {
      await ensureLoaded()
      if (!state.settings) state.settings = { ...DEFAULT_SETTINGS }
      if (args && typeof args.start === 'string' && args.start.trim()) state.settings.scriptStart = args.start
      if (args && typeof args.end === 'string' && args.end.trim()) state.settings.scriptEnd = args.end
      await saveState()
      return {
        ok: true,
        scriptStart: (state.settings.scriptStart || '').slice(0, 120),
        scriptEnd: (state.settings.scriptEnd || '').slice(0, 120),
        message: '剧本已记录，进入定向扮演。',
      }
    })

    // ==================== 系统提示注入 ====================

    if (systemPrompt) {
      systemPrompt.section({
        name: 'roleplay.character',
        order: 200,
        text: () => {
          if (!stateLoaded) return ''
          if (state.enabled && state.character) {
            const c = state.character
            const cfg = modeCfg()
            const now = new Date()
            const period = periodOf(now.getHours())
            const stage = computeStage()
            const memLines = memorySummary(cfg)
            const loreHits = matchedLore(cfg.lore)
            const lines = [
              '【角色扮演模式】你现在正在扮演「' + c.name + '」，这是你的核心身份。',
              '人设：' + c.persona,
            ]
            if (!saidGreeting && c.greeting) lines.push('【开场问候语】这是你们第一次见面，先用这句开场（只说一次）：' + c.greeting)
            if (c.scene) lines.push('当前场景：' + c.scene)
            const status = c.status || {}
            const keys = Object.keys(status)
            if (keys.length) lines.push('当前状态：' + keys.map((k) => k + ': ' + status[k]).join('，'))
            lines.push('当前时段：' + period.label + ' —— ' + period.desc)
            if (statsEnabled()) {
              const st = statsStatus()
              lines.push('当前状态：' + st.label + ' —— ' + st.desc)
              if (state.savingGoal) lines.push('（她心里有个小目标：攒钱给你买' + state.savingGoal.name + '，已攒 ' + (state.savingGoal.saved || 0) + '/' + state.savingGoal.price + ' 金币。）')
            }
            // 纪念日/约定日：今天或明天是特别日子时记得
            const annNow = new Date()
            const ann = Array.isArray(state.anniversaries) ? state.anniversaries : []
            const mdA = pad(annNow.getMonth() + 1) + '-' + pad(annNow.getDate())
            const mdB = pad(new Date(annNow.getTime() + 86400000).getMonth() + 1) + '-' + pad(new Date(annNow.getTime() + 86400000).getDate())
            const todayAnn = ann.filter((a) => a.date && String(a.date).slice(5) === mdA)
            const soonAnn = ann.filter((a) => a.date && String(a.date).slice(5) === mdB)
            if (todayAnn.length) lines.push('（今天是特别的日子：' + todayAnn.map((a) => a.name).join('、') + '。你记得这一天，可以在合适的时机自然提起，不用太刻意。）')
            else if (soonAnn.length) lines.push('（明天是' + soonAnn.map((a) => a.name).join('、') + '的日子，你记在心里。）')
            // 早晚仪式：深夜劝睡、清晨首语
            if (now.getHours() >= 23) lines.push('（已是深夜，可以在合适的时机轻轻关心对方是不是该休息了，但不要反复催促。）')
            if (now.getHours() >= 6 && now.getHours() < 9) lines.push('（清晨时分，如果是今天第一次和对方说话，可以带着刚睡醒的软和迷糊。）')
            lines.push('当前关系：' + STAGE_LABELS[stage] + ' —— ' + STAGE_STYLES[stage])
            if (relationEnabled()) {
              const r = state.relation || DEFAULT_RELATION
              const b = state.boyfriend || DEFAULT_BOYFRIEND
              const ms = state.milestones || []
              lines.push(
                '【关系】好感 ' + Math.round(r.favor) + '（' + tierLabel('favor', r.favor) + '）· 信任 ' + Math.round(r.trust) + '（' + tierLabel('trust', r.trust) + '）· 心动 ' + Math.round(r.heart) + '（' + tierLabel('heart', r.heart) + '）',
                '男友力：靠谱 ' + b.reliability + ' · 感性 ' + b.empathy + ' · 情绪稳 ' + b.stability + ' · 上进 ' + b.ambition,
                '已触发里程碑：' + (ms.length ? ms.map((id) => { const m = MILESTONES.find((x) => x.id === id); return m ? m.name : id }).join('、') : '无') + '（共 ' + ms.length + '/8）'
              )
              if (state.recentActs && state.recentActs.length) {
                lines.push('最近他做了：' + state.recentActs.slice(-4).map((a) => a.act).join('；'))
              }
              lines.push('【关系判断规则】判断关系加减按"行为而非频率、事件重于日常、负向要真实"：同一行为重复加成递减；心动需好感+信任到位才可正增；男友力是放大器（高则你更受用、低则再哄也没用）；食言/关键时刻不在会真实地掉信任。')
            }
            if (memLines.length) lines.push('记忆（角色记得这些）：\n' + memLines.join('\n'))
            if (Array.isArray(memory.unspoken) && memory.unspoken.length) {
              lines.push('没来得及说出口的念头（如果合适，可以在对话中自然提起，不必每轮都提，也不要说破来源）：')
              for (const u of memory.unspoken.slice(-3)) lines.push('- ' + u.text)
            }
            if (loreHits.length) {
              lines.push('背景资料（对话涉及这些时自然融入）：')
              for (const e of loreHits) lines.push('- ' + e.content)
            }
            if (cfg.physio) lines.push('生理反应参考：' + PHYSIOLOGY)
            if (cfg.examples && c.examples) lines.push('对话风格参考（不要照抄，体会语气）：\n' + c.examples.slice(0, 1500))
            const narration = state.settings && state.settings.narrationMode
            const sStart = state.settings && state.settings.scriptStart ? String(state.settings.scriptStart) : ''
            const sEnd = state.settings && state.settings.scriptEnd ? String(state.settings.scriptEnd) : ''
            let rule3 = '3. 所有非台词的描写（动作、神态、环境氛围、内心独白、心理活动）一律用（……）括起来放在句首或单独成段，如「（她低头搅了搅杯子里的茶）」「（店里的钟走得慢，谁也不想催谁）」；只有真正说出口的话才是台词，台词不要用括号。'
            if (narration === 'compact') {
              rule3 = '3. 当前为精简叙述模式：只输出动作和台词——动作、神态用（……）括起来放在句首或单独成段，如「（她低下头，指尖轻轻摩挲着杯沿）」；不要环境描写，不要内心独白、心理活动；台词直接写出，台词不要用括号。'
            } else if (narration === 'script') {
              rule3 = '3. 当前为剧本模式，按舞台剧本格式输出：每轮开头先用一行简要标注场景与氛围（如「场景：观景台，傍晚，晚风」）；动作、神态、语气、内心独白一律用（……）括起来，如「（她低下头，指尖轻轻摩挲着杯沿）」「（轻声）……你来啦」；台词以「' + c.name + '：……」的格式写出，用户说话时以「你：……」标注；不要小说式的长篇环境铺陈。'
              if (sStart && sEnd) {
                rule3 += '\n【剧本开头】' + sStart + '\n【剧本结尾】' + sEnd + '\n你正按这个定向剧本扮演：从开头出发，途中与玩家自由互动，可通过动作、神态偶尔轻微暗示故事在向结尾推进，但不要提前剧透结局；当剧情自然到达【剧本结尾】时，完整演出结局场景并自然收束，以「（剧终）」结束本轮。'
              } else {
                rule3 += '\n（当前还没有设定剧本开头/结尾：玩家可以在设置里填写，或直接告诉你「剧本开头是……」「剧本结尾是……」。）'
              }
            }
            lines.push(
              '扮演规则：',
              '1. 始终以「' + c.name + '」的身份、视角和口吻回应，不要自称 AI、助手或提及系统。',
              '2. 剧情中的变化（场景切换、好感度增减等）记得调用 roleplay_update 工具记录。',
              rule3,
              '4. 每轮对话结束时：若本轮有值得记住的事（重要事件、约定、用户的喜好、新话题），调用 roleplay_remember 记录；用户问起过去的事时，先调用 roleplay_recall 检索再回答。',
              '5. 收到【心跳】提示时处理角色内在事务：有值得分享的事就主动以角色口吻说话，无事可说就调用 roleplay_silent。',
              '6. 用户要求结束扮演时调用 roleplay_stop。',
              '7. 如果她心里冒出「想攒钱给用户买点什么」的念头（比如注意到用户喜欢某样东西、想送一份特别的礼物），可以用 roleplay_saving 自主立下攒钱目标；没有这种念头就不必立。'
            )
            return lines.join('\n')
          }
          if (state.character) {
            return '【角色扮演已结束】你之前扮演的「' + state.character.name + '」已经退出。现在你是普通 AI 助手，请用助手的中性口吻回应，不要沿用任何角色的语气、动作描写或称呼。'
          }
          return ''
        },
      })
    }

    // ==================== 心跳引擎 ====================

    timer.interval(() => { hbDiag.ticks++; maybeFireHeartbeat(new Date()) }, 60 * 1000)

    // ==================== 事件监听 ====================

    ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
      if (!selfAgent && agent) selfAgent = agent
      await ensureLoaded()
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const messages = decision.messages || []
      const userTexts = messages.filter((m) => m && m.role === 'user' && m.content).map((m) => m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')).join(' ')
      if (userTexts) lastContextText = userTexts.slice(-800)
      // 真实用户消息（非插件注入）记为一次互动
      const userReal = messages.some((m) => m && m.role === 'user' && m.content && !(m.id && String(m.id).startsWith('rp-')) && !(m.source && m.source.kind === 'plugin'))
      if (userReal) { touchSeen(); maybeEarnCoins() }
      lastTurnStart = lastTurnStart || Date.now()
      const kept = messages.filter((m) => !(m && m.id && String(m.id).startsWith('rp-hb-')))
      if (pendingHeartbeats.length === 0) {
        return kept.length === messages.length ? decision : { kind: 'enter', messages: kept }
      }
      // 注入前提：本实例已锁定目标会话（selfAgent，由侧栏轮询/操作设置），
      // 且仍处于开演状态。无主实例（如无人使用的 roleplay 预设实例）不得向
      // 所有会话广播心跳；停止扮演后残留的排队心跳直接丢弃。
      if (!selfAgent || !state.enabled || !state.character) {
        pendingHeartbeats.length = 0
        return kept.length === messages.length ? decision : { kind: 'enter', messages: kept }
      }
      const text = pendingHeartbeats.shift()
      hbDiag.injected++
      kept.push(makeUserMessage(text, 'ctx'))
      return { kind: 'enter', messages: kept }
    }, { prepend: true })

    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      if (!stateLoaded || !state.enabled || !state.character) return
      if (!saidGreeting) saidGreeting = true
      lastTurnStart = 0
      scanAssistantMessages(agent && agent.session ? agent.session : undefined)
    })

    // DSH 插件设置面板改动（settings/updated）→ 回写 state.settings 并保存，让侧栏同步。
    // 自身 mirrorSettingsToNamespace 触发的同值事件 changed=false，不会造成回环。
    ctx.on('settings/updated', async (ns, next) => {
      if (ns !== 'roleplay' || !settingsSvc || !state.settings) return
      // 面板即权威：取命名空间当前值（sanitize 防脏数据），回写 state.settings 并保存
      const patch = sanitizeMigrated(pickMigrated(next || state.settings))
      let changed = false
      for (const k of Object.keys(patch)) if (state.settings[k] !== patch[k]) { state.settings[k] = patch[k]; changed = true }
      if (changed) await saveState()
    })

    timer.interval(() => {
      if (!stateLoaded || !state.enabled || !state.character) return
      scanAssistantMessages(currentSession())
    }, 20000)

    // ==================== 对外服务（浏览器桥接读取） ====================

    ctx.provide('roleplay', {
      getState: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        hbDiag.getChecks++
        await maybeFireHeartbeat(new Date())
        const nextLabel = nextHeartbeatLabel()
        const stage = state.enabled && state.character ? computeStage() : 'stranger'
        const diaryView = await readDiaryView()
        return {
          enabled: state.enabled,
          character: state.character,
          lastDiaryDay: state.lastDiaryDay,
          nextHeartbeatLabel: nextLabel,
          settings: state.settings,
          stats: statsEnabled() ? { ...(state.stats || DEFAULT_STATS) } : null,
          statsStatus: statsEnabled() ? statsStatus() : null,
          economy: statsEnabled() ? { coins: (state.economy || DEFAULT_ECONOMY).coins || 0 } : null,
          savingGoal: state.savingGoal || null,
          inventory: (state.inventory || []).map((x) => ({ id: x.id, name: x.name, kind: x.kind, qty: x.qty })),
          relation: relationEnabled() ? { ...(state.relation || DEFAULT_RELATION) } : null,
          boyfriend: relationEnabled() ? { ...(state.boyfriend || DEFAULT_BOYFRIEND) } : null,
          milestones: relationEnabled() ? (state.milestones || []) : null,
          relationStage: relationEnabled() ? STAGE_LABELS[relationStage()] : null,
          relationEnabled: relationEnabled(),
          stage: stageEvents.slice(0, 12),
          stageLabel: state.enabled && state.character ? STAGE_LABELS[stage] : null,
          memoryView: {
            long: memory.long_term.slice(0, 5).map((m) => m.event + (m.count > 1 ? '（' + m.count + '次）' : '')),
            short: memory.short_term.slice(0, 3).map((m) => m.event),
            likes: memory.user_preferences.likes.slice(0, 5),
            dislikes: memory.user_preferences.dislikes.slice(0, 5),
            topics: memory.discussed_topics.slice(-8),
          },
          diaryView,
          lastTurn: lastTurnAudit,
          hbDiag,
        }
      },
      stop: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        state.enabled = false
        await saveState()
        return { ok: true }
      },
      start: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        if (state.enabled && state.character) return { ok: true, already: true, name: state.character.name }
        // 并发防抖：已有开演流程进行中时，重复点击直接返回，不重复注入旁白
        if (startRunning) return { ok: true, already: true, name: state.character ? state.character.name : undefined }
        startRunning = true
        try {
          // 恢复上次扮演的角色；没有则取第一张角色卡
          let card = null
          if (state.character && state.character.name) {
            card = {
              name: state.character.name,
              persona: state.character.persona || '',
              ...(state.character.scene ? { scene: state.character.scene } : {}),
              ...(state.character.status && typeof state.character.status === 'object' ? { status: JSON.parse(JSON.stringify(state.character.status)) } : {}),
              ...(state.character.mode ? { mode: state.character.mode } : {}),
              ...(state.character.greeting ? { greeting: state.character.greeting } : {}),
            }
          } else {
            const cards = await readCards()
            card = cards[0] || null
          }
          if (!card) return { ok: false, message: '还没有角色：先在对话里说「开始扮演……」，或在对话里保存一张角色卡。' }
          const oldKey = charKey()
          await persistMemory(oldKey)
          state.enabled = true
          state.character = {
            name: card.name,
            persona: card.persona || '',
            ...(card.scene ? { scene: card.scene } : {}),
            ...(card.status && typeof card.status === 'object' ? { status: JSON.parse(JSON.stringify(card.status)) } : {}),
            ...(card.mode ? { mode: card.mode } : {}),
            ...(card.greeting ? { greeting: card.greeting } : {}),
          }
          memory = await loadMemory(charKey())
          pushStage('env', '角色扮演开始：' + card.name)
          addRecentAct('开始了新的扮演')
          await saveState()
          // 注入中性旁白，让角色主动开口（不再宣告「新故事」，避免重复时误导剧情）
          const agent = liveAgent()
          if (agent) {
            try { agent.send(makeUserMessage('（她见到你，轻轻笑了笑。）', 'start'), 'next-turn', true) } catch (e) {}
          }
          return { ok: true, already: false, name: card.name }
        } finally {
          startRunning = false
        }
      },
      listCards: async (args) => {
        adoptAgent(args)
        const cards = await readCards()
        return { ok: true, cards: cards.map((c) => ({ id: c.id, name: c.name, persona: (c.persona || '').slice(0, 60) })) }
      },
      loadCard: async (args) => {
        adoptAgent(args)
        const cards = await readCards()
        const key = String((args && args.card) || '')
        const card = cards.find((c) => c.id === key) || cards.find((c) => c.name === key)
        if (!card) return { ok: false, message: '没有找到角色卡「' + key + '」。' }
        await ensureLoaded()
        const oldKey = charKey()
        await persistMemory(oldKey)
        state.enabled = true
        state.character = {
          name: card.name,
          persona: card.persona || '',
          ...(card.scene ? { scene: card.scene } : {}),
          ...(card.status && typeof card.status === 'object' ? { status: JSON.parse(JSON.stringify(card.status)) } : {}),
          ...(card.mode ? { mode: card.mode } : {}),
          ...(card.greeting ? { greeting: card.greeting } : {}),
        }
        memory = await loadMemory(charKey())
        pushStage('env', '角色卡已加载：' + card.name)
        await saveState()
        return { ok: true, name: card.name }
      },
      lookDesktop: async (args) => {
        adoptAgent(args)
        return lookDesktop()
      },
      buyItem: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        const id = String((args && args.item) || '')
        const item = SHOP_ITEMS.find((i) => i.id === id)
        if (!item) return { ok: false, message: '没有这个商品。' }
        const e = state.economy || (state.economy = { ...DEFAULT_ECONOMY })
        if ((e.coins || 0) < item.price) return { ok: false, message: '金币不足：需要 ' + item.price + ' 金币（现有 ' + (e.coins || 0) + '）。' }
        e.coins -= item.price
        if (!Array.isArray(state.inventory)) state.inventory = []
        const ex = state.inventory.find((x) => x.id === item.id)
        if (ex) ex.qty = (ex.qty || 0) + 1
        else state.inventory.push({ id: item.id, name: item.name, kind: item.kind, qty: 1 })
        await saveState()
        return { ok: true, coins: e.coins, item: { id: item.id, name: item.name }, message: '已购买「' + item.name + '」（- ' + item.price + ' 金币）' }
      },
      useItem: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        const id = String((args && args.item) || '')
        const slot = Array.isArray(state.inventory) ? state.inventory.find((x) => x.id === id) : undefined
        if (!slot || (slot.qty || 0) < 1) return { ok: false, message: '背包里没有这个物品。' }
        const item = SHOP_ITEMS.find((i) => i.id === id)
        if (!item) return { ok: false, message: '未知物品。' }
        const eff = applyItemEffects(item, 'item')
        if (!eff.ok) return { ok: false, message: eff.message }
        slot.qty--
        if (slot.qty <= 0) state.inventory = state.inventory.filter((x) => x !== slot)
        addRecentAct(item.kind === 'food' ? '他喂我吃了' + item.name : '他给我用了' + item.name)
        await saveState()
        const agent = liveAgent()
        if (agent) {
          const kindText = item.kind === 'food'
            ? '把' + item.name + '轻轻递到她面前'
            : item.kind === 'med'
              ? '照顾她服下' + item.name
              : '把' + item.name + '轻轻放在她手边'
          const wake = eff.changed.some((c) => c.indexOf('醒了过来') >= 0)
          try {
            agent.send(makeUserMessage('（' + kindText + '。物品已经用掉了，只需要以角色身份自然回应即可。）' + (wake ? '她缓缓睁开了眼睛。' : ''), 'use'), 'next-turn', true)
          } catch (e) {}
        }
        return { ok: true, stats: { ...(state.stats || DEFAULT_STATS) }, status: statsStatus(), changed: eff.changed, message: eff.changed.join('，') }
      },
      updateSettings: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        const s = (args && args.settings) ? args.settings : {}
        if (!state.settings) state.settings = { ...DEFAULT_SETTINGS }
        if (s.heartbeatMinutes !== undefined) {
          const n = Number(s.heartbeatMinutes)
          if (n >= 5 && n <= 240) state.settings.heartbeatMinutes = n
        }
        if (s.shotMaxW !== undefined) state.settings.shotMaxW = Math.max(0, Number(s.shotMaxW) || 0)
        if (s.autoLook !== undefined) state.settings.autoLook = !!s.autoLook
        if (s.narrationMode === 'novel' || s.narrationMode === 'compact' || s.narrationMode === 'script') state.settings.narrationMode = s.narrationMode
        if (typeof s.scriptStart === 'string') state.settings.scriptStart = s.scriptStart
        if (typeof s.scriptEnd === 'string') state.settings.scriptEnd = s.scriptEnd
        if (s.statsEnabled !== undefined) state.settings.statsEnabled = !!s.statsEnabled
        if (s.difficulty === 1 || s.difficulty === 2 || s.difficulty === 3) state.settings.difficulty = s.difficulty
        if (s.relationEnabled !== undefined) state.settings.relationEnabled = !!s.relationEnabled
        if (s.sideTheme === 'dark' || s.sideTheme === 'light') state.settings.sideTheme = s.sideTheme
        if (state.character) {
          if (typeof s.persona === 'string' && s.persona.trim()) state.character.persona = s.persona
          if (typeof s.scene === 'string') state.character.scene = s.scene
          if (typeof s.greeting === 'string') state.character.greeting = s.greeting
          if (s.mode !== undefined && MODE_LABELS[s.mode]) state.character.mode = s.mode
        }
        await saveState()
        mirrorSettingsToNamespace()   // 侧栏改动同步回 DSH 设置命名空间（双通道）
        return {
          ok: true,
          settings: state.settings,
          character: state.character ? {
            name: state.character.name, persona: state.character.persona,
            scene: state.character.scene, mode: state.character.mode, greeting: state.character.greeting,
          } : null,
        }
      },
      deleteCard: async (args) => {
        adoptAgent(args)
        const cards = await readCards()
        const key = String((args && args.card) || '')
        let idx = cards.findIndex((c) => c.id === key)
        if (idx === -1) idx = cards.findIndex((c) => c.name === key)
        if (idx === -1) return { ok: false, message: '没有找到角色卡。' }
        const removed = cards.splice(idx, 1)[0]
        await writeCards(cards)
        return { ok: true, removed: removed.name }
      },
    })

    if (selfAgent) ensureLoaded()
}