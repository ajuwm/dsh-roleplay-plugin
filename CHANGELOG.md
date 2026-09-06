# Changelog

本插件变更记录（版本遵循语义化：hotfix=patch / 新功能=minor / 大改=major，一次性修复集并入当次版本）。

## [1.5.13] - 🎭 侧栏打不开真根因: 悬浮宠物插件盖住 dock 按钮吞点击(点🎭无反应/看不了属性)
- **实证(Tabbit 浏览器实测)**: dsh-whale-musume 悬浮鲸鱼娘(fixed 右下角, z-index 60; 说话气泡 z-index 1199)盖在 DSH composer 容器(z:7 sticky 上下文)之上 —— 🎭/💬 按钮完全被遮, Playwright 点击被气泡/立绘层拦截(intercepts pointer events), 点击=无反应。
- **修复**: 注入 CSS `body [class*="composerSeat"] { z-index: 1300 !important; }` —— 把 composer 容器抬到宠物之上(容器透明, 宠物本体照常显示; 侧栏/聊天面板 z-index 1400/1410 本就高于气泡)。实测: 注入后按钮元素栈首位即 rp-dock-btn, 原生点击 → 侧栏正常打开、角色状态/属性可见。
- 全量测试保持 278/278(本变更仅 CSS 注入, T0 语法门通过)。

## [1.5.12] - 对话侧栏 chatSend 消息缺 source → DSH pre-step 链读 undefined.kind 整轮红徽标(真根因)
- **真根因(会话日志逐事件实证)**: 侧栏 chatSend 发出的用户消息只有 {id, role, content} 没有任何 source 字段; DSH 消息契约要求每条消息带 source(kind: user/plugin/…)。DSH 的 agent/pre-step 链上 dsh-repeat-tool-reminder(`message.source.kind === "user"`)与 dsh-session-reference(`message.source.kind !== "user"`)直接读 `message.source.kind` → undefined.source → **TypeError: Cannot read properties of undefined (reading 'kind')** → 整轮 pre-step 崩溃, 主对话区/侧栏红色徽标「本轮运行失败」。证据: 会话日志中 6 条 chat-* 消息全部只有 agent/inbox/spliced、无 user/message(失败); 同场的 pet-* 消息(带 source.kind=plugin)全部正常完成。