// dsh-roleplay-plugin · 设置命名空间注册器(独立行, 失败不影响主桥接)
// DSH「设置 → 插件 → 插件配置」的卡片 = settings 命名空间 schema 渲染。
// 本行 inject settings 服务(就绪才启动), 注册 roleplay 全量开关 schema;
// 面板改动经 settings/updated → roleplay-host 回写 state.settings(双向, 侧栏同源)。
import z from '@deepseek-ai/schemastery'

const SCHEMA = z.object({
  // ── 稳定版开关(v1.5.29)───────────────────────────────────────────
  // 语义:关掉 = 对应子系统「真的不跑」(定时器不注册、工具不注册、不 spawn 进程、不写盘),
  //      而不是只把返回值置空。数据一律保留,随时开回来。
  enabled: z.boolean().default(true).description('总开关：关闭后不显示侧栏入口、不注入角色扮演提示词、不启动桌宠、不发心跳（数据一律保留）'),
  stableMode: z.boolean().default(false).description('稳定模式：保留扮演核心，一键关掉非核心子系统（心跳 / 桌宠 / 便签 / 小游戏 / 世界书 / ST导入 / 备份）'),
  heartbeatEnabled: z.boolean().default(true).description('心跳（角色定时主动发消息）'),
  deskpetEnabled: z.boolean().default(true).description('桌宠窗口 + 便签窗（PowerShell 子进程）'),
  notesEnabled: z.boolean().default(true).description('便签'),
  gameEnabled: z.boolean().default(true).description('小游戏（井字棋 / 猜数字 / 二十问 / 真心话）'),
  loreEnabled: z.boolean().default(true).description('世界书（关键词触发的背景条目）'),
  stImportEnabled: z.boolean().default(true).description('SillyTavern 角色卡导入（PNG / JSON 解析）'),
  backupEnabled: z.boolean().default(true).description('备份镜像（每 60 秒一次的全量快照）'),
  desktopLookEnabled: z.boolean().default(true).description('角色主动看桌面（截屏，会拉起 PowerShell）'),
  stateSlotEnabled: z.boolean().default(true).description('角色状态槽（每轮重建的「我此刻是谁」短视图，≤600 字，排在上下文末尾）'),
  compactionMode: z.string().default('official').description('压缩方式：official=官方原样 / roleplay=官方摘要前补一段中文第一人称的「那段时间我记得的是」'),
  // ── 原有开关 ──────────────────────────────────────────────────────
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
    const svc = ctx.settings
    // DSH 0.2.0 起设置服务换成「Config 派生表单」(SettingsForms)：没有 register、没有 get，
    // 第三方插件也没有自动卡片 → 这里安静退出。开关改由 lib/switch-store.mjs 管理
    // ($DSH_HOME/.roleplay-switches.json)，面板由浏览器半自己渲染。
    if (svc === undefined || typeof svc.register !== 'function') {
      console.error('[roleplay-settings] 无命名空间注册能力（DSH 0.2.0+）：开关走本地存储 + 自带面板')
      return
    }
    try {
      svc.register('roleplay', SCHEMA)
      console.error('[roleplay-settings] namespace registered (插件配置卡片可用)')
    } catch (e) {
      console.error('[roleplay-settings] register failed:', e)
    }
  },
}
