// DSH 角色扮演插件 · 持久化 Node half（主机侧桥接）
// 分发：官方 `dsh plugin --profile <p> add github:ajuwm/dsh-roleplay-plugin`
//       —— 包根声明 dsh.bundle.patch，安装后由 dsh 自动 reconcile 进 profile bundles。
// 职责：①把包内 agent-presets/* 物化到 %DSH_HOME%\.agent-presets（首次/版本升级时）
//      ②在 webServer 上挂载自有前缀路由 `/roleplay/<endpoint>`（own wire protocol：
//       POST JSON body = { sessionId?, ...args } → { ok, value?, error? }）。
// 适配说明：DSH 0.1.1-rc.2 起 `connection` 服务不再对外提供（插件 RPC 改为
//       Typert/生成描述符的 Remote 机制），旧 `connection.rpc.handle` 通道不复存在；
//       本桥接改用 rc2 自身内部也在用的 `ctx.webServer.register({kind:'prefix'...})`
//       原语注册自有前缀（与 dsh-client-connection 的 /api 路由同款形态），
//       浏览器端改走同源 `fetch`，回路协议由插件自己定义。
// 安全：loopback-only（远端地址校验），非 POST 一律拒绝；不做跨主机信任。
// 降级：webServer 缺失时打印原因并静默退出（不阻断 DSH 组合加载）。

import z from '@deepseek-ai/schemastery'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const PKG_VERSION = '1.5.1'
const PRESET_NAMES = ['roleplay', 'roleplay-friend', 'roleplay-oc']

// 把包内预设法案物化到用户预设根（首次/升级：带版本标记；绝不删用户额外文件）
function materializePresets() {
  try {
    const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const srcRoot = path.join(pkgRoot, 'agent-presets')
    const dstRoot = path.join(home, '.agent-presets')
    if (!fs.existsSync(srcRoot) || !fs.existsSync(dstRoot)) return
    const walkCopy = (src, dst) => {
      fs.mkdirSync(dst, { recursive: true })
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name)
        const d = path.join(dst, e.name)
        if (e.isDirectory()) walkCopy(s, d)
        else if (e.name !== '.rp-version') fs.copyFileSync(s, d)
      }
    }
    for (const n of PRESET_NAMES) {
      const src = path.join(srcRoot, n)
      const dst = path.join(dstRoot, n)
      if (!fs.existsSync(src)) continue
      const marker = path.join(dst, '.rp-version')
      if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === PKG_VERSION) continue
      walkCopy(src, dst)
      fs.writeFileSync(marker, PKG_VERSION)
    }
  } catch (e) { console.error('[roleplay-client] preset materialize failed:', e) }
}

// DSH「插件设置」面板的 roleplay 命名空间 schema（迁移的 7 个偏好字段）。
const ROLEPLAY_SETTINGS_SCHEMA = z.object({
  heartbeatMinutes: z.number().step(1).min(5).max(240).default(30).description('心跳间隔（分钟，5–240）'),
  narrationMode: z.string().default('novel').description('叙述风格：novel=小说 / compact=简练 / script=对白脚本'),
  difficulty: z.number().step(1).min(1).max(3).default(2).description('养成难度：1=轻松 / 2=标准 / 3=严苛'),
  statsEnabled: z.boolean().default(true).description('属性系统（饱食/健康/心情/生命）'),
  relationEnabled: z.boolean().default(true).description('三维关系（好感/信任/心动）'),
  autoLook: z.boolean().default(false).description('心跳时自动看一眼桌面'),
  shotMaxW: z.number().step(1).min(0).max(1600).default(0).description('桌面截图最大宽度（0=自动）'),
})

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); resolve(null); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('::ffff:127.')
}

export default {
  name: 'roleplay-client',
  // 关键：必须 inject webServer —— Cordis 按依赖分波激活，无 inject 的行在第一波
  // apply，此时内建服务(webServer/agents/settings)都还没提供(实测三者全部 MISSING)。
  // 声明 inject 后本行在 webServer 就绪后才 apply；其余服务保持 ctx.get 可选。
  inject: ['webServer'],
  apply(ctx) {
    materializePresets()
    const agents = ctx.get('agents')
    const agentPresets = ctx.get('agentPresets')
    const settingsSvc = ctx.get('settings')
    const webServer = ctx.webServer

    // 注册 DSH「插件设置」命名空间（roleplay），供设置面板渲染；已注册则跳过。
    if (settingsSvc !== undefined) {
      try { settingsSvc.register('roleplay', ROLEPLAY_SETTINGS_SCHEMA) } catch (e) { /* 已注册等：忽略 */ }
    }

    console.error('[roleplay-client] apply: webServer=', webServer !== undefined ? 'present' : 'MISSING',
      '| agents=', agents !== undefined ? 'present' : 'MISSING',
      '| settings=', settingsSvc !== undefined ? 'present' : 'MISSING')

    if (webServer === undefined || webServer.register === undefined) {
      console.error('[roleplay-client] degraded: no webServer service (route cannot mount; sidebar RPC will be unavailable)')
      ctx.effect(() => undefined, 'roleplay-client: degraded (no webServer)')
      return
    }

    // 路由分发：endpoint → 结果对象 { ok, value?, error? }
    async function dispatch(endpoint, payload) {
      payload = (payload && typeof payload === 'object') ? payload : {}
      if (endpoint === 'settings-read') {
        // settings 服务后续波次就绪: 每次调用实时解析(注册器行已证明其最终可用)
        let svc = undefined
        try { svc = ctx.get('settings') } catch (e) { /* 未就绪 */ }
        return { ok: true, value: svc !== undefined ? svc.get('roleplay') : undefined }
      }
      if (endpoint === 'settings-write') {
        const patch = payload.settings
        let svc = undefined
        try { svc = ctx.get('settings') } catch (e) { /* 未就绪 */ }
        if (svc === undefined || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return { ok: false, error: { code: 'bad-settings', message: 'settings 必须是一个对象。' } }
        }
        try {
          await svc.update('roleplay', patch)
        } catch (error) {
          return { ok: false, error: { code: 'settings-error', message: error instanceof Error ? error.message : String(error) } }
        }
        return { ok: true, value: svc.get('roleplay') }
      }
      if (agents === undefined || agentPresets === undefined) {
        return { ok: false, error: { code: 'roleplay-unavailable', message: '当前环境缺少角色扮演桥接服务。' } }
      }
      // 目标会话解析:chat 端点用 payload.target(对话侧栏显式连接的扮演会话,
      // 与「当前活跃会话」无关——用户可在任意工作会话中打开侧栏聊天);
      // 其余端点沿用 sessionId(当前会话)。
      function resolveFace(sid) {
        if (sid === undefined) return undefined
        try {
          const a = agents.get(sid)
          if (a === undefined) return undefined
          return agentPresets.serviceFor(a, 'roleplay')
        } catch (e) { return undefined }
      }
      // 对话侧栏目标列表:遍历所有活跃根会话,列出挂载了 roleplay 的(按最近活跃排序)
      if (endpoint === 'chat-targets') {
        const out = []
        try {
          const roots = agents.roots() || []
          for (const a of roots) {
            if (!a || !a.id) continue
            const f = resolveFace(String(a.id))
            if (f === undefined || typeof f.peek !== 'function') continue
            let lastSeq = 0
            try {
              const ev = a.session && a.session.events
              if (Array.isArray(ev)) for (const e of ev) if (e && typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq
            } catch (e) { /* 忽略 */ }
            const info = await f.peek()
            out.push({ sessionId: String(a.id), lastSeq, name: info ? info.name : null, enabled: !!(info && info.enabled) })
          }
        } catch (e) { /* 遍历失败返回已收集的 */ }
        out.sort((x, y) => (y.lastSeq || 0) - (x.lastSeq || 0))
        return { ok: true, value: out }
      }
      if (endpoint === 'chat-send' || endpoint === 'chat-poll' || endpoint === 'chat-history') {
        const sid = payload.target !== undefined ? String(payload.target) : (payload.sessionId !== undefined ? String(payload.sessionId) : undefined)
        const targetFace = resolveFace(sid)
        if (targetFace === undefined) {
          return { ok: false, error: { code: 'roleplay-unavailable', message: '目标角色扮演会话不可用(可能已关闭)。请重新打开对话侧栏。' } }
        }
        if (endpoint === 'chat-send') {
          const value = await targetFace.chatSend({ sessionId: sid, text: payload.text })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'chat-poll') {
          const value = await targetFace.chatPoll({ sessionId: sid, since: payload.since })
          return { ok: true, value }
        }
        const value = await targetFace.chatHistory({ sessionId: sid, limit: payload.limit })
        return { ok: true, value }
      }
      // 便签: 列表 / ack(已读/置顶/删除/位置) —— target 优先, 否则自动取最近活跃扮演会话
      if (endpoint === 'notes-list' || endpoint === 'notes-ack') {
        let sid = payload.target !== undefined ? String(payload.target) : (payload.sessionId !== undefined ? String(payload.sessionId) : undefined)
        let targetFace = resolveFace(sid)
        if (targetFace === undefined) {
          let best = null
          let bestSeq = -1
          try {
            const roots = agents.roots() || []
            for (const a of roots) {
              if (!a || !a.id) continue
              const f = resolveFace(String(a.id))
              if (f === undefined || typeof f.peek !== 'function') continue
              let lastSeq = 0
              try {
                const ev = a.session && a.session.events
                if (Array.isArray(ev)) for (const e of ev) if (e && typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq
              } catch (e) { /* 忽略 */ }
              if (lastSeq > bestSeq) { bestSeq = lastSeq; best = f; sid = String(a.id) }
            }
          } catch (e) { /* 遍历失败 */ }
          targetFace = best
        }
        if (targetFace === undefined) {
          return { ok: false, error: { code: 'roleplay-unavailable', message: '没有可用的角色扮演会话。' } }
        }
        if (endpoint === 'notes-list') {
          const value = await targetFace.notesList({ sessionId: sid })
          return { ok: true, value }
        }
        const value = await targetFace.notesAck({ sessionId: sid, id: payload.id, action: payload.action, value: payload.value })
        return { ok: !!value.ok, value }
      }
      // 小游戏(玩家侧): target 优先(与聊天同口径)
      if (endpoint === 'game-start' || endpoint === 'game-move' || endpoint === 'game-state' || endpoint === 'game-quit') {
        const sid = payload.target !== undefined ? String(payload.target) : (payload.sessionId !== undefined ? String(payload.sessionId) : undefined)
        const targetFace = resolveFace(sid)
        if (targetFace === undefined) {
          return { ok: false, error: { code: 'roleplay-unavailable', message: '目标角色扮演会话不可用。' } }
        }
        if (endpoint === 'game-start') {
          const value = await targetFace.gameStart({ sessionId: sid, kind: payload.kind })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'game-move') {
          const value = await targetFace.gameMove({ sessionId: sid, move: payload.move })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'game-quit') {
          const value = await targetFace.gameQuit({ sessionId: sid })
          return { ok: true, value }
        }
        const value = await targetFace.gameState({ sessionId: sid })
        return { ok: true, value }
      }
      const sessionId = payload.sessionId !== undefined ? String(payload.sessionId) : undefined
      const agent = sessionId !== undefined ? agents.get(sessionId) : undefined
      const face = agent !== undefined ? agentPresets.serviceFor(agent, 'roleplay') : undefined
      if (face === undefined) {
        return {
          ok: false,
          error: {
            code: 'roleplay-unavailable',
            message: '当前会话没有挂载角色扮演插件：请使用「角色扮演」预设新建会话。',
          },
        }
      }
      if (endpoint === 'get-state') return { ok: true, value: await face.getState({ sessionId }) }
      if (endpoint === 'start') return { ok: true, value: await face.start({ sessionId }) }
      if (endpoint === 'stop') return { ok: true, value: await face.stop({ sessionId }) }
      if (endpoint === 'cards-list') return { ok: true, value: await face.listCards({ sessionId }) }
      if (endpoint === 'cards-load') {
        const value = await face.loadCard({ sessionId, card: payload.card })
        return { ok: !!value.ok, value }
      }
      if (endpoint === 'look-desktop') return { ok: true, value: await face.lookDesktop({ sessionId }) }
      if (endpoint === 'shop-buy') {
        const value = await face.buyItem({ sessionId, item: payload.item })
        return { ok: !!value.ok, value }
      }
      if (endpoint === 'inventory-use') {
        const value = await face.useItem({ sessionId, item: payload.item })
        return { ok: !!value.ok, value }
      }
      if (endpoint === 'settings-update') {
        const value = await face.updateSettings({ sessionId, settings: payload.settings })
        return { ok: !!value.ok, value }
      }
      if (endpoint === 'user-profile-update') {
        const value = await face.userProfileUpdate({ sessionId, profile: payload.profile })
        return { ok: !!value.ok, value }
      }
      if (endpoint === 'cards-delete') {
        const value = await face.deleteCard({ sessionId, card: payload.card })
        return { ok: !!value.ok, value }
      }
      if (endpoint === 'room-start') {
        const value = await face.roomStart({ sessionId, characters: payload.characters })
        return { ok: !!value.ok, value }
      }
      if (endpoint === 'room-stop') {
        const value = await face.roomStop({ sessionId })
        return { ok: !!value.ok, value }
      }
      if (endpoint === 'pet-status' || endpoint === 'pet-start' || endpoint === 'pet-stop') {
        const pet = agent !== undefined ? agentPresets.serviceFor(agent, 'deskpet') : undefined
        if (pet === undefined) {
          return {
            ok: false,
            error: {
              code: 'deskpet-unavailable',
              message: '当前会话没有挂载桌宠插件：请使用「桌宠」预设新建会话。',
            },
          }
        }
        if (endpoint === 'pet-status') return { ok: true, value: await pet.getStatus() }
        if (endpoint === 'pet-start') return { ok: true, value: await pet.start() }
        if (endpoint === 'pet-stop') return { ok: true, value: await pet.stop() }
      }
      return { ok: false, error: { code: 'bad-endpoint', message: `unknown endpoint ${endpoint}` } }
    }

    const route = {
      kind: 'prefix',
      path: '/roleplay',
      handler: async (req, res) => {
        // 同源本机专线：远端地址必须回环；方法只接受 POST
        if (!isLoopback(req)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end('method not allowed')
          return
        }
        const pathname = (req.url && new URL(req.url, 'http://x').pathname) || ''
        const endpoint = pathname.startsWith('/roleplay/') ? pathname.slice('/roleplay/'.length) : ''
        if (!endpoint) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        const payload = await readBody(req)
        let out
        try {
          out = await dispatch(endpoint, payload)
        } catch (error) {
          out = { ok: false, error: { code: 'handler-error', message: error instanceof Error ? error.message : String(error) } }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      },
    }
    ctx.effect(() => webServer.register(route), 'roleplay-client: /roleplay raw prefix')
  },
}
