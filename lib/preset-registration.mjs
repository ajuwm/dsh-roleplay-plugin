// DSH 0.2.0 角色预设注册（agentPresets 服务）—— 与 lib/index.js 分离，便于单测。
//
// 0.1.1：官方扫描 %DSH_HOME%/.agent-presets/<name>/ 目录（本插件负责物化）。
// 0.2.0：目录扫描被取消，预设改成一个 @deepseek-ai/dsh-agent-preset 声明，由
//        agentPresets 服务的 register() 登记。这里做能力探测：有 register() 才登记
//        （0.2.0+），没有就什么都不做（0.1.1 照旧吃目录，别去动它）。
//
// 组合文件：0.2.0 用 agent.cordis.0.2.yml（0.1.1 那份有两处硬性不兼容，见该文件头注释），
// 找不到才回退 0.1.1 的文件、再回退物化目录。组合树用 cordis:include 指向它，
// include 会把 baseUrl 设成 yml 所在目录，所以 yml 里的 './roleplay-host.mjs' 与
// new URL('skills/', baseUrl) 在两个版本里都照旧成立。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PRESET_NAMES = ['roleplay']
const PRESET_ORDER_BASE = 10
// 0.2.0 专用组合文件名（与 0.1.1 的 agent.cordis.yml 并列）
const MODERN_COMPOSITION = 'agent.cordis.0.2.yml'
const LEGACY_COMPOSITION = 'agent.cordis.yml'

// preset.yml 只取展示名/描述（新版 roster 要 name/description；0.1.1 不读这个文件）。
function readPresetMeta(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'preset.yml'), 'utf8')
    const pick = (key) => {
      const m = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(text)
      if (m === null) return undefined
      const v = m[1].trim()
      return v.length > 0 ? v : undefined
    }
    return { name: pick('name'), description: pick('description') }
  } catch (e) { return {} }
}

// 组合文件：0.2.0 专用 → 0.1.1 的 → 物化目录（用户可手改的那份）。
function compositionFile(pkgRoot, home, id) {
  const dirs = [
    path.join(pkgRoot, 'agent-presets', id),
    path.join(home, '.agent-presets', id),
  ]
  for (const dir of dirs) {
    const modern = path.join(dir, MODERN_COMPOSITION)
    if (fs.existsSync(modern)) return modern
    const legacy = path.join(dir, LEGACY_COMPOSITION)
    if (fs.existsSync(legacy)) return legacy
  }
  return undefined
}

export function registerAgentPresets(ctx) {
  const boot = (scope) => {
    let svc = undefined
    try { svc = scope.get('agentPresets') } catch (e) { svc = undefined }
    // 0.1.1 也叫 agentPresets，但没有 register（它只扫目录）—— 用方法探测分流。
    if (svc === undefined || typeof svc.register !== 'function') return
    const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    let order = PRESET_ORDER_BASE
    const pending = []
    for (const id of PRESET_NAMES) {
      const yml = compositionFile(pkgRoot, home, id)
      if (yml === undefined) continue
      const meta = readPresetMeta(path.join(pkgRoot, 'agent-presets', id))
      const definition = {
        id: id,
        order: order++,
        plugins: [
          {
            id: id + '-composition',
            name: 'cordis:include',
            config: { path: pathToFileURL(yml).href },
          },
        ],
      }
      if (meta.name !== undefined) definition.name = meta.name
      if (meta.description !== undefined) definition.description = meta.description
      pending.push(Promise.resolve(svc.register(definition)).then(
        () => console.log('[roleplay-client] agent preset registered: ' + id + ' ← ' + yml),
        (e) => console.error('[roleplay-client] agent preset register failed: ' + id, e)
      ))
    }
    // 自检：把 roster（含挂载失败原因）打出来。
    // ⚠️ register() 在「登记成功但挂载被拒」时**依然 resolve**，所以必须单独查一次 list()，
    //    否则失败是完全静默的（新建会话的预设列表按设计只显示健康预设）。
    Promise.all(pending).then(async () => {
      if (typeof svc.list !== 'function') return
      let rows = []
      try { rows = await svc.list() } catch (e) { console.error('[roleplay-client] roster self-check failed', e); return }
      for (const row of rows || []) {
        if (!row || PRESET_NAMES.indexOf(row.id) < 0) continue
        if (row.broken) console.error('[roleplay-client] agent preset BROKEN: ' + row.id + ' → ' + row.broken)
        else console.log('[roleplay-client] agent preset OK: ' + row.id)
      }
    })
  }
  if (typeof ctx.inject === 'function') ctx.inject(['agentPresets'], boot)
  else boot(ctx)
}
