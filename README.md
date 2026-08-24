# 角色扮演插件（DeepSeek Harness）

一个以**沉浸式角色扮演为主体**的 DSH（DeepSeek Harness）插件。角色不只是聊天机器人——她会过日子：按时段生活、记得你多久没来、有没来得及说出口的念头、记得你们的重要日子。**桌面悬浮宠物窗口是其中一个可选附加功能。**

> 需要 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 版（DSH 0.1.1+，官方 DeepSeek 适配器原生支持图片，无需额外视觉插件）。

## ✨ 特性

- **角色扮演**：多角色卡（支持 SillyTavern 导入）、独立记忆/日记/世界书/亲密度/养成数值（角色间完全隔离）、扮演模式（默认/快速/深度）
- **心跳系统**：按时段生活（清晨→深夜 7 档）、主动发消息、未说出口的念头沉淀成记忆
- **想念 & 纪念日**：记得你多久没来；记住你们的纪念日/约定日
- **看桌面**：让角色"看到"你的真实屏幕（官方图片注入，可 API 关）
- **叙述风格**：小说 / 剧本 / 精简 三种输出，随时切换
- **剧本模式**：你定开头与结尾，中间自由扮演，自然收束
- **养成系统**：生命体征（饱食/健康/心情/生命）+ 金币商城 + 投喂/照顾；危机提醒
- **亲密度系统**：好感 / 信任 / 心动 三轴 + 男友力 + 里程碑（m1→m8），AI 判断加减、联动升级
- **侧栏设置**：双通道（侧栏 + DSH「插件设置」），深色/浅色跟随 DSH 主题
- **桌宠（附加）**：桌面悬浮立绘，拖动/触摸/双击对话/气泡嘀咕，可一键启停

## 📦 安装

见 [`docs/INSTALL.md`](docs/INSTALL.md)。简要步骤：

1. 把 `agent-presets/roleplay` 放到 `%USERPROFILE%\.dsh\.agent-presets\roleplay`
2. 把 `roleplay-client` 放到 `%USERPROFILE%\.dsh\profiles\web\node_modules\@dsh-user\roleplay-client`，并在 `cordis.patch.yml` 追加 `roleplay-client` 行
3. 把 `pet`（桌宠资源）放到你的 **DSH 工作区**下的 `pet` 目录（默认 `<DSH 工作区>\pet`，可用环境变量 `DSH_PET_DIR` 覆盖；工作区 = DSH 运行/配置的 workspace，不是 `%USERPROFILE%\.dsh`）
4. `settings.yaml` 里 `agent-presets.default: roleplay`
5. 重启 DSH，新建会话，侧栏点「▶ 开始扮演」

> 角色扮演默认会话预设即用；桌宠是可选的附加，不开启不影响角色扮演。

## 📚 文档

- [安装说明](docs/INSTALL.md)
- [亲密度玩法指南](docs/亲密度攻略_通俗版.md)
- [亲密度系统设计文档](docs/亲密度系统_设计文档.md)

## 🖼 说明

- "看桌面"用官方 DeepSeek 适配器**原生图片支持**（DSH 0.1.1+），不再需要 vision-router 等视觉插件。
- 角色立绘/桌宠立绘请自行放入 `<DSH 工作区>\pet` 目录（仓库不含版权图片素材）。

## ⚖️ License

[MIT](LICENSE)
