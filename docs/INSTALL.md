# 桌宠 · 角色扮演 插件安装说明

适用于 DSH（DeepSeek Harness）Web 版。安装前请先阅读 `README.md` 了解功能。

---

## 目录结构

```
dsh-deskpet-plugin/
├── README.md                 # 插件功能介绍
├── INSTALL.md                # 本安装说明
├── pet/                      # 桌宠窗口资源（立绘、窗口脚本、截图脚本）
├── agent-presets/
│   ├── deskpet/              # 整合预设：桌宠 + 角色扮演（推荐，含预设技能）
│   └── roleplay/             # 独立预设：仅角色扮演（可选）
├── roleplay-client/          # 浏览器侧边栏桥接（侧栏 UI）
└── dependencies/
    └── node_modules/         # 视觉插件及其离线依赖（101 个包，含 sharp 平台二进制）
```

## 依赖

**dsh-vision-router（看桌面功能）已随压缩包附带**（`dependencies/node_modules`），
无需联网安装。sharp 为 Windows x64 平台二进制；其他平台请改用官方在线安装（附录 A）。

## 安装步骤

### 1. 放置预设

把 `agent-presets\deskpet` 整个文件夹复制到：

```
%USERPROFILE%\.dsh\.agent-presets\deskpet
```

（可选）把 `agent-presets\roleplay` 复制到：

```
%USERPROFILE%\.dsh\.agent-presets\roleplay
```

### 2. 放置桌宠资源

把 `pet` 文件夹复制到：

```
D:\dsh\pet
```

> ⚠️ 如果放到其他位置，需要修改两处硬编码路径：
> - `agent-presets\deskpet\deskpet.js` 顶部 `PET_DIR`（第 13 行附近）
> - `agent-presets\deskpet\roleplay-host.mjs` 里 `D:\dsh\pet\desktop-shot.ps1` 和 `D:\dsh\pet\pet-window.ps1` 相关路径

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

### 3b. 放置视觉插件（看桌面功能）

把 `dependencies\node_modules` 里的**所有内容**合并复制到：

```
%USERPROFILE%\.dsh\profiles\web\node_modules\
```

（即把 `dsh-vision-router`、`sharp`、`potrace`、`puppeteer-core`、`undici` 等
101 个包全部拷进去，遇到同名目录直接合并/覆盖。）

然后在同一个 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: vision-router
      name: dsh-vision-router
      config:
        progressiveTools: false
```

### 4. 设为默认预设（可选）

编辑 `%USERPROFILE%\.dsh\settings.yaml`：

```yaml
agent-presets:
  default: deskpet
```

### 5. 重启 DSH

重启后刷新页面。新建会话（默认桌宠预设），侧栏点「▶ 开始扮演」即可开始。

## 使用

- 角色扮演入口：输入框上方 🎭 气泡按钮 → 右侧边栏
- 桌宠：侧栏「启动桌宠」按钮，或双击立绘对话、单击触摸、按住拖动
- 详细功能见 `README.md`

## 数据与文件

| 内容 | 位置 |
|------|------|
| 桌宠设置 | `D:\dsh\pet\config.json` |
| 角色状态/设置 | `D:\dsh\.roleplay\character.json` |
| 角色卡 | `D:\dsh\.roleplay\cards.json` |
| 角色记忆（含未说出口的念头） | `D:\dsh\.roleplay\mem-<角色名>.json` |
| 角色日记 | `D:\dsh\.roleplay\diary-<角色名>-<日期>.md` |
| 桌面截图 | `D:\dsh\.roleplay\desktop-look.png` |
| 桌宠嘀咕 | `D:\dsh\.roleplay\bubble.txt` |

---

## 附录 A：安装 dsh-vision-router（看桌面功能）

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router
```

离线安装（已下载 tgz）：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router --file C:\路径\dsh-vision-router-1.5.3.tgz
```

安装后确认 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 包含：

```yaml
- insert:
    - id: vision-router
      name: dsh-vision-router
      config:
        progressiveTools: false
```

> 注：当前版本（1.5.3）的图片回合改写链路与本版 DSH 不兼容，
> 插件已内置绕过方案（看桌面走文本+视觉工具链路），不影响使用。
> 直接向对话上传图片仍可能触发 DeepSeek 图片不支持报错。
