// 角色扮演插件 · 压缩锚点行(DSH 0.2.0 专用)
//
// 它挂在我们预设的 compaction 组里,和官方后端 compaction-basic 并列 —— 但**不替换**官方:
// 官方那 1000 行(选区间 / 替换 / checkpoint / 并发锁 / 溢出重试)照常跑,
// 我们只在它每次压缩时,把一段中文第一人称的「那段时间我记得的是」塞到摘要最前面。
//
// 为什么不自己写一个压缩后端:
//   · CompactionEngine 基类只有 30 行(只注册服务),真逻辑在 dsh-compaction-basic 里且不导出;
//   · 而且「一个 context 只能挂一个后端」—— 所以「两个后端并存让用户选」做不到;
//   · 官方在 regionDependencies() 里留了一个 summarize 钩子,而且**每次压缩都会重新取** —— 正好是注入点。
// 于是:官方模式 = 原样返回(与今天零差异);角色扮演模式 = 摘要前面多一段她的续接。
//
// 切换是**实时**的:每次压缩都重读设置,不用重启、不用重建预设。

import fs from 'node:fs'
import path from 'node:path'
import { readSwitches } from '../agent-presets/roleplay/lib/switch-store.mjs'
import { buildCompactionAnchor } from '../agent-presets/roleplay/lib/compaction-anchor.mjs'

export const name = 'roleplay-compaction'
// 必须等官方后端就绪:我们要包的就是它的方法
export const inject = ['compaction']

const TIER_LABELS = {
  favor: ['疏离', '亲近', '倾慕'],
  trust: ['戒备', '放心', '依赖'],
  heart: ['无感', '在意', '心动'],
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

// 与 roleplay-host 的 charKeyFor 同一口径(换卡/隔离靠它)
function charKeyFor(n) {
  const s = String(n || '').trim()
  if (!s) return '_default'
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 40) || '_default'
}

// 把「她此刻的存档」读成锚点输入。读不到就返回 null(调用方原样放行,不影响官方压缩)。
function collectAnchorInput(ctx, agent, dataRoot) {
  const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
  if (!cwd) return null
  const root = path.join(cwd, dataRoot)
  const st = readJson(path.join(root, 'character.json'))
  const ch = st && st.character ? st.character : null
  if (!ch || !ch.name) return null
  const key = charKeyFor(ch.name)
  const pr = readJson(path.join(root, 'progress-' + key + '.json')) || {}
  const mem = readJson(path.join(root, 'mem-' + key + '.json')) || {}
  const lastSeen = Number(st.lastSeen) || 0
  const days = lastSeen > 0 ? Math.max(0, Math.floor((Date.now() - lastSeen) / 86400000)) : 0
  const d = lastSeen > 0 ? new Date(lastSeen) : null
  const goal = pr.savingGoal && pr.savingGoal.name
    ? '攒钱买「' + pr.savingGoal.name + '」' + (Number(pr.savingGoal.need) > 0 ? '——还差 ' + Math.max(0, Number(pr.savingGoal.need) - Number(pr.savingGoal.saved || 0)) + ' 金币' : '')
    : null
  const ann = Array.isArray(pr.anniversaries) && pr.anniversaries.length ? pr.anniversaries[0] : null
  return {
    relation: pr.relation || null,
    tierLabels: TIER_LABELS,
    idleDays: days,
    idleLabel: d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : '',
    memories: (mem.short_term || []).map((x) => x && x.event),
    unspoken: (mem.unspoken || []).map((u) => u && u.text),
    longTerm: (mem.long_term || []).slice().sort((a, b) => ((b && b.count) || 1) - ((a && a.count) || 1)).map((x) => x && x.event),
    recentActs: (pr.recentActs || []).map((a) => a && a.act),
    anniversary: ann && ann.date ? String(ann.date).slice(5) + ' ' + (ann.name || '') : null,
    goal: goal,
    chapter: pr.storySummary ? String(pr.storySummary).slice(0, 120) : null,
  }
}

function anchorFor(ctx, agent, dataRoot) {
  const input = collectAnchorInput(ctx, agent, dataRoot)
  if (!input) return ''
  return buildCompactionAnchor(input)
}

export function apply(ctx, config) {
  // ⚠️ 整体兜底:预设里任何一行抛错,roster 的 audit 会把**整棵预设**判为挂载失败。
  // 我们这行只是「锦上添花」,绝不能有这种能量。
  try {
    applyInner(ctx, config)
  } catch (e) {
    console.error('[roleplay-compaction] 挂载失败,已忽略(不影响官方压缩):', e)
  }
}

function applyInner(ctx, config) {
  const dataRoot = (config && config.dataRoot && typeof config.dataRoot === 'string') ? config.dataRoot : '.roleplay'
  const engine = ctx.compaction
  if (engine === undefined || typeof engine.regionDependencies !== 'function') {
    console.error('[roleplay-compaction] 官方后端没有 regionDependencies(版本不符) → 保持官方行为,不做任何事')
    return
  }
  // ⚠️ 幂等:热重载会让 apply 再跑一次。如果每次都 bind 当前方法,就会层层包装、
  // 锚点被注入两次。所以把「官方原版」记在实例上,永远只包一层。
  const ORIGINAL = Symbol.for('ajuwm.roleplay.compaction.original')
  const HAD_OWN = Symbol.for('ajuwm.roleplay.compaction.hadOwn')
  if (engine[ORIGINAL] === undefined) {
    // 记下它原来是「自有属性」还是「原型方法」—— 卸载时的还原方式不同(删错了会把方法整个抹掉)
    engine[HAD_OWN] = Object.prototype.hasOwnProperty.call(engine, 'regionDependencies')
    engine[ORIGINAL] = engine.regionDependencies.bind(engine)
  }
  const original = engine[ORIGINAL]
  // 每次压缩都会重新调用 regionDependencies(),所以这个包装是实时的:
  // 设置里一改,下一次压缩立刻生效,不需要重启。
  const wrapped = function () {
    const deps = original()
    if (readSwitches(ctx).compactionMode !== 'roleplay') return deps   // 官方模式:原样,零差异
    const baseSummarize = deps && deps.summarize
    if (typeof baseSummarize !== 'function') return deps
    return Object.assign({}, deps, {
      summarize: async (input, owner, abort) => {
        const out = await baseSummarize(input, owner, abort)
        try {
          const anchor = anchorFor(ctx, owner, dataRoot)
          if (!anchor) return out
          const blocks = Array.isArray(out && out.summary) ? out.summary : []
          // 我们的那段放最前面:模型先读到「她记得的」,再读官方那份事实兜底
          const merged = Object.assign({}, out, { summary: [{ type: 'text', text: anchor }].concat(blocks) })
          // 注入成功留一行:压缩很稀有,这行不吵,但排查时是唯一的现场
          console.log('[roleplay-compaction] 锚点已注入摘要(' + anchor.length + ' 字,官方摘要 ' + blocks.length + ' 块)')
          return merged
        } catch (e) {
          console.error('[roleplay-compaction] 锚点生成失败,放行官方摘要', e)
          return out
        }
      },
    })
  }
  engine.regionDependencies = wrapped
  try { console.log('[roleplay-compaction] 已就绪:包住官方后端(压缩方式=' + readSwitches(ctx).compactionMode + ')') } catch (e) { console.log('[roleplay-compaction] 已就绪:包住官方后端') }
  // 卸载时还原:只在我们仍是当前包装时撤(own property 删掉,原型方法自动回来)
  ctx.effect(() => () => {
    try {
      if (engine.regionDependencies === wrapped) {
        // 自有属性 → 把原函数放回去;原型方法 → 删掉自有属性让它重新露出来。
        // ⚠️ 不能无脑 delete:万一以后官方改成构造函数里赋值,delete 会连方法一起抹掉。
        if (engine[HAD_OWN]) engine.regionDependencies = engine[ORIGINAL]
        else delete engine.regionDependencies
        delete engine[ORIGINAL]
        delete engine[HAD_OWN]
      }
    } catch (e) { /* 忽略 */ }
  }, 'roleplay-compaction: restore')
}
