# 角色扮演插件安装说明

适用于 DSH（DeepSeek Harness）Web 版。本插件以**角色扮演为主体**，桌面悬浮宠物为可选附加。安装前请先阅读 `README.md` 了解功能。

---

## 目录结构

```
dsh-roleplay-plugin/
├── README.md                 # 插件功能介绍
├── INSTALL.md                # 本安装说明
├── pet/                      # 桌宠窗口资源（立绘、窗口脚本、截图脚本）
├── agent-presets/
│   └── roleplay/             # 角色扮演预设（含角色扮演 + 桌宠附加功能）
├── roleplay-client/          # 浏览器侧边栏桥接（侧栏 UI）
└── dependencies/
    └── node_modules/         # 离线依赖（含 sharp 平台二进制）
```

## 依赖

- 角色扮演与官方图片（看桌面）能力由 DSH 官方 DeepSeek 适配器原生支持（DSH 0.1.1+），**无需安装视觉插件**。
- sharp 等离线依赖随压缩包附带（`dependencies/node_modules`），供桌宠截图等使用。

## 安装步骤

### 1. 放置预设

把 `agent-presets\roleplay` 整个文件夹复制到：

```
%USERPROFILE%\.dsh\.agent-presets\roleplay
```

> 该预设同时覆盖角色扮演与桌宠：角色扮演为主体，桌宠为一键启动的附加功能。

### 2. 放置桌宠资源

把 `pet` 文件夹复制到：

```
%USERPROFILE%\.dsh\pet
```

> 💡 路径已可配置（不再硬编码）。默认：数据根 `%USERPROFILE%\.dsh`（角色数据 `.roleplay`）、桌宠资源 `%USERPROFILE%\.dsh\pet`。
> 如需换位置，设置环境变量 `DSH_ROLEPLAY_HOME`（数据根）或 `DSH_PET_DIR`（桌宠资源目录）即可，**无需改代码**。

### 3. 放置侧栏桥接

把 `roleplay-client` 文件夹复制到：

```
%USERPROFILE%\.dsh\profiles\web\node_modules\@dsh-user\roleplay-client
```

（覆盖同名目录。⚠️ 不要在 profile 目录运行 `pnpm install`，它会清掉未声明的 node_modules 内容。）

然后在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 追加（没有则新建）：

```yaml
- insert:
    - id: roleplay-client
      name: '@dsh-user/roleplay-client'
```

### 4. 设为默认预设（可选）

编辑 `%USERPROFILE%\.dsh\settings.yaml`：

```yaml
agent-presets:
  default: roleplay
```

### 5. 重启 DSH

重启后刷新页面。新建会话（默认角色扮演预设），侧栏点「▶ 开始扮演」即可开始。

## 使用

- 角色扮演入口：输入框上方 🎭 气泡按钮 → 右侧边栏
- 桌宠（附加）：侧栏「启动桌宠」按钮，或双击立绘对话、单击触摸、按住拖动
- 详细功能见 `README.md`

## 数据与文件

| 内容 | 位置 |
|------|------|
| 桌宠设置 | `%USERPROFILE%\.dsh\pet\config.json` |
| 角色状态/设置 | `%USERPROFILE%\.dsh\.roleplay\character.json` |
| 角色卡 | `%USERPROFILE%\.dsh\.roleplay\cards.json` |
| 角色记忆（含未说出口的念头） | `%USERPROFILE%\.dsh\.roleplay\mem-<角色名>.json` |
| 角色日记 | `%USERPROFILE%\.dsh\.roleplay\diary-<角色名>-<日期>.md` |
| 桌面截图 | `%USERPROFILE%\.dsh\.roleplay\desktop-look.png` |
| 桌宠嘀咕 | `%USERPROFILE%\.dsh\.roleplay\bubble.txt` |
