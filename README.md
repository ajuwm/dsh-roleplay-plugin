# 角色扮演插件（DeepSeek Harness）

![tests](https://github.com/ajuwm/dsh-roleplay-plugin/actions/workflows/test.yml/badge.svg)

一个以**沉浸式角色扮演为主体**的 DSH（DeepSeek Harness）插件。角色不只是聊天机器人——她会过日子：按时段生活、记得你多久没来、有没来得及说出口的念头、记得你们的重要日子。**桌面悬浮宠物窗口是其中一个可选附加功能。**

> 需要 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 版（DSH 0.1.1+，官方 DeepSeek 适配器原生支持图片，无需额外视觉插件）。桥接已完成 DSH 0.1.1-rc.2 适配（`npm exec @deepseek-ai/dsh web` 与 DSH Desktop 双版本可用）。

## ✨ 特性

- **角色扮演**：多角色卡（支持 SillyTavern 导入）、独立记忆/日记/世界观/亲密度/养成数值（角色间完全隔离）、**角色卡库全局共享**（跨对话/跨预设切换）、扮演模式（默认/快速/深度）
- **开局引导**：新角色**分步引导**（演谁/你的称呼/世界观/基调/偏好），每步可说「你定」由她现场设计（含角色名）；收集完生成人格档案并开演，第一句念卡
- **人格真实感**：每个角色一份**隐藏人格档案**（底线 + 真实感增强，随 `rp-realness` 技能按人设生成、运行期隐身）——她不再"用户永远是对的"：有独立判断、按人设表达反对（傲娇怼/软钉子/损友嘲讽/沉默/直接骂），底线三问每轮自检，关系事件演化底线
- **多角色房间**：1 玩家 + 2~3 个角色同台互动（各有各的记忆与关系；侧栏「房间(双人)」或对话「让A和B一起陪我」）
- **心跳系统**：按时段生活（清晨→深夜 7 档）、主动发消息、未说出口的念头沉淀成记忆
- **想念 & 纪念日**：记得你多久没来；记住你们的纪念日/约定日（久别自动掉信任）
- **看桌面**：让角色"看到"你的真实屏幕（官方图片注入，可 API 关）
- **叙述风格**：小说 / 剧本 / 精简 三种输出，随时切换；输出规则反八股、口癖克制、静默合法
- **剧本模式**：你定开头与结尾，中间自由扮演，自然收束
- **养成系统**：生命体征（饱食/健康/心情/生命）+ 金币商城 + 投喂/照顾；危机提醒
- **亲密度系统**：好感 / 信任 / 心动 三轴 + 男友力 + 里程碑（m1→m8），加减有标尺、重复加成自动递减、久别掉信任、单轮限幅；进度难度（慢热/正常/快速）自选
- **剧情连续性**：章节式剧情档案（`roleplay_story`：10~15 轮/场景转场自动存档，跨会话恢复）+ 增量摘要 + 用户人设档案（角色对你的认知）
- **侧栏设置**：全部设置集中在侧栏（心跳/叙述/难度/剧本/开关/亲密度进度/我的档案），无需开演即可编辑，跨会话持久
- **桌宠（附加）**：桌面悬浮立绘，拖动/触摸/双击对话/气泡嘀咕，可一键启停

## 📦 安装

**推荐:官方插件命令(需要 pnpm;DSH Desktop 自带,或 `npm i -g pnpm`)**

```powershell
dsh plugin --profile web add github:ajuwm/dsh-roleplay-plugin
# 更新/卸载: dsh plugin --profile web update @ajuwm/dsh-roleplay-plugin
#               dsh plugin --profile web remove @ajuwm/dsh-roleplay-plugin
```

安装后重启 DSH:角色扮演预设自动物化到 `%DSH_HOME%\.agent-presets\`,侧栏自动挂载。桌宠**程序**随包;桌宠**立绘素材**请自备(放工作区 `pet\`,见下方说明)。

**备选:一键脚本(`install.ps1`)**

```powershell
pwsh install.ps1            # 安装并兼容清理旧版手动布局
pwsh install.ps1 -Uninstall # 回滚
```

**手动(不推荐)**:
1. 把 `agent-presets/roleplay` 放到 `%USERPROFILE%\.dsh\.agent-presets\roleplay`
2. 把 `lib` + `package.json` 放到 `%USERPROFILE%\.dsh\profiles\web\node_modules\@ajuwm\dsh-roleplay-plugin`，并在 `cordis.patch.yml` 追加 `roleplay-client` 行(包名 `@ajuwm/dsh-roleplay-plugin`)
3. 桌宠立绘:放入 **DSH 工作区**下的 `pet` 目录(默认 `<DSH 工作区>\pet`,可用 `DSH_PET_DIR` 覆盖;工作区 ≠ `%USERPROFILE%\.dsh`)
4. `settings.yaml` 里 `agent-presets.default: roleplay`
5. 重启 DSH,新建会话,说「开始/开演」或侧栏按钮开始扮演

> 角色扮演默认会话预设即用;桌宠是可选的附加,不开启不影响角色扮演。

## 📚 文档

- [安装说明](docs/INSTALL.md)
- [亲密度玩法指南](docs/亲密度攻略_通俗版.md)
- [亲密度系统设计文档](docs/亲密度系统_设计文档.md)

## 🖼 说明

- "看桌面"用官方 DeepSeek 适配器**原生图片支持**（DSH 0.1.1+），不再需要 vision-router 等视觉插件。
- 角色立绘/桌宠立绘请自行放入 `<DSH 工作区>\pet` 目录（仓库不含版权图片素材）。

## ⚖️ License

[MIT](LICENSE)
