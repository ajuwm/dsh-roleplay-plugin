// DSH 角色扮演插件 · 持久化 Node half（主机侧 RPC 桥接）
// 行：profile 补丁 `- id: roleplay-client / name: '@dsh-user/roleplay-client'`
// 职责：注册 `/roleplay` Connection RPC 通道。每次调用按 payload.sessionId
//       解析会话的 Agent，再经 `agentPresets.serviceFor` 读取该会话预设
//       （roleplay 预设的 isolate realm）内发布的 `roleplay` 服务。
// 重启后随 profile 组合自动挂载，无需任何动态插件。

import z from '@deepseek-ai/schemastery'

// DSH「插件设置」面板的 roleplay 命名空间 schema（迁移的 7 个偏好字段）。
// 双通道：侧栏快速入口改动经 roleplay-host 镜像回命名空间；面板改动经
// settings/updated 事件由 roleplay-host 回写 state.settings。
// narrationMode 用 string（DSH 面板对 string=文本框），体验好的下拉保留在侧栏。
const ROLEPLAY_SETTINGS_SCHEMA = z.object({
  heartbeatMinutes: z.number().step(1).min(5).max(240).default(30).description('心跳间隔（分钟，5–240）'),
  narrationMode: z.string().default('novel').description('叙述风格：novel=小说 / compact=简练 / script=对白脚本'),
  difficulty: z.number().step(1).min(1).max(3).default(2).description('养成难度：1=轻松 / 2=标准 / 3=严苛'),
  statsEnabled: z.boolean().default(true).description('属性系统（饱食/健康/心情/生命）'),
  relationEnabled: z.boolean().default(true).description('三维关系（好感/信任/心动）'),
  autoLook: z.boolean().default(false).description('心跳时自动看一眼桌面'),
  shotMaxW: z.number().step(1).min(0).max(1600).default(0).description('桌面截图最大宽度（0=自动）'),
})

export default {
  name: 'roleplay-client',
  inject: ['connection', 'agents', 'agentPresets', 'settings'],
  apply(ctx) {
    // 注册 DSH「插件设置」命名空间（roleplay），供设置面板渲染；已注册则跳过。
    const settingsSvc = ctx.get('settings')
    if (settingsSvc !== undefined) {
      try { settingsSvc.register('roleplay', ROLEPLAY_SETTINGS_SCHEMA) } catch (e) { /* 已注册等：忽略 */ }
    }
    const disposeChannel = ctx.connection.rpc.handle('/roleplay', async (endpoint, payload) => {
      try {
        // 命名空间级设置读写：直连 DSH「插件设置」的 roleplay 命名空间（浏览器卡片用），
        // 不依赖会话/face；roleplay-host 经 settings/updated 事件同步到 state.settings。
        if (endpoint === 'settings-read') {
          return { ok: true, value: settingsSvc !== undefined ? settingsSvc.get('roleplay') : undefined }
        }
        if (endpoint === 'settings-write') {
          const patch = payload && payload.settings
          if (settingsSvc === undefined || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
            return { ok: false, error: { code: 'bad-settings', message: 'settings 必须是一个对象。' } }
          }
          try {
            await settingsSvc.update('roleplay', patch)
          } catch (error) {
            return { ok: false, error: { code: 'settings-error', message: error instanceof Error ? error.message : String(error) } }
          }
          return { ok: true, value: settingsSvc.get('roleplay') }
        }
        const sessionId = payload && payload.sessionId ? String(payload.sessionId) : undefined
        const agent = sessionId !== undefined ? ctx.agents.get(sessionId) : undefined
        const face = agent !== undefined ? ctx.agentPresets.serviceFor(agent, 'roleplay') : undefined
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
          const value = await face.loadCard({ sessionId, card: payload && payload.card })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'look-desktop') return { ok: true, value: await face.lookDesktop({ sessionId }) }
        if (endpoint === 'shop-buy') {
          const value = await face.buyItem({ sessionId, item: payload && payload.item })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'inventory-use') {
          const value = await face.useItem({ sessionId, item: payload && payload.item })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'settings-update') {
          const value = await face.updateSettings({ sessionId, settings: payload && payload.settings })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'cards-delete') {
          const value = await face.deleteCard({ sessionId, card: payload && payload.card })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'room-start') {
          const value = await face.roomStart({ sessionId, characters: payload && payload.characters })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'room-stop') {
          const value = await face.roomStop({ sessionId })
          return { ok: !!value.ok, value }
        }
        if (endpoint === 'pet-status' || endpoint === 'pet-start' || endpoint === 'pet-stop') {
          const pet = agent !== undefined ? ctx.agentPresets.serviceFor(agent, 'deskpet') : undefined
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: { code: 'handler-error', message } }
      }
    }, { authority: 'loopback' })
    ctx.effect(() => disposeChannel, 'roleplay-client: /roleplay channel')
  },
}
