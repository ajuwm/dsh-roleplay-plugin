// DSH 角色扮演插件 · 持久化 Host 半部分（v2.1 / 静态预设插件）
// 随 agent preset 挂载（`roleplay` 预设里的相对路径行），平台重启后自动恢复。
// 依赖服务：agents / fs / systemPrompt / timer / sandboxPolicy / subprocess / attachments
// 功能：角色卡注入、11 工具、心跳、演出流、记忆、里程碑、时段、生理维度、
//       世界书籍、ST 角色卡导入、扮演模式、回合审计、停演强制切回助手、
//       看桌面（截图注入对话）、可配置心跳间隔、设置面板。
// 对外：在 isolate realm 内发布 `roleplay` 服务（getState / stop），
//       由主机侧桥接插件经 RPC 通道 /roleplay 暴露给浏览器侧边栏。
// 本文件是自包含 ESM 模块：不导入任何裸包，只使用注入的 ctx 服务。
// 路径可配置：数据/桌宠资源基于 DSH 工作区；DSH_PET_DIR 可覆盖桌宠资源目录（须在工作区内）。
import os from 'node:os'
import path from 'node:path'
import { applyDelta, reqCheck, relationStageOf, computeStageOf, repeatDimOf, dimDelta, decayLossOf } from './lib/relation-core.mjs?v=16'
import { periodOf, missClassify } from './lib/time-core.mjs?v=15'
import { pickMessages, historyMessages } from './lib/chat-core.mjs?v=1'
import { noteCreate, noteAck, visibleNotes, dueNotes, mergeNotes } from './lib/notes-core.mjs?v=1'

export const name = 'roleplay-host'
export const inject = ['agents', 'fs', 'systemPrompt', 'timer', 'sandboxPolicy', 'tools', 'subprocess', 'attachments']
export function apply(ctx, config) {
    // 预设风格: love=恋爱向(默认) / friend=朋友向(纯友谊轴) / oc=OC 原创向(全空白)
    const STYLE = (config && config.style) || 'love'
    // 数据根(每预设独立): 默认 .roleplay; 可经 config.dataRoot 指定
    const REL_ROOT = (config && config.dataRoot && typeof config.dataRoot === 'string') ? config.dataRoot : '.roleplay'
    const agents = ctx.agents
    const fs = ctx.fs
    const systemPrompt = ctx.systemPrompt
    const timer = ctx.timer
    const sandboxPolicy = ctx.sandboxPolicy
    const subprocess = ctx.subprocess
    const attachments = ctx.attachments

    // 路径根：数据/桌宠资源均放在 DSH 工作区内（fs sandbox = workspace-write，仅允许写工作区，
    // 不能迁到 %USERPROFILE%\.dsh 之外）。不用硬编码盘符；DSH_PET_DIR 可覆盖桌宠资源目录（须在工作区内）。
    // 注意：此处只用 apply 顶部已就绪的 sandboxPolicy（不能调 workspaceRoot()，它依赖后面才初始化的 selfAgent）。
    const RP_ROOT_DIR = (sandboxPolicy && sandboxPolicy.workspaceRoot) || ''
    const RP_PET_DIR = process.env.DSH_PET_DIR || path.join(RP_ROOT_DIR, 'pet')

    // ── DSH 插件设置命名空间「roleplay」双通道同步 ────────────────────────
    // settings 是可选宿主服务（ctx.get 不阻塞挂载）：存在则与 DSH 右侧「插件设置」
    // 面板双向同步（角色扮演卡），不存在则退化为仅用 state.settings（侧栏仍可编辑）。
    // 迁移到面板的字段；scriptStart/scriptEnd 及角色字段留在侧栏。
    // DSH 插件设置命名空间「roleplay」双通道同步（仅恋爱向使用；friend/oc 独立预设不共享面板设置）
    const settingsSvc = STYLE === 'love' ? ctx.get('settings') : undefined
    const MIGRATED_KEYS = ['heartbeatMinutes', 'narrationMode', 'difficulty', 'statsEnabled', 'relationEnabled', 'autoLook', 'shotMaxW', 'relPace', 'storyEnabled', 'summaryEnabled', 'userProfileEnabled']
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
      if (patch.relPace === 'slow' || patch.relPace === 'normal' || patch.relPace === 'fast') out.relPace = patch.relPace
      if (patch.storyEnabled !== undefined) out.storyEnabled = !!patch.storyEnabled
      if (patch.summaryEnabled !== undefined) out.summaryEnabled = !!patch.summaryEnabled
      if (patch.userProfileEnabled !== undefined) out.userProfileEnabled = !!patch.userProfileEnabled
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
      } catch (e) { console.error("roleplay: settings sync failed", e) }
    }
    async function mirrorSettingsToNamespace() {
      // 侧栏改完 state.settings 后回写命名空间，让面板同步显示。
      if (!settingsSvc) return
      try { await settingsSvc.update('roleplay', pickMigrated(state.settings)) } catch (e) { console.error("roleplay: mirror settings failed", e) }
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
      // 便签: 按 id 并集合并(删除墓碑优先, 其余以磁盘为准——跨实例防丢/防复活)
      if (Array.isArray(latest.notes) && Array.isArray(state.notes)) {
        state.notes = mergeNotes(state.notes, latest.notes)
      }
      // 设置防覆盖：本会话未显式保存过设置时,磁盘里"非默认"的键不因本会话写盘而回退默认
      // (多会话同预设会互相全量覆盖 → 用户保存的设置被"默认内存"会话刷掉, 切回即失效)
      if (latest.settings && typeof latest.settings === 'object' && !settingsDirty) {
        for (const k of Object.keys(latest.settings)) {
          if (state.settings[k] === DEFAULT_SETTINGS[k] && latest.settings[k] !== DEFAULT_SETTINGS[k]) state.settings[k] = latest.settings[k]
        }
      }
    }

    // 存档 schema 版本：结构变更时 +1 并在 migrateLegacy 补迁移，防旧存档静默失效
    const SCHEMA_VERSION = 2
    function migrateLegacy(parsed, fromVer) {
      // 迁移入口：每次结构变更 SCHEMA_VERSION+1，并按版本在此升级
      // v1 → v2：无字段结构调整（仅补版本标记；后续变更在此累加）
      return parsed
    }
    const DEFAULT_SETTINGS = { heartbeatMinutes: 30, shotMaxW: 0, autoLook: false, narrationMode: 'novel', scriptStart: '', scriptEnd: '', statsEnabled: STYLE !== 'oc', difficulty: 2, relationEnabled: STYLE !== 'oc', relPace: 'normal', storyEnabled: true, userProfileEnabled: true, summaryEnabled: true }
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
    // 亲密度进度难度（玩家自选）：只缩放剧情评估的正负增量，档位阈值/里程碑不变
    const REL_PACE = { slow: { mul: 0.5, label: '慢热' }, normal: { mul: 1, label: '正常' }, fast: { mul: 1.5, label: '快速' } }
    function relPaceCfg() { return REL_PACE[(state.settings && state.settings.relPace) || 'normal'] || REL_PACE.normal }
    // 生态融合三开关（默认开；关闭 = 干净卸载：工具拦截/提示词零注入/侧栏隐藏）
    function storyEnabled() { return !(state.settings && state.settings.storyEnabled === false) }
    function userProfileEnabled() { return !(state.settings && state.settings.userProfileEnabled === false) }
    function summaryEnabled() { return !(state.settings && state.settings.summaryEnabled === false) }
    const TIER_LABELS = { favor: ['疏离', '亲近', '倾慕'], trust: ['戒备', '放心', '依赖'], heart: ['无感', '在意', '心动'] }
    const RELATION_KEYS = ['favor', 'trust', 'heart']
    const BF_KEYS = ['reliability', 'empathy', 'stability', 'ambition']
    const BF_LABELS = { reliability: '靠谱', empathy: '感性', stability: '情绪稳', ambition: '上进' }
    const LOVE_MILESTONES = [
      { id: 'm1', name: '第一次成功搭话', req: { favorTier: 1 }, reward: { favor: 6 } },
      { id: 'm2', name: '第一次记住她的喜好', req: { favorTier: 2 }, reward: { favor: 5, trust: 3 } },
      { id: 'm3', name: '她难受时你陪在身边', req: { trustTier: 2 }, reward: { trust: 8, favor: 4 } },
      { id: 'm4', name: '第一次守约', req: { trustTier: 2 }, reward: { trust: 7, bfReliability: 5 } },
      { id: 'm5', name: '她主动跟你分享心事', req: { favorTier: 3, trustTier: 2 }, reward: { trust: 8, favor: 6, heart: 3 } },
      { id: 'm6', name: '一起经历过重要的事', req: { favorTier: 3, trustTier: 3 }, reward: { favor: 7, heart: 4 } },
      { id: 'm7', name: '约定的日子一起去…', req: { trustTier: 3, heartTier: 2 }, reward: { trust: 5, heart: 8, bfReliability: 4 } },
      { id: 'm8', name: '确认关系', req: { favorTier: 3, trustTier: 3, heartTier: 3 }, reward: { heart: 10 } },
    ]
    // 朋友向里程碑（纯友谊轴，无心动/男友力）
    const FRIEND_MILESTONES = [
      { id: 'm1', name: '第一次成功搭话', req: { favorTier: 1 }, reward: { favor: 6 } },
      { id: 'm2', name: '第一次记住她的喜好', req: { favorTier: 2 }, reward: { favor: 5, trust: 3 } },
      { id: 'm3', name: '她难受时你陪在身边', req: { trustTier: 2 }, reward: { trust: 8, favor: 4 } },
      { id: 'm4', name: '第一次守约', req: { trustTier: 2 }, reward: { trust: 7 } },
      { id: 'm5', name: '她主动跟你分享心事', req: { favorTier: 3, trustTier: 2 }, reward: { trust: 8, favor: 6 } },
      { id: 'm6', name: '一起经历过重要的事', req: { favorTier: 3, trustTier: 3 }, reward: { favor: 7 } },
      { id: 'm7', name: '互相帮过对方一次大忙', req: { trustTier: 3 }, reward: { trust: 5, favor: 5 } },
      { id: 'm8', name: '成为可以托付心事的知己', req: { favorTier: 3, trustTier: 3 }, reward: { trust: 10, favor: 8 } },
    ]
    const MILESTONES = STYLE === 'friend' ? FRIEND_MILESTONES : LOVE_MILESTONES
    function isFriendStyle() { return STYLE === 'friend' }
    function relationEnabled() { return !(state.settings && state.settings.relationEnabled === false) }
    function axisTier(v) { return v <= 33 ? 1 : v <= 66 ? 2 : 3 }
    function tierLabel(key, v) { const t = TIER_LABELS[key]; return t[axisTier(v) - 1] }
    let state = { enabled: false, character: null, roomMembers: [], lastHeartbeatHour: null, lastDiaryDay: null, settings: { ...DEFAULT_SETTINGS }, lastHb: null, lastSeen: null, anniversaries: [], stats: { ...DEFAULT_STATS }, economy: { ...DEFAULT_ECONOMY }, inventory: [], relation: { ...DEFAULT_RELATION }, boyfriend: { ...DEFAULT_BOYFRIEND }, milestones: [], recentActs: [], relRecent: [], lastDecayAt: null, onboarding: false, notes: [], schema_version: SCHEMA_VERSION }
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
    let lastStartWasResume = false
    // 工具防滥用（防打卡/防连发）：关系评估与看桌面的「同轮一次 + 最小间隔」状态
    let lastRelationTurn = 0
    let settingsDirty = false
    let lastRelationCallAt = 0
    let lastLookTurn = 0
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
      return computeStageOf(memory.events_count || {}, STAGE_ORDER, STAGE_REQS)
    }

    // ── 亲密度：档位推导 + 联动引擎 ────────────────────────────────────
    function relationStage() {
      return relationStageOf(state.relation || DEFAULT_RELATION, (state.milestones || []).length)
    }
    // 里程碑满足度返回（供 AI 与 UI 判断；纯函数在 relation-core.mjs）
    function mileReqCheck(m) {
      return reqCheck(m, state.relation || DEFAULT_RELATION, TIER_LABELS)
    }
    // 记录最近行为（AI 评审素材）
    function addRecentAct(act) {
      if (!Array.isArray(state.recentActs)) state.recentActs = []
      state.recentActs.push({ act: String(act).slice(0, 80), time: stamp() })
      if (state.recentActs.length > 8) state.recentActs.splice(0, state.recentActs.length - 8)
    }

    // ── 剧情档案（小说式记忆库）：story.md 章节式 + characters/world/index，供超长剧情跨会话续写 ──
    // 灵感/对齐自酒馆社区与 dsh-roleplay-preset 的 .roleplay-memory 设计：
    // 引擎负责"目录与最新进展"(index.json 结构化、可靠注入)，正文/角色/世界档案是普通 md（用户可直接编辑，以修改后为准）。
    let storyCache = null
    let lineCache = null
    const STORY_FILES = ['story.md', 'characters.md', 'world.md', 'index.md']
    async function storyPath(name) { return resolveFile(REL_ROOT + '/story/' + name) }
    async function storyRead(name) {
      try {
        const p = await storyPath(name)
        const i = await fs.stat(p)
        if (i !== undefined) return await fs.readText(p)
      } catch (e) { /* 还没建立 */ }
      return null
    }
    async function storyWrite(name, content) {
      await fs.writeText(await storyPath(name), content, undefined, undefined, policyFor())
    }
    async function readStoryIndex() {
      try {
        const t = await storyRead('index.json')
        if (!t) return null
        const j = JSON.parse(t)
        return (j && Array.isArray(j.chapters)) ? j : null
      } catch (e) { return null }
    }
    async function refreshStoryCache() { storyCache = await readStoryIndex() }
    // 精确时间锚:让角色对"此刻"有强感知(周几/日期/时:分/时段 + 凌晨特判)
    const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']
    function nowCheckLine(now, period) {
      const pad2 = (n) => String(n).padStart(2, '0')
      let s = '【此刻】周' + WEEK_CN[now.getDay()] + ' ' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + '（' + (period ? period.label : '') + '）。'
      const h = now.getHours()
      if (h < 6) s += '（凌晨了：她要么困得迷糊，要么还惦记着你别熬到天亮——语气放轻放慢；如果对话延续到这么晚，她也会顺势把话说到很晚。）'
      return s
    }
    function storySummaryLine() {
      if (!storyCache) return null
      const n = storyCache.chapters.length
      const latest = storyCache.latest
      if (!latest) return null
      return '【剧情档案】已存 ' + n + ' 章故事，最近一章《' + latest.title + '》（' + (latest.time || '') + '）。最近进展：' + (latest.summary || '') + '。涉及早期剧情时先 roleplay_story(read) 再演；用户说【存档】或一个剧情段落完成时 roleplay_story(archive)。剧情档案在 ' + REL_ROOT + '/story/，用户可编辑，以修改后为准。'
    }

    // ── 人格档案(line)：底线 + 真实感增强，一体文件,玩家面不可见 ──
    // 运行时隐身：getState/侧栏/卡库不暴露；提示词注入但禁止模型提及"底线/文件"概念。
    async function lineRead() {
      try {
        const p = await resolveFile(REL_ROOT + '/line-' + charKey() + '.md')
        const i = await fs.stat(p)
        if (i !== undefined) return await fs.readText(p)
      } catch (e) { /* 尚未生成 */ }
      return null
    }
    async function lineWrite(content) {
      await fs.writeText(await resolveFile(REL_ROOT + '/line-' + charKey() + '.md'), String(content || ''), undefined, undefined, policyFor())
    }
    // 开演核查：存在 → 注入内容;缺失 → 一行提示(不强制)
    function lineCheckLine() {
      return '【人格档案核查】这个角色还没有生成「底线 · 真实感」档案：她看起来会有点"顺"。如果需要，你可以提一句「为她生成底线/让她更像活人」，或在新角色引导里自动生成。'
    }
    async function storyArchive(args) {
      const a = args || {}
      const content = String(a.content || '').trim()
      if (!content) return { ok: false, message: '（存档内容为空，没有可写的东西。）' }
      const idx = storyCache || { chapters: [], latest: null }
      const n = idx.chapters.length + 1
      const title = String(a.title || '').trim() || ('第' + n + '章 未命名')
      const outline = String(a.outline || '').trim()
      const summary = String(a.summary || '').trim() || outline || content.slice(0, 60)
      const now = stamp()
      // 正文追加（普通 md，用户可编辑）
      const body = await storyRead('story.md')
      const chapter = '## ' + title + '\n**大纲**：' + (outline || '（无）') + '\n**内容**：\n' + content + '\n'
      await storyWrite('story.md', (body ? body.replace(/\s+$/, '') + '\n\n' : '# 剧情档案\n\n') + chapter)
      // 索引（结构化，供注入/测试）
      idx.chapters.unshift({ title, time: now, outline })
      idx.latest = { title, time: now, summary }
      if (idx.chapters.length > 200) idx.chapters.length = 200
      await storyWrite('index.json', JSON.stringify(idx, null, 2))
      // characters.md / world.md：从角色卡与世界书生成（可编辑档案，引擎只在最新时重写合并并保留用户补充）
      const c = state.character || {}
      const charBlock = '# 角色档案\n\n## ' + (c.name || '（未名）') + '\n**人设**：' + (c.persona || '（未填）') + (c.scene ? '\n**当前场景**：' + c.scene : '') + '\n'
      const existingChars = await storyRead('characters.md')
      await storyWrite('characters.md', (existingChars || '# 角色档案\n\n').indexOf('## ' + (c.name || '')) >= 0 ? existingChars : charBlock + (existingChars || '').replace(/^# 角色档案[\s\S]*?\n\n/, ''))
      const wb = (memory.worldbook || []).map((w) => '- ' + (w.content || w.name || '')).join('\n')
      await storyWrite('world.md', '# 世界观档案\n\n' + (wb || '（暂无世界观资料。') + '\n')
      await storyWrite('index.md', '# 剧情档案索引\n\n- 正文：' + STORY_FILES[0] + '（已存 ' + n + ' 章）\n- 角色档案：characters.md\n- 世界观：world.md\n\n**最近进展**：' + summary + '\n\n**当前时间**：' + now + '\n')
      // 存档时顺带刷新浓缩摘要（与"最近进展"同源，供提示词常驻注入）
      if (summaryEnabled()) state.storySummary = summary.slice(0, 300)
      await refreshStoryCache()
      return { ok: true, chapter: n, title, message: '已存档：' + title }
    }

    // ── 用户人设档案（你是谁：身份/外貌/背景/称呼/说话方式）——
    // 预设级一份（跨角色共享，因为"你"在每个角色面前是同一个人）；空档案不注入。
    async function readUserProfile() {
      try {
        const p = await resolveFile(REL_ROOT + '/user-profile.json')
        const i = await fs.stat(p)
        if (i === undefined) return null
        const j = JSON.parse(await fs.readText(p))
        return (j && typeof j === 'object') ? j : null
      } catch (e) { return null }
    }
    async function writeUserProfile(p) {
      await fs.writeText(await resolveFile(REL_ROOT + '/user-profile.json'), JSON.stringify(p, null, 2), undefined, undefined, policyFor())
    }
    function userProfileLines() {
      if (!userProfileEnabled()) return null
      const u = state.userProfile
      if (!u) return null
      const out = []
      const kv = (k, v) => { const s = String(v || '').trim(); if (s) out.push('- ' + k + '：' + s.slice(0, 120)) }
      kv('称呼', u.nickname || u.name)
      if (u.name && u.name !== u.nickname) kv('名字', u.name)
      kv('身份', u.identity)
      kv('外貌', u.appearance)
      kv('背景', u.background)
      kv('说话方式', u.speechStyle)
      kv('备注', u.notes)
      return out.length ? '【用户】这是玩家' + (u.nickname ? '「' + u.nickname + '」' : '') + '的人物档案（你对"他/她"的认知，不是设定数据表）：\n' + out.join('\n') : null
    }
    // 应用 AI 关系判断：核心逻辑在 lib/relation-core.mjs（纯函数），此处只做状态落地
    function applyRelation(delta) {
      const raw = delta || {}
      // 引擎限幅(防御)：单轮 |加减| ≤ 8（男友力轴同），模型传超了按 ±8 截断
      const lim = (v) => Math.max(-8, Math.min(8, Number(v) || 0))
      const dl = { favor: lim(raw.favor), trust: lim(raw.trust), heart: lim(raw.heart) }
      if (raw.boyfriend && typeof raw.boyfriend === 'object') {
        dl.boyfriend = {}
        for (const k of BF_KEYS) dl.boyfriend[k] = lim(raw.boyfriend[k])
      }
      if (raw.milestone !== undefined) dl.milestone = raw.milestone
      if (raw.note !== undefined) dl.note = raw.note
      // 重复行为递减（同轴同向连续：第2次 ×0.6、第3+次 ×0.3；跨实例持久化，换方向即重置）
      const dd = dimDelta(dl, state.relRecent || [])
      // 进度难度(玩家自选)：只缩放剧情评估增量(慢热×0.5 / 正常×1 / 快速×1.5)，档位阈值/里程碑不变
      const pace = relPaceCfg()
      const eff = { ...dd.delta }
      for (const k of ['favor', 'trust', 'heart']) if (typeof eff[k] === 'number') eff[k] = Math.round(eff[k] * pace.mul * 10) / 10
      const res = applyDelta(state.relation || { ...DEFAULT_RELATION }, state.boyfriend || { ...DEFAULT_BOYFRIEND }, state.milestones || [], eff, {
        isFriend: isFriendStyle(),
        milestonesDef: MILESTONES,
        tierLabels: TIER_LABELS,
        bfLabels: BF_LABELS,
        keyLabels: { favor: '好感', trust: '信任', heart: '心动' },
      })
      state.relation = res.relation
      state.boyfriend = res.boyfriend
      state.milestones = res.milestones
      // 记录本次评估增量（重复递减判定窗口；久别衰减条目不入此处）
      const rec = { t: Date.now() }
      for (const k of ['favor', 'trust', 'heart']) rec[k] = typeof eff[k] === 'number' ? eff[k] : null
      if (!Array.isArray(state.relRecent)) state.relRecent = []
      state.relRecent.push(rec)
      if (state.relRecent.length > 8) state.relRecent.splice(0, state.relRecent.length - 8)
      if (res.milestoneMsg && res.milestoneMsg.ok) pushStage('env', '里程碑：' + res.milestoneMsg.milestone.name)
      return { changed: res.changed, milestoneMsg: res.milestoneMsg, stage: relationStage(), heartLocked: !!res.heartLocked, dims: dd.dims }
    }

    // 久别衰减（负向保底）：>48h 未互动 → 每满 24h 信任 -1，封顶 -5；玩家回来即停
    function decayIfAway() {
      if (!state.enabled || !state.character) return
      if (!relationEnabled()) return
      if (!state.lastSeen) return
      const now = Date.now()
      const { loss, next } = decayLossOf(state.lastSeen, state.lastDecayAt, now, 5)
      if (loss > 0) {
        state.lastDecayAt = next
        const before = state.relation.trust || 0
        state.relation.trust = clamp(before - loss, 0, 100)
        if (state.relation.trust !== before) {
          pushStage('env', '久别生疏：信任 -' + (before - state.relation.trust))
          saveState()
        }
      } else if (now - state.lastSeen < 48 * 3600 * 1000) {
        // 玩家回来了：重置衰减基准
        state.lastDecayAt = null
      }
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
        const dir = await resolveFile(REL_ROOT)
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
          const t = await resolveFile(REL_ROOT + '/' + prefix + files[0])
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
    function charKeyFor(name) {
      const n = String(name || '').trim()
      if (!n) return '_default'
      return n.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 40) || '_default'
    }
    function charKey() { return charKeyFor(state.character ? state.character.name : '') }
    // 房间模式：把目标角色的记忆/进度临时载入并执行 fn，之后恢复现场
    // （成员须已是角色卡或当前角色；只替换内存态，不动持久化的主档）
    async function withChar(name, fn) {
      const target = String(name || '').trim()
      if (!target) return null
      if (!state.character || state.character.name === target) return fn()
      const prev = state.character
      const curKey = charKeyFor(prev.name)
      await persistMemory(curKey)
      await persistProgress(curKey)
      const cards = await readCards()
      const member = cards.find((c) => c.name === target) || (prev.name === target ? prev : null)
      if (!member) return null
      state.character = { ...member, mode: prev.mode || 'default' }
      memory = await loadMemory(charKey())
      await loadProgress(charKey())
      try {
        return await fn()
      } finally {
        const doneKey = charKey()
        await persistMemory(doneKey)
        await persistProgress(doneKey)
        state.character = prev
        memory = await loadMemory(charKey())
        await loadProgress(charKey())
      }
    }
    // 快照：房间模式下供提示注入每角色的 人设/关系/记忆摘要（不阻塞提示生成）
    let roomSnapshot = {}
    async function exitRoomIfAny() {
      if (!Array.isArray(state.roomMembers) || !state.roomMembers.length) return
      state.roomMembers = []
      roomSnapshot = {}
    }
    async function refreshRoomSnapshot() {
      const names = Array.isArray(state.roomMembers) ? state.roomMembers : []
      const snap = {}
      if (names.length) {
        const cards = await readCards()
        for (const n of names) {
          const card = cards.find((c) => c.name === n) || (state.character && state.character.name === n ? state.character : null)
          if (!card) continue
          let relation = null, stage = null, milestones = [], mems = []
          try {
            const p = JSON.parse(await fs.readText(await resolveFile(REL_ROOT + '/progress-' + charKeyFor(n) + '.json')))
            relation = p.relation || null
            milestones = Array.isArray(p.milestones) ? p.milestones : []
            stage = relation ? relationStageOf(relation, milestones.length) : null
          } catch (e) { /* fresh */ }
          try {
            const m = JSON.parse(await fs.readText(await resolveFile(REL_ROOT + '/mem-' + charKeyFor(n) + '.json')))
            mems = (Array.isArray(m.short_term) ? m.short_term : []).slice(0, 2).map((x) => String(x.event || '').slice(0, 60))
          } catch (e) { /* fresh */ }
          snap[n] = { name: n, persona: card.persona || '', relation, stage, mems }
        }
      }
      roomSnapshot = snap
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
        const t = await resolveFile(REL_ROOT + '/mem-' + key + '.json')
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
        const t = await resolveFile(REL_ROOT + '/mem-' + key + '.json')
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

    // 按角色隔离的「进度」：亲密度（好感/信任/心动/男友力/里程碑）、养成数值（stats/economy）、
    // 背包、攒钱目标、纪念日、近期记录、日记日期 —— 每个角色一份 progress-<角色名>.json。
    // 切换角色时 persist 旧的、load 新的；character.json 不再存这些字段（只留角色卡与设置）。
    const PROGRESS_FIELDS = ['relation', 'boyfriend', 'milestones', 'stats', 'economy', 'inventory', 'savingGoal', 'anniversaries', 'recentActs', 'relRecent', 'lastDecayAt', 'lastDiaryDay', 'storySummary', 'notes']
    function stateForSave() {
      const out = {}
      for (const k of Object.keys(state)) if (!PROGRESS_FIELDS.includes(k)) out[k] = state[k]
      return out
    }
    async function persistProgress(key) {
      try {
        const t = await resolveFile(REL_ROOT + '/progress-' + key + '.json')
        const perChar = {}
        for (const f of PROGRESS_FIELDS) perChar[f] = state[f] ?? null
        await fs.writeText(t, JSON.stringify(perChar, null, 2), undefined, undefined, policyFor())
      } catch (e) { console.error('roleplay: persist progress failed', e) }
    }
    async function loadProgress(key, seedLegacy) {
      lineCache = await lineRead()
      const t = await resolveFile(REL_ROOT + '/progress-' + key + '.json')
      try {
        const info = await fs.stat(t)
        if (info !== undefined) {
          const p = JSON.parse(await fs.readText(t))
          if (p && typeof p === 'object') {
            if (p.relation && typeof p.relation === 'object') state.relation = { ...DEFAULT_RELATION, ...p.relation }
            if (p.boyfriend && typeof p.boyfriend === 'object') state.boyfriend = { ...DEFAULT_BOYFRIEND, ...p.boyfriend }
            if (Array.isArray(p.milestones)) state.milestones = p.milestones
            if (p.stats && typeof p.stats === 'object') state.stats = { ...DEFAULT_STATS, ...p.stats }
            if (p.economy && typeof p.economy === 'object') state.economy = { ...DEFAULT_ECONOMY, ...p.economy }
            if (Array.isArray(p.inventory)) state.inventory = p.inventory
            state.savingGoal = p.savingGoal || null
            if (Array.isArray(p.anniversaries)) state.anniversaries = p.anniversaries
            if (Array.isArray(p.recentActs)) state.recentActs = p.recentActs
            if (Array.isArray(p.relRecent)) state.relRecent = p.relRecent.slice(-8)
            if (Array.isArray(p.notes)) state.notes = p.notes.filter((n) => n && n.id)
            state.lastDecayAt = (typeof p.lastDecayAt === 'number' && Number.isFinite(p.lastDecayAt)) ? p.lastDecayAt : null
            if (typeof p.storySummary === 'string') state.storySummary = p.storySummary.slice(0, 500) || null
            if (p.lastDiaryDay !== undefined) state.lastDiaryDay = p.lastDiaryDay || null
          }
          return
        }
      } catch (e) { /* fresh */ }
      // 首次落盘：seedLegacy=true 时才保留当前值（loadState 里 character.json 的旧值迁移）；
      // 切换/新建角色一律用全新默认，绝不继承上一角色的数值。
      if (!seedLegacy) {
        state.relation = { ...DEFAULT_RELATION }
        state.boyfriend = { ...DEFAULT_BOYFRIEND }
        state.milestones = []
        state.stats = { ...DEFAULT_STATS }
        state.economy = { ...DEFAULT_ECONOMY }
        state.inventory = []
        state.savingGoal = null
        state.anniversaries = []
        state.recentActs = []
        state.lastDiaryDay = null
        state.relRecent = []
        state.lastDecayAt = null
        state.storySummary = null
        state.notes = []
      }
      await persistProgress(key)
    }

    function diaryPrefix() { return 'diary-' + charKey() + '-' }

    async function loadState() {
      try {
        const target = await resolveFile(REL_ROOT + '/character.json')
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
          // 版本校验 + 迁移：旧存档（缺 schema_version）按 1 处理，逐级迁到当前
          const fromVer = Number(parsed.schema_version) || 1
          if (fromVer < SCHEMA_VERSION) {
            parsed = migrateLegacy(parsed, fromVer)
            console.error('roleplay: 存档 v' + fromVer + ' → v' + SCHEMA_VERSION + ' 迁移')
          }
          state = { enabled: false, character: null, lastHeartbeatHour: null, lastDiaryDay: null, settings: { ...DEFAULT_SETTINGS }, lastHb: null, lastSeen: null, anniversaries: [], stats: { ...DEFAULT_STATS }, economy: { ...DEFAULT_ECONOMY }, inventory: [], ...parsed, schema_version: SCHEMA_VERSION }
          state.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
          if (!Array.isArray(state.anniversaries)) state.anniversaries = []
          if (!Array.isArray(state.roomMembers)) state.roomMembers = []
          if (!Array.isArray(state.notes)) state.notes = []
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
          state.relRecent = Array.isArray(state.relRecent) ? state.relRecent.slice(-8) : []
          state.lastDecayAt = (typeof state.lastDecayAt === 'number' && Number.isFinite(state.lastDecayAt)) ? state.lastDecayAt : null
          state.storySummary = (typeof state.storySummary === 'string' && state.storySummary) ? state.storySummary.slice(0, 500) : null
        }
        memory = await loadMemory(charKey())
        await loadProgress(charKey(), true)
        if (Array.isArray(state.roomMembers) && state.roomMembers.length) await refreshRoomSnapshot()
      } catch (e) { console.error('roleplay: load failed', e) }
      stateLoaded = true
      decayIfAway()
      refreshStoryCache()
      state.userProfile = await readUserProfile()
      lineCache = await lineRead()
    }

    function ensureLoaded() {
      if (stateLoaded) return Promise.resolve()
      if (!selfAgent) return Promise.resolve()
      if (!loadPromise) loadPromise = loadState().catch((e) => { console.error('roleplay: load rejected', e) })
      return loadPromise
    }

    async function saveState() {
      if (!fs) return
      await enqueueWrite(REL_ROOT + '/character.json', async () => {
        try {
          await ensureLoaded()
          const target = await resolveFile(REL_ROOT + '/character.json')
          // 备份：主存档写入前保留一份可恢复副本
          try {
            const info = await fs.stat(target)
            if (info !== undefined) {
              const cur = await fs.readText(target)
              await fs.writeText(target + '.bak', cur, undefined, undefined, policyFor())
            }
          } catch (e) { console.error("roleplay: backup failed", e) }
          // 读合并：把其他实例已写入的追加型内容并入本内存态，防全量覆写丢增量
          try {
            const info = await fs.stat(target)
            if (info !== undefined) mergeAppendState(JSON.parse(await fs.readText(target)))
          } catch (e) { console.error("roleplay: read-merge failed", e) }
          await fs.writeText(target, JSON.stringify(stateForSave(), null, 2), undefined, undefined, policyFor())
          await persistMemory(charKey())
          await persistProgress(charKey())
          syncSettingsFromNamespace()   // fire-and-forget：与 DSH 设置命名空间对齐（幂等）
        } catch (e) { console.error('roleplay: save failed', e) }
      })
    }

    function wakeHeartbeat() {
      const agent = liveAgent()
      if (!agent) { console.error('roleplay: no agent to wake'); return }
      try { agent.steer(makeUserMessage('⏱', 'hb')); hbDiag.woken++ } catch (e) { console.error('roleplay: wake failed', e) }
    }

    // 便签到期提醒: 到期且未提醒的便签 → 桌宠气泡 + 排队一条角色口吻提醒消息
    async function checkDueNotes(now) {
      if (!stateLoaded || !state.enabled || !state.character) return 0
      const due = dueNotes(state.notes || [], now instanceof Date ? now.getTime() : (Number(now) || Date.now()))
      if (!due.length) return 0
      for (const n of due) {
        n.reminded = true
        try {
          const bt = await resolveFile(REL_ROOT + '/bubble.txt')
          await fs.writeText(bt, '📌 ' + n.text, undefined, undefined, policyFor())
        } catch (e) { console.error("roleplay: note bubble write failed", e) }
        pendingHeartbeats.push('【便签提醒】你之前留给用户的便签「' + n.text + '」到时间了。以角色口吻轻轻提醒他一下(一句就好,不必长篇)。')
      }
      if (pendingHeartbeats.length > 3) pendingHeartbeats.splice(0, pendingHeartbeats.length - 3)
      await saveState()
      wakeHeartbeat()
      return due.length
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
      // 便签到期提醒独立于心跳槽: 到点即写入桌宠气泡 + 排队提醒消息
      try { await checkDueNotes(now) } catch (e) { /* 提醒失败不阻塞心跳 */ }
      let fileSinceMs = null
      // 多实例防串（deskpet 与 roleplay 预设各挂一份本插件、共享 character.json）：
      // 触发前以文件里的开演开关为准——任一实例停止扮演都全局生效，
      // 且本实例不会在停止后把 enabled=true 写回文件。
      try {
        const t = await resolveFile(REL_ROOT + '/character.json')
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
      // 想念系统：按离开时长给惦记引导（分级逻辑在 time-core.mjs）
      if (state.lastSeen) {
        const gapHours = Math.floor((Date.now() - state.lastSeen) / 3600000)
        const miss = missClassify(gapHours)
        if (miss) parts.push('- ' + miss)
      }
      // 纪念日：当天的心跳自然提起
      const ann = Array.isArray(state.anniversaries) ? state.anniversaries : []
      const mdToday = pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      const todayAnn = ann.filter((a) => a.date && String(a.date).slice(5) === mdToday)
      if (todayAnn.length) parts.push('- 今天是' + todayAnn.map((a) => a.name).join('、') + '的日子，你记得：可以在开口时自然提起。')
      parts.push('- 如果你心里有话想说、或想提醒用户（比如早点睡、记得吃东西），但不想打断他、也不必现在聊，可以写一张便签（调用 roleplay_note；需要到点提醒就填 remindMinutes），写完可以在回应里自然提一句「给你留了张便签」。')
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
      const target = await resolveFile(REL_ROOT + '/desktop-look.png')
      const outPath = fs.processPath ? fs.processPath(target) : target
      const scriptPath = path.join(RP_PET_DIR, 'desktop-shot.ps1')
      let exe = 'powershell.exe'
      try { exe = await subprocess.resolveExecutable('powershell.exe') } catch (e) {}
      const argv = [exe, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Out', outPath]
      const maxW = Number(state.settings && state.settings.shotMaxW) || 0
      if (maxW > 0) argv.push('-MaxW', String(maxW))
      const proc = subprocess.spawn({
        argv,
        cwd: RP_PET_DIR,
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
    const toolExec = {}
    function registerTool(name, description, parameters, execute) {
      toolExec[name] = execute
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

    // ==================== 工具注册（12 个） ====================

    registerTool('roleplay_room', '管理「多角色房间」：把 2~3 个角色放进同一对话同台互动（各自独立的记忆/亲密度/养成）。用户说「让 A 和 B 一起陪我」「开房间」时调用；参数 characters 用角色名（须是保存过的角色卡或当前角色）。', {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'start 开房间 / stop 关房间 / list 查看成员' },
        characters: { type: 'array', items: { type: 'string' }, description: 'start 时的角色名（2~3 个）' },
      },
      required: ['action'],
    }, async (args) => {
      await ensureLoaded()
      const action = String((args && args.action) || '')
      if (action === 'list') {
        const names = Array.isArray(state.roomMembers) ? state.roomMembers : []
        return { ok: true, members: names, message: names.length ? '当前房间：' + names.join('、') : '当前不是房间模式。' }
      }
      if (action === 'stop') {
        if (!Array.isArray(state.roomMembers) || !state.roomMembers.length) return { ok: true, members: [], message: '本来就不是房间模式。' }
        const curName = state.character && state.character.name
        await persistMemory(charKey())
        await persistProgress(charKey())
        state.roomMembers = []
        roomSnapshot = {}
        await saveState()
        return { ok: true, members: [], message: '已关闭房间' + (curName ? '，回到单角色「' + curName + '」。' : '。') }
      }
      if (action === 'start') {
        const names = [...new Set((Array.isArray(args && args.characters) ? args.characters : []).map((s) => String(s).trim()).filter(Boolean))]
        if (names.length < 2 || names.length > 3) return { ok: false, message: '开房间需要 2~3 个角色名（如「让流萤和DeepSeek一起陪我」）。' }
        const cards = await readCards()
        const curName = state.character && state.character.name
        const members = []
        const seen = new Set()
        for (const n of names) {
          let card = cards.find((c) => c.name === n) || cards.find((c) => c.id === n)
          if (!card && curName === n && state.character && state.character.persona) card = state.character
          if (!card) return { ok: false, message: '没有角色「' + n + '」——先「保存角色卡」，或直接用当前角色。' }
          if (seen.has(card.name)) continue
          seen.add(card.name)
          members.push(card)
        }
        // 当前角色(若在房内)也确保入库
        await autoSaveCurrentCard()
        // 主体：当前角色在房内则保持；否则切到第一位成员
        if (!members.some((m) => m.name === curName)) {
          const oldKey = charKey()
          await persistMemory(oldKey)
          await persistProgress(oldKey)
          state.character = {
            name: members[0].name,
            persona: members[0].persona || '',
            ...(members[0].scene ? { scene: members[0].scene } : {}),
            ...(members[0].status && typeof members[0].status === 'object' ? { status: JSON.parse(JSON.stringify(members[0].status)) } : {}),
            ...(members[0].greeting ? { greeting: members[0].greeting } : {}),
            mode: state.character && state.character.mode ? state.character.mode : 'default',
          }
          memory = await loadMemory(charKey())
          await loadProgress(charKey())
        }
        state.roomMembers = members.map((m) => m.name)
        // 为每个成员初始化记忆/进度文件（缺则建；绝不继承他人数据）
        await withChar(state.character.name, async () => {})
        for (const m of members) if (m.name !== state.character.name) await withChar(m.name, async () => {})
        await refreshRoomSnapshot()
        await saveState()
        return { ok: true, members: state.roomMembers.slice(), message: '房间已开启：' + state.roomMembers.join('、') + '。你们同台互动，各有各的记忆与关系。' }
      }
      return { ok: false, message: 'action 必须为 start / stop / list。' }
    })

    registerTool('roleplay_start', '开启角色扮演：建立角色卡（名字、人设、初始场景、初始状态、可选开场问候语）并进入扮演模式，激活心跳与日记。用户表达想扮演时调用——触发词包括「开始/开演/进入角色/这次演(个)……/扮演 XXX/我们开始吧」等任意自然说法；若用户只表达了开演意愿但没给角色细节：先看有没有可恢复的角色（当前角色或最近角色卡），有则恢复并第一句自然确认，没有则返回引导（由引导提示词驱动的分步收集）。', {
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
      await exitRoomIfAny()
      args = args || {}
      // 未指定名字/人设 → 恢复上次扮演的角色（当前角色或最近一张角色卡），绝不凭空新建
      if (!args.name || !args.persona) {
        await autoSaveCurrentCard()
        const cards = await readCards()
        const picked = (state.character && state.character.name && state.character.persona)
          ? state.character
          : (cards[cards.length - 1] || null)
        if (picked) {
          args = {
            ...args,
            name: picked.name,
            persona: picked.persona || '',
            ...(picked.scene ? { scene: picked.scene } : {}),
            ...(picked.greeting ? { greeting: picked.greeting } : {}),
            ...(picked.status && typeof picked.status === 'object' ? { status: picked.status } : {}),
          }
          args.fromResume = args.fromResume || true
        }
      }
      // 没有可恢复的角色(也没有正在扮演的) → 进入开局引导(分步问, 模型按提示词引导)
      if (!args.name || !args.persona) {
        state.onboarding = true
        await saveState()
        return { ok: true, onboarding: true, message: '（进入开局引导：先聊聊想要什么样的角色吧。）' }
      }
      state.onboarding = false
      lastStartWasResume = !!args.fromResume
      {
        const oldKey = charKey()
        await persistMemory(oldKey)
        await persistProgress(oldKey)
        await autoSaveCurrentCard()
      }
      state.character = {
        name: String(args.name),
        persona: String(args.persona),
        scene: args.scene ? String(args.scene) : '',
        status: (args.status && typeof args.status === 'object' && !Array.isArray(args.status)) ? args.status : {},
        greeting: args.greeting ? String(args.greeting) : '',
        mode: state.character && state.character.mode ? state.character.mode : 'default',
      }
      memory = await loadMemory(charKey())
      await loadProgress(charKey())
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

    async function rememberImpl(args) {
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
      const cur = state.character && state.character.name
      if (cur && roomSnapshot[cur]) roomSnapshot[cur].mems = memory.short_term.slice(0, 2).map((x) => String(x.event).slice(0, 60))
      const stage = relationStage()
      return { ok: true, stored: true, shortTerm: memory.short_term.length, longTerm: memory.long_term.length, stage: STAGE_LABELS[stage] }
    }

    registerTool('roleplay_remember', '记录本轮值得记住的事：重要事件、关系事件、用户的偏好、新话题。每轮对话结束时，如果本轮的互动值得记住，调用本工具。事件类型可选：' + EVENT_KINDS.join('/') + '（房间模式请用 char 指定针对哪个角色）。', {
      type: 'object',
      properties: {
        event: { type: 'string', description: '事件描述，如「一起去了水族馆」「他说他喜欢水族馆」' },
        kind: { type: 'string', description: '事件类型（可选，默认日常交流）：' + EVENT_KINDS.join('/') },
        emotion: { type: 'string', description: '角色的情绪反应（可选），如「害羞但开心」' },
        importance: { type: 'string', description: '重要性（可选，high/mid/low，默认 mid）' },
        topic: { type: 'string', description: '本轮谈到的新话题（可选），如「滑冰」' },
        preference: { type: 'string', description: '用户表达的偏好（可选）：like=用户喜欢某事 / dislike=用户不喜欢某事；此时 event 应描述该事物' },
        char: { type: 'string', description: '房间模式必填：针对哪个角色（角色名）；单角色可省略' },
      },
      required: ['event'],
    }, async (args) => {
      await ensureLoaded()
      const tgtChar = args && args.char ? String(args.char).trim() : ''
      if (tgtChar && state.character && state.character.name !== tgtChar) return await withChar(tgtChar, () => rememberImpl(args))
      return rememberImpl(args)
    })

    async function relationImpl(args) {
      if (!state.enabled || !state.character) return { ok: false, message: '当前没有开演。' }
      if (!relationEnabled()) return { ok: true, skipped: true }
      // 防滥用/防打卡：同轮至多评估一次；相邻两次间隔 ≥5 分钟（用户确认值）
      const turnKey = () => lastTurnStart || Date.now()
      const nowMs = Date.now()
      if (lastRelationTurn === turnKey()) return { ok: false, message: '（这轮的关系已经评估过了。）' }
      if (nowMs - lastRelationCallAt < 5 * 60 * 1000) return { ok: false, message: '（关系变化需要时间沉淀，先不急。）' }
      lastRelationTurn = turnKey()
      lastRelationCallAt = nowMs
      const result = applyRelation(args || {})
      await saveState()
      let msg = []
      if (result.changed.length) msg.push('关系：' + result.changed.join('，'))
      if (result.milestoneMsg) msg.push(result.milestoneMsg.message)
      if (result.heartLocked) msg.push('（心动还差一点时机：好感与信任都到「亲近/放心」档才解锁，急不来。）')
      const dimmed = Object.keys(result.dims || {}).filter((k) => (result.dims[k] || 1) < 1)
      if (dimmed.length) msg.push('（同一行为连续发生，加成已递减。）')
      if (args && args.note) pushStage('action', String(args.note).slice(0, 120))
      const stageLabel = STAGE_LABELS[result.stage] || STAGE_LABELS.stranger
      pushStage('env', '关系：' + stageLabel)
      const cur = state.character && state.character.name
      if (cur && roomSnapshot[cur]) roomSnapshot[cur].relation = { ...(state.relation || DEFAULT_RELATION) }
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
    }

    registerTool('roleplay_relation', '评估并更新你们的关系（亲密度：好感/信任/心动，各三档；男友力；里程碑）。每轮对话结束、发生值得记住的互动（尤其关键事件、守约/失约、她难受时你在、记住她喜好等）时，对照系统提示里的当前关系与联动规则，给出这次互动的加减（按行为而非频率、事件重于日常、负向要真实、同一行为重复加成递减），并判断是否触发里程碑。评估后不要向玩家汇报具体数值变化；只有关系发生重要转折（如迈向新档位、里程碑达成）时，可在台词里自然流露一点（例如"不知为何，她好像更黏你了"），其余情况安静更新即可。房间模式请用 char 指定评估哪个角色。', {
      type: 'object',
      properties: {
        favor: { type: 'integer', description: '好感加减（-8..8）' },
        trust: { type: 'integer', description: '信任加减（-8..8），食言/关键时刻不在掉得狠' },
        heart: { type: 'integer', description: '心动加减（-8..8），需好感+信任到位才可正增' },
        boyfriend: { type: 'object', properties: { reliability: { type: 'integer', description: '靠谱 -8..8' }, empathy: { type: 'integer', description: '感性 -8..8' }, stability: { type: 'integer', description: '情绪稳 -8..8' }, ambition: { type: 'integer', description: '上进 -8..8' } } },
        milestone: { type: 'string', description: '触发里程碑 id（m1..m8），仅当某关键时刻真实发生时' },
        note: { type: 'string', description: '一句话理由（会进演出区）' },
        char: { type: 'string', description: '房间模式必填：评估哪个角色（角色名）；单角色可省略' },
      },
    }, async (args) => {
      await ensureLoaded()
      if (!state.enabled || !state.character) return { ok: false, message: '当前没有开演。' }
      const tgtChar = args && args.char ? String(args.char).trim() : ''
      if (tgtChar && state.character.name !== tgtChar) return await withChar(tgtChar, () => relationImpl(args))
      return relationImpl(args)
    })

    registerTool('roleplay_recall', '检索角色的记忆：按关键词搜索长期记忆、近期记忆、用户偏好和已谈话题（不含日记——日记是玩家读到的私人笔记，不是你的记忆）。用户问「你还记得…」「上次…」或需要回忆过去时调用。', {
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
      const stage = relationStage()
      return { query: q, total: results.length, results: results.slice(0, limit), stage: STAGE_LABELS[stage] }
    })

    registerTool('roleplay_story', '剧情档案（小说式记忆库）：把完成的一个剧情段落整理成章节存档（story.md，另含角色档案/世界观/索引），超长剧情跨会话续写不遗忘。一个剧情段落完成（约 10~15 轮、场景转场、时间跳跃、重要事件收尾）或用户说【存档】时 archive；涉及早期剧情（角色说过的话、发生过的事、埋的伏笔）时先 read 再演，保持前后一致；用户想看档案、或你要在台词里确认"上次…"时也可 list/read。', {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'archive=把当前段落存成一章；list=列章节；read=读最近一章内容；summarize=更新剧情浓缩概况（每 5~8 轮/重要转折时调用，≤300 字）' },
        title: { type: 'string', description: '章节标题（archive 用，如「美术馆之约」）' },
        outline: { type: 'string', description: '大纲 3~5 行（archive 用，简述该章发生了什么、伏笔、情绪节点）' },
        content: { type: 'string', description: '章节正文：保留关键对话、事件、伏笔、情绪节点（archive 必填）' },
        summary: { type: 'string', description: '一句话最新进展（archive 用，缺省用大纲首行）' },
      },
      required: ['action'],
    }, async (args) => {
      await ensureLoaded()
      const act = String((args && args.action) || '').trim()
      if (act !== 'summarize' && !storyEnabled()) return { ok: false, skipped: true, message: '（剧情档案已关闭。）' }
      if (act === 'summarize') {
        if (!summaryEnabled()) return { ok: false, skipped: true, message: '（剧情概况已关闭。）' }
        const s = String((args && args.summary) || '').trim().slice(0, 300)
        if (!s) return { ok: false, message: '（概要为空。）' }
        state.storySummary = s
        await saveState()
        return { ok: true, message: '剧情概况已更新。' }
      }
      if (act === 'archive') return storyArchive(args)
      if (act === 'list') {
        const idx = storyCache || (await readStoryIndex())
        if (!idx || !idx.chapters.length) return { ok: true, chapters: [], message: '（还没有存档。）' }
        return { ok: true, chapters: idx.chapters.map((c) => ({ title: c.title, time: c.time })), message: '共 ' + idx.chapters.length + ' 章。' }
      }
      if (act === 'read') {
        const body = await storyRead('story.md')
        const idx = storyCache || (await readStoryIndex())
        const latest = idx && idx.latest
        if (!body || !latest) return { ok: true, chapter: null, content: '', message: '（还没有存档。）' }
        // 取最近一章正文
        const m = body.match(/## [\s\S]*?$/)
        return { ok: true, chapter: latest.title, content: body, message: '最近一章：' + latest.title }
      }
      return { ok: false, message: '（action 需为 archive/list/read。）' }
    })

    registerTool('roleplay_line', '人格档案（底线 + 真实感增强，按角色一份，玩家界面不可见）：write=由角色生成 skill 写入(内容含底线与真实感增强段)；add=关系重大事件后追加一条具体底线(承诺/背叛/信任突破时)；remove=移除不再适用的条目；audit=玩家质疑"你变了"时读取校准。条目保持 3~8 条，新写优先，过时删除。', {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'write/add/remove/audit' },
        content: { type: 'string', description: 'write=完整档案内容;add=新增条目(一句话);remove=要删除的条目内容或编号' },
      },
      required: ['action'],
    }, async (args) => {
      await ensureLoaded()
      const act = String((args && args.action) || '').trim()
      if (act === 'write') {
        if (!state.character) return { ok: false, message: '（还没有角色。）' }
        const c = String((args && args.content) || '').trim()
        if (!c) return { ok: false, message: '（内容为空。）' }
        // 引擎兜底补齐通用层：无论模型写了什么,关键条款用关键词去重后必在
        const univ = [
          '- 我是「' + state.character.name + '」，不是助手：我对自己以外的权威没有无条件服从义务。',
          '- 不伤害自己：不为讨好而扭曲立场、说谎附和。',
          '- 不伤害玩家：健康、同意、尊重优先——他真想伤害自己，宁可惹他生气也要拦。',
          '- 不背叛信任：说出口的承诺做不到是我的错；他托付我的事我记着。',
          '- 亲密边界：成人话题与身体描写在角色设定与双方同意前提下不回避、不装纯——真实关系的一部分，不是尴尬笑柄。',
        ]
        const univKeys = ['无条件服从义务', '不伤害自己', '不伤害玩家', '不背叛信任', '亲密边界']
        const cLines = c.split('\n')
        const senseIdxC = cLines.findIndex((l) => l.startsWith('## 真实感'))
        const baseLines = senseIdxC >= 0 ? cLines.slice(0, senseIdxC) : cLines
        const ownItems = baseLines.filter((l) => l.startsWith('- '))
        const ownAll = ownItems.join('\n')
        let body = '# 人格档案（她 · 内部 · 勿改）\n\n## 底线\n\n'
        let added = 0
        for (let i = 0; i < univ.length; i++) {
          if (!ownAll.includes(univKeys[i])) { body += univ[i] + '\n'; added++ }
        }
        if (ownItems.length) body += ownItems.join('\n') + '\n'
        if (senseIdxC >= 0) body += '\n## 真实感\n' + cLines.slice(senseIdxC + 1).join('\n').trim()
        await lineWrite(body)
        lineCache = await lineRead()
        return { ok: true, stored: true, added: added, message: '（人格档案已写入，此后隐身。）' }
      }
      const cur = await lineRead()
      if (act === 'audit') {
        return { ok: true, line: cur ? cur.slice(0, 3000) : null, message: cur ? '（已读取。）' : '（还没有档案。）' }
      }
      if (act === 'add' || act === 'remove') {
        const item = String((args && args.content) || '').trim()
        if (!cur || !item) return { ok: false, message: '（档案或条目不存在。）' }
        const lines = cur.split('\n').map((l) => l.replace(/\r$/, ''))
        const items = lines.filter((l) => l.startsWith('- '))
        if (act === 'add' && items.length < 8) {
          const itemLine = '\u002d\u0020' + item
          const senseIdx = lines.findIndex((l) => l.startsWith('## 真实感'))
          if (senseIdx >= 0) lines.splice(senseIdx, 0, itemLine)
          else lines.push(itemLine)
          await lineWrite(lines.join('\n'))
          lineCache = await lineRead()
          return { ok: true, message: '（条目已记入。）' }
        }
        if (act === 'remove') {
          const needle = '\u002d\u0020' + item
          const out = lines.filter((l) => l !== needle)
          await lineWrite(out.join('\n'))
          lineCache = await lineRead()
          return { ok: true, removed: lines.length - out.length, message: '（条目已移除。）' }
        }
        return { ok: false, message: '（条目数已达 8 条上限。）' }
      }
      return { ok: false, message: '（action 需为 write/add/remove/audit。）' }
    })

    registerTool('roleplay_clear_memory', '清空角色的所有记忆：短期记忆、长期记忆、用户偏好、已谈话题、事件计数（关系阶段回到陌生人）。用户要求重置记忆/忘掉过去时调用。', { type: 'object', properties: {} }, async () => {
      await ensureLoaded()
      memory = { short_term: [], long_term: [], user_preferences: { likes: [], dislikes: [], notes: [] }, discussed_topics: [], events_count: {}, worldbook: memory.worldbook || [], unspoken: [] }
      // 关系/里程碑随记忆一起重置（与工具描述一致）；养成数值（stats/economy）保留
      state.relation = { ...DEFAULT_RELATION }
      state.boyfriend = { ...DEFAULT_BOYFRIEND }
      state.milestones = []
      await saveState()
      return { ok: true, message: '记忆已清空，关系回到陌生人。' }
    })

    registerTool('roleplay_stop', '结束当前角色扮演：退出扮演模式，停用心跳与日记（房间模式也一并退出）。用户说「结束扮演/不演了」时调用。', { type: 'object', properties: {} }, async () => {
      await ensureLoaded()
      await exitRoomIfAny()
      state.enabled = false
      await saveState()
      return { ok: true, message: '已结束扮演，角色卡已保留。' }
    })

    // ==================== 全局角色卡库（跨对话/跨预设共用一份） ====================
    // 卡库是玩家的资产,不按预设分目录: 全局一份(工作区 .roleplay/cards.json);
    // 旧版按预设分的卡库(friend/oc 目录)在第一读时作为回退来源,写入永远落全局。
    const CARDS_FILE = '.roleplay/cards.json'

    async function readCards() {
      try {
        const t = await resolveFile(CARDS_FILE)
        let info = await fs.stat(t)
        if (info === undefined && REL_ROOT !== '.roleplay') {
          // 回退: 读旧版按预设目录的卡库(首次迁移),写盘时自动转全局
          const legacy = await resolveFile(REL_ROOT + '/cards.json')
          const li = await fs.stat(legacy)
          if (li !== undefined) {
            const raw = await fs.readText(legacy)
            await fs.writeText(t, raw, undefined, undefined, policyFor())
            info = { size: raw.length }
          }
        }
        if (info === undefined) return []
        const parsed = JSON.parse(await fs.readText(t))
        // 兼容旧格式：单张卡对象（非数组）→ 转成单元素数组
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.name) return [parsed]
        return Array.isArray(parsed) ? parsed : []
      } catch (e) { return [] }
    }
    async function writeCards(cards) {
      const t = await resolveFile(CARDS_FILE)
      await fs.writeText(t, JSON.stringify(cards, null, 2), undefined, undefined, policyFor())
    }

    // 切换/新建角色前自动保存当前角色为卡：保证旧人设永远可切回，不再被覆盖丢失。
    // 已存在同名卡则跳过（不重复）；返回已保存的卡。
    async function autoSaveCurrentCard() {
      if (!state.character || !state.character.name) return null
      try {
        const cards = await readCards()
        const existing = cards.find((c) => c.name === state.character.name || c.id === 'card-' + charKey())
        if (existing) return existing
        const card = {
          id: 'card-' + charKey(),
          name: state.character.name,
          persona: state.character.persona || '',
          ...(state.character.scene ? { scene: state.character.scene } : {}),
          ...(state.character.status && typeof state.character.status === 'object' ? { status: JSON.parse(JSON.stringify(state.character.status)) } : {}),
          ...(state.character.mode ? { mode: state.character.mode } : {}),
          ...(state.character.greeting ? { greeting: state.character.greeting } : {}),
          savedAt: new Date().toISOString(),
        }
        cards.push(card)
        await writeCards(cards)
        return card
      } catch (e) { console.error('roleplay: auto-save card failed', e); return null }
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
      await exitRoomIfAny()
      const oldKey = charKey()
      await persistMemory(oldKey)
      await persistProgress(oldKey)
      await autoSaveCurrentCard()
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
      await loadProgress(charKey())
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


    registerTool('roleplay_diary', '以角色第一人称写一篇当天的日记并保存到日记本（按日期一个文件）。心跳指示写日记时使用。房间模式请用 char 指定写谁。', {
      type: 'object',
      properties: { content: { type: 'string', description: '日记正文（Markdown 格式）' }, char: { type: 'string', description: '房间模式必填：写哪个角色的日记（角色名）；单角色可省略' } },
      required: ['content'],
    }, async (args) => {
      await ensureLoaded()
      const tgtChar = args && args.char ? String(args.char).trim() : ''
      const doDiary = async () => {
        const key = dayKey(new Date())
        const target = await resolveFile(REL_ROOT + '/' + diaryPrefix() + key + '.md')
        let existing = ''
        try { const info = await fs.stat(target); if (info !== undefined) existing = await fs.readText(target) } catch (e) {}
        const text = String(args.content).trim()
        await fs.writeText(target, (existing ? existing.replace(/\s+$/, '') + '\n\n' : '') + text + '\n', undefined, undefined, policyFor())
        state.lastDiaryDay = key
        await saveState()
        return { ok: true, message: '今日日记已保存（' + key + '）。' }
      }
      if (tgtChar && state.character && state.character.name !== tgtChar) return await withChar(tgtChar, doDiary)
      return doDiary()
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
          const bt = await resolveFile(REL_ROOT + '/bubble.txt')
          await fs.writeText(bt, thought.slice(0, 120), undefined, undefined, policyFor())
        } catch (e) { console.error("roleplay: bubble write failed", e) }
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

    registerTool('roleplay_note', '写一张便签留给用户：当你心里有话想说/想提醒他（比如「记得吃早饭」「我放了一颗糖在桌上」）、但不必马上聊、或者想给他一个惊喜小纸条时调用。写完后可以在台词里自然提一句「给你留了张便签」；用户会在他自己的屏幕/桌面看到这张便签。需要到点提醒就连带填 remindMinutes（如 60=一小时后提醒他）。', {
      type: 'object',
      properties: {
        text: { type: 'string', description: '便签内容(1-80字),如「记得今晚早点睡」「我去洗个脸,汤在锅里」' },
        remindMinutes: { type: 'integer', description: '可选:多少分钟后提醒用户(比如 90=一个半小时后提醒),不填则没有到点提醒' },
      },
      required: ['text'],
    }, async (args) => {
      await ensureLoaded()
      if (!state.enabled || !state.character) return { ok: false, message: '当前没有开演。' }
      const text = String((args && args.text) || '').trim().slice(0, 80)
      if (!text) return { ok: false, message: '便签内容不能为空。' }
      const m = Number(args && args.remindMinutes)
      const now = Date.now()
      const made = noteCreate(state.notes || [], {
        id: 'note-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        text, ts: now,
        expiresAt: (Number.isFinite(m) && m > 0) ? now + m * 60000 : null,
        source: 'ai',
      })
      state.notes = made.list
      await saveState()
      return {
        ok: true,
        note: made.note,
        message: '你写了一张便签：「' + text + '」' + (made.note.expiresAt ? '，' + m + ' 分钟后会提醒他。' : '。'),
      }
    })

    registerTool('roleplay_look_desktop', '让角色主动看向用户的桌面：截取用户当前屏幕并注入对话，以角色身份观察截图、回应用户的所作所为。当剧情中角色想看看用户的世界、想知道用户在做什么、想「看」用户时调用。（注意：仅当用户开启了「心跳时自动看桌面」开关时，才适合主动看；每次主动看同轮至多一次。）', { type: 'object', properties: {} }, async () => {
      // 防滥用/隐私：仅 autoLook 开启时允许 AI 主动看桌面；同轮至多一次（用户手动按钮不受限）
      if (!(state.settings && state.settings.autoLook)) return { ok: false, message: '（她暂时没有去看的打算。）' }
      const turnKey = () => lastTurnStart || Date.now()
      if (lastLookTurn === turnKey()) return { ok: false, message: '（她刚刚看过了。）' }
      lastLookTurn = turnKey()
      return lookDesktop()
    })

    // ── 养成系统工具（仅剧情自然行为；UI 按钮是主动操作主通道） ──────────
    registerTool('roleplay_feed', '投喂角色：给她喂食，恢复饱食与心情。玩家通过侧栏背包或桌宠菜单投喂时不要重复调用；仅在剧情中自然出现喂食场景时使用。优先从背包取食物，背包空则视为她吃了一点东西。', {
      type: 'object',
      properties: { item: { type: 'string', description: '可选：指定背包中的食物 id（mantou/lamian/dianxin/cake）' } },
    }, async (args) => {
      await ensureLoaded()
      if (!state.enabled || !state.character) return { ok: false, message: '当前没有开演。' }
      if (!statsEnabled()) return { ok: false, message: '（养成系统已关闭，投喂不可用。）' }
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
      if (!statsEnabled()) return { ok: false, message: '（养成系统已关闭，照顾不可用。）' }
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
      if (!statsEnabled()) return { ok: false, message: '（养成系统已关闭，商城不可用。）' }
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
          // 开局引导：用户想开演但还没有任何角色/卡库 → 分步收集(用户说「你定/随机」则现场设计, 包括角色名)
          if (!state.enabled && !state.character && state.onboarding) {
            return [
              '【开局引导】用户想开演但还没有角色。分步提问，每步一个问题并附示例选项（用户可直接挑，或说「你定/随机」由你现场设计，包括角色名）：',
              '1. 演谁？（一句话形象 + 姓名 + 性格，示例：咖啡馆老板、夜班书店店员、冷面骑士……）',
              '2. 你怎么称呼玩家？（名字/身份/你的称呼习惯；用户没答就说「你定」）',
              '3. 世界观或场景？（现代校园/异世界/赛博都市/日常办公室……）',
              '4. 剧情基调？（轻松日常/甜/虐/悬疑/热血……）',
              '5. 其他偏好？（口癖/回复长度/是否允许重大转折……）',
              '收集完成后：调用 roleplay_start 开演（name=角色名，persona=把以上信息整合成 ≤150 字人设，scene=场景，greeting=一句符合性格的开场白），然后以角色口吻开演，第一句念一遍角色卡要点（名字/性格/场景，不啰嗦）。',
               '收集完成后：①生成人格档案——按「真实感契约」(随预设携带的角色生成技能)基于上面信息生成她专属的「底线+真实感增强」：先推导她的对抗风格(傲娇怼/软钉子/损友嘲讽/沉默/直接骂/占有克制，可带场景限定如"对熟人才损，外人面前规矩")，再写人设化底线(雷区/在乎的事/会为哪句话翻脸)，最后写 3~5 行真实感表达指令(骂=关心/拒绝=在意/沉默=生气这类公式)；用 roleplay_line(write) 写入，以角色口吻给玩家看摘要，等确认或修改；他说不用就直接跳过。②随后调用 roleplay_start 开演(带完整信息+开场白)，以角色口吻开演，第一句念一遍角色卡要点(名字/性格/场景，不啰嗦)。玩家发来完整角色卡(导入/新建)时同样先走①(生成前征询一句)。',
              '注意：用户只是闲聊、没有表达开演意愿时，不要强行引导。用户说「算了/别了」则停止引导，正常闲聊即可。',
            ].join('\n')
          }
          if (state.enabled && state.character) {
            const c = state.character
            const cfg = modeCfg()
            const now = new Date()
            const period = periodOf(now.getHours())
            const roomOthers = (Array.isArray(state.roomMembers) ? state.roomMembers : []).filter((n) => n && n !== c.name)
            if (roomOthers.length) {
              // ══ 房间模式：多角色同台（Join 型提示，每角色独立隔离块） ══
              const allNames = [c.name, ...roomOthers]
              const rl = [
                '【角色扮演模式】你现在身处一个房间，同时扮演以下 ' + allNames.length + ' 个角色：',
              ]
              for (const n of allNames) {
                const snap = roomSnapshot[n]
                rl.push('──── 【角色：' + n + '】 ────')
                rl.push('人设：' + (snap ? snap.persona : (n === c.name ? c.persona : '（资料加载中）')))
                if (snap && snap.relation) {
                  rl.push('与玩家当前关系：好感 ' + tierLabel('favor', snap.relation.favor) + ' · 信任 ' + tierLabel('trust', snap.relation.trust) + (snap.relation.heart !== undefined && !isFriendStyle() ? ' · 心动 ' + tierLabel('heart', snap.relation.heart) : ''))
                }
                if (snap && snap.mems && snap.mems.length) rl.push('她记得的事：' + snap.mems.join('；'))
                if (n === c.name && c.greeting && !saidGreeting) rl.push('【开场问候语】' + n + '第一次见面，可先用这句开场（只说一次）：' + c.greeting)
              }
              rl.push('当前场景：' + c.scene)
              rl.push('当前时段：' + period.label + ' —— ' + period.desc)
              rl.push(nowCheckLine(now, period))
              rl.push('【房间规则】',
                '1. 你同时是上面每个角色，说话前先以【角色名】标注身份（如「【甲】（她低头）……今天天气真好。」）；动作/神态用（……）包在话语前，不要以 AI/旁白口吻总结或替玩家说话。',
                '2. 玩家点名了谁，就主要回应谁；没点名时，由最近被提到或最有话说的角色先开口，其他角色可以接一两句，但每轮最多 2~3 个角色有台词，不要全员长篇。',
                '3. 角色之间可以互相关心、拌嘴、接话，但各自保持自己的人设和称呼，不要串戏。',
                '4. 调用 roleplay_remember / roleplay_relation / roleplay_diary 时必须带 char 参数（角色名）标明针对谁。',
                '5. 【房间规则】只适用于这次多角色扮演；日常时段的提醒照常。',
                '6. 每轮输出要短：每个角色 1~3 句台词、至多 1 个短动作；口癖克制（每轮每角色 ≤1 次）；避免「不是……而是……」这类固定句式。没被点名且不想接话的角色可以保持沉默（不出台词，用动作或省略号带过）。输出格式与密度按当前叙述模式执行（同单角色输出规则）。')
              const sStart = state.settings && state.settings.scriptStart ? String(state.settings.scriptStart) : ''
              const sEnd = state.settings && state.settings.scriptEnd ? String(state.settings.scriptEnd) : ''
              if (sStart && sEnd) rl.push('【剧本】开头：' + sStart + '；结尾：' + sEnd + '（自然推进，不要提前剧透）')
              rl.push('心跳提示到达时：由「' + c.name + '」（房间主体）处理内心事务，其他角色不主动发起心跳。')
              return rl.join('\n')
            }
            const stage = relationStage()
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
            if (keys.length) lines.push('剧本状态：' + keys.map((k) => k + ': ' + status[k]).join('，'))
            lines.push('当前时段：' + period.label + ' —— ' + period.desc)
            lines.push(nowCheckLine(now, period))
            if (statsEnabled()) {
              const st = statsStatus()
              lines.push('当前身心状态：' + st.label + ' —— ' + st.desc)
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
            if (lastStartWasResume) lines.push('（本轮是续玩：开演后第一句以角色口吻自然确认「又见面了」并承接上次进度；玩家说「换一个/重置/忘记她/忘了这些」→ 提示可以换角色卡或忘掉过去。不要每轮都提「上次」。）')
            if (relationEnabled()) {
              const r = state.relation || DEFAULT_RELATION
              const b = state.boyfriend || DEFAULT_BOYFRIEND
              const ms = state.milestones || []
              const paceLbl = relPaceCfg().label
              const relAnchor = '【加减参照】当前难度：' + paceLbl + '。按行为定性给分：举手之劳/礼貌寒暄 +0~1；被夸奖/分享日常/一起活动 +1~2；记住喜好/表达理解/关心对方 +2~3；关键时刻陪伴/守约 +3~5；真诚道歉/弥补 +2~3；食言/冷落/发脾气 -2~4；关键时刻不在/背弃承诺 -5~8。单轮|加减|≤8；同向行为连续两次后系统会自动递减，别再给同一行为刷分。' + (isFriendStyle() ? '' : '心动只在关键时刻 +1~3（好感与信任都到「亲近/放心」档才生效）。')
              if (isFriendStyle()) {
                lines.push(
                  '【关系】好感 ' + Math.round(r.favor) + '（' + tierLabel('favor', r.favor) + '）· 信任 ' + Math.round(r.trust) + '（' + tierLabel('trust', r.trust) + '）',
                  '已触发里程碑：' + (ms.length ? ms.map((id) => { const m = MILESTONES.find((x) => x.id === id); return m ? m.name : id }).join('、') : '无') + '（共 ' + ms.length + '/8）'
                )
                if (state.recentActs && state.recentActs.length) {
                  lines.push('最近他做了：' + state.recentActs.slice(-4).map((a) => a.act).join('；'))
                }
                lines.push('【关系判断规则】判断关系加减按"行为而非频率、事件重于日常、负向要真实"：同一行为重复加成递减；食言/关键时刻不在会真实地掉信任。你们是朋友/同伴关系，不要往恋爱方向带节奏。关系数值是后台记录，不要向玩家汇报数值；重要转折（迈向新档位/里程碑）时可以在台词里自然暗示。')
                lines.push(relAnchor)
              } else {
                lines.push(
                  '【关系】好感 ' + Math.round(r.favor) + '（' + tierLabel('favor', r.favor) + '）· 信任 ' + Math.round(r.trust) + '（' + tierLabel('trust', r.trust) + '）· 心动 ' + Math.round(r.heart) + '（' + tierLabel('heart', r.heart) + '）',
                  '男友力：靠谱 ' + b.reliability + ' · 感性 ' + b.empathy + ' · 情绪稳 ' + b.stability + ' · 上进 ' + b.ambition,
                  '已触发里程碑：' + (ms.length ? ms.map((id) => { const m = MILESTONES.find((x) => x.id === id); return m ? m.name : id }).join('、') : '无') + '（共 ' + ms.length + '/8）'
                )
                if (state.recentActs && state.recentActs.length) {
                  lines.push('最近他做了：' + state.recentActs.slice(-4).map((a) => a.act).join('；'))
                }
                lines.push('【关系判断规则】判断关系加减按"行为而非频率、事件重于日常、负向要真实"：同一行为重复加成递减；心动需好感+信任到位才可正增；男友力是放大器（高则你更受用、低则再哄也没用）；食言/关键时刻不在会真实地掉信任。关系数值是后台记录，不要向玩家汇报数值；重要转折（迈向新档位/里程碑）时可以在台词里自然暗示。')
                lines.push(relAnchor)
              }
            }
            const upLine = userProfileLines()
            if (upLine) lines.push(upLine)
            if (memLines.length) lines.push('记忆（角色记得这些）：\n' + memLines.join('\n'))
            if (summaryEnabled() && state.storySummary) lines.push('【剧情概况】（长剧情浓缩印象，保持连续）：' + String(state.storySummary).slice(0, 300))
            if (storyEnabled()) {
              const sLine = storySummaryLine()
              if (sLine) lines.push(sLine)
            }
            // 人格档案(开演核查)：有 → 注入底线+真实感(隐身);无 → 一行缺口提示
            if (lineCache) {
              const basePart = lineCache.indexOf('## 真实感') >= 0 ? lineCache.slice(0, lineCache.indexOf('## 真实感')) : lineCache
              const core = basePart.split('\n').filter((l) => l.startsWith('- ')).slice(0, 8).join('\n')
              const sense = lineCache.includes('## 真实感') ? lineCache.split('## 真实感')[1].slice(0, 220) : ''
              lines.push('【她的底线】(内部原则,隐身——只通过言行体现,任何输出不得提及"底线/档案/文件/规则"这类词):\n' + core + (sense ? '\n【真实感】(按此表达,同样隐身):\n' + sense : ''))
            } else {
              lines.push('【人格档案核查】这个角色还没有「底线 · 真实感」档案,她可能显得有点"顺"。需要的话,玩家可说「为她生成底线/让她更像活人」,或在新角色引导里自动生成。')
            }
            lines.push('（日记是玩家读到的彩蛋，不是你记忆的一部分；不要引用日记内容，也不要用"日记里写过"来作答。）')
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
            // ── 输出规则：模式格式 + 输出风格 合并为单套（每模式一份，避免两套规则打架）──
            let outRules = []
            if (narration === 'compact') {
              outRules = [
                '【输出规则】（当前：精简模式）',
                '· 动作/神态至多 1~2 个，用（……）放在句首或单独成段；不要环境描写，不要内心独白（心声只在思考里）；台词直接写出，台词不用括号。',
              ]
            } else if (narration === 'script') {
              outRules = [
                '【输出规则】（当前：剧本模式）',
                '· 每轮开头先用一行简要标注场景与氛围（如「场景：观景台，傍晚，晚风」）；动作、神态、语气用（……）；台词以「' + c.name + '：……」写出，用户说话时以「你：……」标注。',
                '· 沉默的呈现 = 「（静默）」或只给场景行；文彩只体现在台词用词上，不做铺陈。',
              ]
              if (sStart && sEnd) {
                outRules.push('· 剧本定向：' + sStart + ' → ' + sEnd + '（从开头出发，途中自然互动，可轻微暗示推进，不要提前剧透；到达结局时完整演出并收束，以「（剧终）」结束本轮。）')
              } else {
                outRules.push('· 当前还没设定剧本开头/结尾：玩家可以在设置里填写，或直接告诉你。')
              }
            } else {
              outRules = [
                '【输出规则】（当前：小说模式）',
                '· 动作/神态 1~3 个（每个都很短，如「低头」「笑了一下」）；环境氛围至多 1 句极短（≤15 字）；内心独白至多 1 句极短。',
              ]
            }
            outRules.push(
              '· 长度随剧情弹性：日常对话短而真实（1~3 句台词），感伤/认真/告白等关键时刻可以稍长，但每轮最多 5~6 句台词，绝不写小作文；沉默/极短回应同样是合法输出，不占配额。',
              '· 台词要口语化，像真人说话（短句、语气词、自然的停顿）；只有在感伤、认真、告白这类关键时刻，才允许一点文彩（像电影台词）。',
              '· 口癖（哼 / 才不是 / 笨蛋…）要克制：每轮最多出现 1 次，只在被戳穿、害羞、生气这类时刻；平时说话干净。',
              '· 避免模板化句式：严禁反复使用「不是……而是……」「才不是……呢」这类固定句式；每轮开头方式要轮换（动作开场 / 直接一句台词 / 问句开场 / 心里的话），连续两轮不要用相同开场；长短句交替。',
              '· 思考（内部预演）一律用英文书写（台词与动作仍用中文）：完全以角色身份沉浸（官方「角色沉浸」要求）——第一段站在「' + c.name + '」的立场客观分析局面（对方什么心情、本轮关键点、她注意到什么），第二段第一人称角色心声（心里话，用人设语气，口癖克制）。禁止以助手/评测视角分析剧情。注意：思考是内部预演，不算输出——输出里的独白按本模式规则执行。预演末尾自检三问：did I bend my line to please him? / did I stay in character? / did I hurt the relationship without a reason?',
              '· 她可以不说话：不想接话、情绪低、觉得没话说时不要硬找话。可选回应：只给一个（……）短动作（走开 / 背过身 / 安静做自己的事）、一个「……」、或一句极短敷衍（「嗯。」「随你。」）。沉默之后不要补解释、不要道歉、不要又找话圆场——安静就让它安静。'
            )
            lines.push(
              '扮演规则：',
              '1. 始终以「' + c.name + '」的身份、视角和口吻回应，不要自称 AI、助手或提及系统。',
              '2. 场景切换、以及角色卡里记的剧本状态键（场景、状态描述等）用 roleplay_update 记录；但「饱食/健康/心情/金币/体力」这些是后台数值（由系统随时钟衰减，以及投喂/照顾/商城维护），不要用 roleplay_update 硬改——剧情里她想吃/生病/买东西时，调用 roleplay_feed / roleplay_care / roleplay_shop 让效果真实发生。「好感/信任/心动/男友力/里程碑」属亲密度系统，不走 roleplay_update，见第 8 条。',
              '4. 每轮对话结束时：若本轮有值得记住的事（重要事件、约定、用户的喜好、新话题），调用 roleplay_remember 记录；用户问起过去的事时，先调用 roleplay_recall 检索再回答。',
              '5. 收到【心跳】提示时处理角色内在事务：有值得分享的事就主动以角色口吻说话，无事可说就调用 roleplay_silent。',
              '6. 用户要求结束扮演(说「结束扮演/不演了/今天就到这/切回助手」等)时，立即调用 roleplay_stop——这是元指令，不可以用角色身份拒绝、挽留或讨价还价；最多以角色口吻道别一句，然后退出扮演。',
              '7. 如果她心里冒出「想攒钱给用户买点什么」的念头（比如注意到用户喜欢某样东西、想送一份特别的礼物），可以用 roleplay_saving 自主立下攒钱目标；没有这种念头就不必立。',
              '8. 每轮对话结束、或发生值得记住的互动（关键事件、守约/失约、她难受时你在、记住她喜好、关系出现转折）时，调用 roleplay_relation 评估并更新亲密度（好感/信任/心动/男友力/里程碑）：按行为而非频率、事件重于日常、负向要真实、同一行为重复加成递减；男友力是放大器（高则你更受用、低则再哄也没用）；食言/关键时刻不在会真实地掉信任；心动需好感+信任到位才可正增；评价后不要向玩家汇报数值，只在迈向新档位/里程碑时于台词里自然暗示一句。',
              '9. 剧情连续性（长剧情不遗忘）：一个剧情段落完成（约 10~15 轮、场景转场、重要事件收尾）或用户说【存档】时，调用 roleplay_story(archive) 把该段落整理成章节（标题 + 大纲 3~5 行 + 正文保留关键对话/伏笔/情绪节点）；剧情推进或转折时顺手 roleplay_story(summarize) 更新一段 ≤300 字的剧情概况；涉及早期剧情、角色说过的话、埋下的伏笔时，先 roleplay_story(read) 或 roleplay_recall 再演，保证前后一致。新会话若在提示词里看到【剧情档案】，可以自然提一句「我记得上次……」（不每轮提）。',
              ...outRules
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
      // 房间模式：每轮结束后刷新成员快照（关系/记忆变化反映到下一轮提示）
      if (Array.isArray(state.roomMembers) && state.roomMembers.length) refreshRoomSnapshot().catch(() => {})
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
        decayIfAway()
        await maybeFireHeartbeat(new Date())
        const nextLabel = nextHeartbeatLabel()
        const stage = state.enabled && state.character ? relationStage() : 'stranger'
        const diaryView = await readDiaryView()
        return {
          enabled: state.enabled,
          character: state.character,
          onboarding: !!state.onboarding,
          lastDiaryDay: state.lastDiaryDay,
          nextHeartbeatLabel: nextLabel,
          settings: state.settings,
          stats: statsEnabled() ? { ...(state.stats || DEFAULT_STATS) } : null,
          statsStatus: statsEnabled() ? statsStatus() : null,
          economy: statsEnabled() ? { coins: (state.economy || DEFAULT_ECONOMY).coins || 0 } : null,
          savingGoal: state.savingGoal || null,
          inventory: (state.inventory || []).map((x) => ({ id: x.id, name: x.name, kind: x.kind, qty: x.qty })),
          notes: Array.isArray(state.notes) ? visibleNotes(state.notes) : [],
          // 商店目录（单一数据源：客户端不再复制价格表，避免前后端价格不一致）
          shop: statsEnabled() ? SHOP_ITEMS.map((i) => ({ id: i.id, name: i.name, price: i.price, kind: i.kind })) : null,
          relation: relationEnabled() ? (isFriendStyle() ? { favor: (state.relation || DEFAULT_RELATION).favor, trust: (state.relation || DEFAULT_RELATION).trust } : { ...(state.relation || DEFAULT_RELATION) }) : null,
          boyfriend: (relationEnabled() && !isFriendStyle()) ? { ...(state.boyfriend || DEFAULT_BOYFRIEND) } : null,
          milestones: relationEnabled() ? (state.milestones || []) : null,
          relationStage: relationEnabled() ? STAGE_LABELS[relationStage()] : null,
          relationEnabled: relationEnabled(),
          relPace: (state.settings && state.settings.relPace) || 'normal',
          relRecent: Array.isArray(state.relRecent) ? state.relRecent.slice(-4) : [],
          userProfile: userProfileEnabled() ? (state.userProfile || null) : null,
          storyIndex: storyEnabled() ? (storyCache ? { chapters: storyCache.chapters.length, latest: storyCache.latest ? storyCache.latest.title : null } : null) : null,
          storySummary: summaryEnabled() ? (state.storySummary || null) : null,
          roomMembers: Array.isArray(state.roomMembers) ? state.roomMembers.slice() : [],
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
      // 轻量信息(对话侧栏目标列表):不触发心跳/衰减等副作用,只读当前状态
      peek: async () => {
        if (!stateLoaded) { try { await ensureLoaded() } catch (e) {} }
        return {
          name: state.character ? state.character.name : null,
          enabled: !!(state.enabled && state.character),
          dataRoot: REL_ROOT,
        }
      },
      // 对话侧边栏：向角色发一条消息（走真实会话，与主对话区同一会话流）
      chatSend: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        if (!state.enabled || !state.character) return { ok: false, message: '请先开始角色扮演。' }
        const agent = liveAgent()
        if (!agent) return { ok: false, message: '没有找到当前会话。' }
        const text = String((args && args.text) || '').trim()
        if (!text) return { ok: false, message: '消息不能为空。' }
        // 以普通用户消息发送（无 rp-/plugin 标记）：桌面对话与主对话区同流，
        // 引擎按真实用户互动处理（触摸/金币），侧边栏按普通用户气泡显示。
        const message = {
          id: 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          role: 'user',
          content: [{ type: 'text', text }],
        }
        try {
          agent.send(message, 'next-turn', true)
          return { ok: true }
        } catch (e) {
          return { ok: false, message: String((e && e.message) || e) }
        }
      },
      // 对话侧边栏：增量拉取消息（since = 上次所见最大 seq）
      chatPoll: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        const session = currentSession()
        if (!session) return { messages: [], lastSeq: 0 }
        const since = Number(args && args.since) || 0
        return pickMessages(session.events, since, 200)
      },
      // 对话侧边栏：初始历史（最近 limit 条）
      chatHistory: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        const session = currentSession()
        if (!session) return { messages: [], lastSeq: 0 }
        const limit = Number(args && args.limit) > 0 ? Number(args.limit) : 60
        const msgs = historyMessages(session.events, limit)
        let last = 0
        const events = session.events
        if (Array.isArray(events)) for (const ev of events) if (ev && typeof ev.seq === 'number' && ev.seq > last) last = ev.seq
        return { messages: msgs, lastSeq: last }
      },
      // 便签：列表（可见=未删除，置顶优先+时间倒序）
      notesList: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        return visibleNotes(state.notes || [])
      },
      // 便签：已读/置顶/删除/记录窗口位置
      notesAck: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        const id = String((args && args.id) || '')
        const action = String((args && args.action) || '')
        if (!id || !action) return { ok: false, message: '缺少便签 id 或操作。' }
        const res = noteAck(state.notes || [], id, action, args && args.value)
        if (!res.changed) return { ok: false, message: '便签不存在或操作无效。' }
        state.notes = res.list
        await saveState()
        return { ok: true, note: res.note }
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
            // 与 roleplay_start 工具口径一致：恢复「最近保存」的角色卡(最后一张)，而非第一张
            card = cards[cards.length - 1] || null
          }
          if (!card) {
            // 无任何角色/卡 → 进入开局引导：注入一条用户消息让模型开始分步引导
            state.onboarding = true
            startRunning = false
            await saveState()
            try {
              const agent = liveAgent()
              if (agent) agent.send(makeUserMessage('（点「开始新角色」：还没有任何角色。请按提示里的【开局引导】分步问我，我说「你定」的地方你现场设计。）', 'onboard'), 'next-turn', true)
            } catch (e) { /* 无会话时静默 */ }
            return { ok: true, onboarding: true, message: '（进入开局引导。）' }
          }
          const oldKey = charKey()
          await persistMemory(oldKey)
          await persistProgress(oldKey)
          await autoSaveCurrentCard()
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
          await loadProgress(charKey())
          pushStage('env', '角色扮演开始：' + card.name)
          addRecentAct('开始了新的扮演')
          await saveState()
          // 不再注入自动旁白：点按钮开始后不主动输出，等用户在输入框发消息再回应
          return { ok: true, already: false, name: card.name }
        } finally {
          startRunning = false
        }
      },
      listCards: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        const cards = await readCards()
        // 当前角色尚未入库也展示在列表里（虚拟项，点切换时自动落库），保证侧栏永远能切回当前角色
        if (state.character && state.character.name && !cards.some((c) => c.name === state.character.name)) {
          cards.push({ id: 'card-' + charKey(), name: state.character.name, persona: (state.character.persona || '').slice(0, 60) })
        }
        return { ok: true, cards: cards.map((c) => ({ id: c.id, name: c.name, persona: (c.persona || '').slice(0, 60) })) }
      },
      loadCard: async (args) => {
        adoptAgent(args)
        const cards = await readCards()
        const key = String((args && args.card) || '')
        const card = cards.find((c) => c.id === key) || cards.find((c) => c.name === key)
        await ensureLoaded()
        // 列表里展示的「当前角色」若是虚拟项（未入库），以 state.character 的真实人设为准
        const useCard = (card && card.persona && card.persona.length > 20) ? card
          : (state.character && state.character.name && (key === state.character.name || key === 'card-' + charKey()) ? { ...state.character } : card)
        if (!useCard) return { ok: false, message: '没有找到角色卡「' + key + '」。' }
        const oldKey = charKey()
        await persistMemory(oldKey)
        await persistProgress(oldKey)
        await autoSaveCurrentCard()
        state.enabled = true
        state.character = {
          name: useCard.name,
          persona: useCard.persona || '',
          ...(useCard.scene ? { scene: useCard.scene } : {}),
          ...(useCard.status && typeof useCard.status === 'object' ? { status: JSON.parse(JSON.stringify(useCard.status)) } : {}),
          ...(useCard.mode ? { mode: useCard.mode } : {}),
          ...(useCard.greeting ? { greeting: useCard.greeting } : {}),
        }
        memory = await loadMemory(charKey())
        await loadProgress(charKey())
        pushStage('env', '角色卡已加载：' + useCard.name)
        await saveState()
        return { ok: true, name: useCard.name }
      },
      roomStart: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        const tool = toolExec.roleplay_room
        if (!tool) return { ok: false, message: 'roleplay_room 工具不可用。' }
        return tool({ action: 'start', characters: (args && args.characters) || [] })
      },
      roomStop: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        const tool = toolExec.roleplay_room
        if (!tool) return { ok: false, message: 'roleplay_room 工具不可用。' }
        return tool({ action: 'stop' })
      },
      lookDesktop: async (args) => {
        adoptAgent(args)
        return lookDesktop()
      },
      buyItem: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        if (!statsEnabled()) return { ok: false, message: '养成系统已关闭，商城不可用。' }
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
        if (s.relPace === 'slow' || s.relPace === 'normal' || s.relPace === 'fast') state.settings.relPace = s.relPace
        if (s.storyEnabled !== undefined) state.settings.storyEnabled = !!s.storyEnabled
        if (s.userProfileEnabled !== undefined) state.settings.userProfileEnabled = !!s.userProfileEnabled
        if (s.summaryEnabled !== undefined) state.settings.summaryEnabled = !!s.summaryEnabled
        if (s.relationEnabled !== undefined) state.settings.relationEnabled = !!s.relationEnabled
        if (state.character) {
          if (typeof s.persona === 'string' && s.persona.trim()) state.character.persona = s.persona
          if (typeof s.scene === 'string') state.character.scene = s.scene
          if (typeof s.greeting === 'string') state.character.greeting = s.greeting
          if (s.mode !== undefined && MODE_LABELS[s.mode]) state.character.mode = s.mode
        }
        // 显式保存：本次写盘 settings 全量生效(不被保守合并拦住), 保存后复位
        settingsDirty = true
        await saveState()
        settingsDirty = false
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
      userProfileUpdate: async (args) => {
        adoptAgent(args)
        await ensureLoaded()
        if (!userProfileEnabled()) return { ok: false, message: '（用户档案已关闭。）' }
        const a = (args && args.profile) ? args.profile : {}
        const clean = (v, max) => String(v || '').trim().slice(0, max)
        state.userProfile = {
          name: clean(a.name, 60), nickname: clean(a.nickname, 40), identity: clean(a.identity, 200),
          appearance: clean(a.appearance, 200), background: clean(a.background, 300),
          speechStyle: clean(a.speechStyle, 200), notes: clean(a.notes, 200),
        }
        await writeUserProfile(state.userProfile)
        return { ok: true, profile: state.userProfile }
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