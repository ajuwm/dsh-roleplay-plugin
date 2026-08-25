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

把 `agent-presets\roleplay`（恋爱向，含角色扮演 + 桌宠附加功能）整个文件夹复制到：

```
%USERPROFILE%\.dsh\.agent-presets\roleplay
```

需要「朋友向 / OC 原创向」时，把 `agent-presets\roleplay-friend`、`agent-presets\roleplay-oc` 也复制到 `%USERPROFILE%\.dsh\.agent-presets\` 下（三个预设共用同一引擎、数据目录各自独立：`.roleplay` / `.roleplay-friend` / `.roleplay-oc`）。

> 恋爱向为主体（角色扮演 + 桌宠一键启动）；朋友向为纯友谊轴（无助动/男友力，里程碑朋友向）；OC 原创向默认全空白（不预置关系/养成规则）。

### 2. 放置桌宠资源

把 `pet` 文件夹复制到你的 **DSH 工作区** 下的 `pet` 目录：

```
<你的 DSH 工作区>\pet
```

> 💡 路径已可配置（不再硬编码）。默认：数据根 = DSH 工作区（角色数据在工作区的 `.roleplay`）、桌宠资源 = DSH 工作区下 `pet`。
> 如需换桌宠资源位置，设置环境变量 `DSH_PET_DIR`（必须是工作区内）即可，**无需改代码**。

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

> 不设置也不影响：角色扮演仍可在预设列表里手动选择。⚠️ DSH 的预设切换只对「空白（还没发过第一句话）会话」生效，所以手动切换时请先选好预设、确认已应用，再发第一条消息。

### 5. 重启 DSH

重启后刷新页面。新建会话（默认角色扮演预设），侧栏点「▶ 开始扮演」即可开始。

## 使用

- 角色扮演入口：输入框上方 🎭 气泡按钮 → 右侧边栏
- 桌宠（附加）：侧栏「启动桌宠」按钮，或双击立绘对话、单击触摸、按住拖动
- 详细功能见 `README.md`

## 数据与文件

| 内容 | 位置 |
|------|------|
| 桌宠设置 | `<DSH 工作区>\pet\config.json` |
| 角色状态/设置 | `<DSH 工作区>\.roleplay\character.json` |
| 角色卡 | `<DSH 工作区>\.roleplay\cards.json` |
| 角色记忆（含未说出口的念头） | `<DSH 工作区>\.roleplay\mem-<角色名>.json` |
| 角色日记 | `<DSH 工作区>\.roleplay\diary-<角色名>-<日期>.md` |
| 桌面截图 | `<DSH 工作区>\.roleplay\desktop-look.png` |
| 桌宠嘀咕 | `<DSH 工作区>\.roleplay\bubble.txt` |

> `DSH 工作区` = DSH 运行/配置的 workspace 目录（即 `sandboxPolicy.workspaceRoot`），不是 `%USERPROFILE%\.dsh`（那是 DSH 配置目录）。
> 角色卡库（`cards.json`）是**全局共享**的：恋爱向/朋友向/OC 原创向的任何对话里保存的卡，其他对话都能看到并切换；角色记忆/日记/亲密度/养成按角色隔离，对话历史每会话独立。
