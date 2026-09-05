// dsh-roleplay-plugin · 设置命名空间注册器(独立行, 失败不影响主桥接)
// DSH「设置 → 插件 → 插件配置」的卡片 = settings 命名空间 schema 渲染。
// 本行 inject settings 服务(就绪才启动), 注册 roleplay 全量开关 schema;
// 面板改动经 settings/updated → roleplay-host 回写 state.settings(双向, 侧栏同源)。
import z from '@deepseek-ai/schemastery'

const SCHEMA = z.object({
  heartbeatMinutes: z.number().step(1).min(5).max(240).default(30).description('心跳间隔（分钟，5–240）'),
  narrationMode: z.string().default('novel').description('叙述风格：novel=小说 / compact=精简 / script=剧本'),
  difficulty: z.number().step(1).min(1).max(3).default(2).description('养成难度：1=休闲 / 2=标准 / 3=困难'),
  statsEnabled: z.boolean().default(true).description('养成系统（饱食/健康/心情/生命+商城）'),
  relationEnabled: z.boolean().default(true).description('亲密度系统（好感/信任/心动/里程碑）'),
  relPace: z.string().default('normal').description('亲密度进度：slow=慢热 / normal=正常 / fast=快速'),
  autoLook: z.boolean().default(false).description('心跳时允许角色主动看桌面'),
  shotMaxW: z.number().step(1).min(0).max(1600).default(0).description('桌面截图最大宽度（0=自动）'),
  storyEnabled: z.boolean().default(true).description('剧情档案（章节式故事库）'),
  summaryEnabled: z.boolean().default(true).description('剧情概况（浓缩摘要防遗忘）'),
  userProfileEnabled: z.boolean().default(true).description('用户档案（角色对你的认知）'),
})

export default {
  name: 'roleplay-settings',
  inject: ['settings'],
  apply(ctx) {
    try {
      ctx.settings.register('roleplay', SCHEMA)
      console.error('[roleplay-settings] namespace registered (插件配置卡片可用)')
    } catch (e) {
      console.error('[roleplay-settings] register failed:', e)
    }
  },
}
