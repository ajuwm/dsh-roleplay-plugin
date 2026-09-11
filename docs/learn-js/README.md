# JS 学习手册(拿咱们这个插件当教材)

先说清楚:这套文档不是语法书,是「你已经有 C++ 底子,现在想真正把 JS 用起来」的那本手册。
咱们不空讲概念 —— 每一段代码都来自这个仓库里**真在跑的东西**,你读完能改、改完能看到后果。

--------------------------------------------
## 这套文档怎么用

三条,照着做就行:

1. **先把测试跑一遍**。终端里进到仓库根目录:
    cd D:\dsh\repo\dsh-roleplay-plugin
    node test/core.test.mjs
   看到「280 通过 / 0 失败」再往下读。手里有个能跑的东西,读代码才踏实。
2. **每章末尾都有「动手改一改」**。JS 的坑(类型乱转、this 抽风、异步顺序)光看是记不住的,
   非得自己撞一次。
3. **别拿 C++ 的直觉硬套**。文档里凡是写着【C++ 老习惯会坑你】的地方,都是那种
   「你会想当然,但 JS 偏不这样」的点。

--------------------------------------------
## 这教材是什么项目

一个 DSH(DeepSeek Harness)插件,给 DSH 加上「角色扮演」这个玩法:
恋爱向 / 朋友向 / OC 向三种预设,带对话侧栏、桌面桌宠、心跳、记忆、亲密度、剧情档案。

它长得像个玩具,但五脏俱全 —— 一个小团队能用上的技术它基本都摸了一遍:
Node 服务端、浏览器 UI、插件 DI 框架、子进程拉 Windows 窗口、测试、打包发布。

| 这一块 | 在哪 | 跑在哪 | 你会顺手学到 |
|---|---|---|---|
| 宿主桥接 | lib/index.js | Node 主进程 | Node API、HTTP 路由、模块解析、插件发布 |
| 浏览器半边 | lib/client.js | 浏览器 | DOM、fetch、React 那套心智、插件 UI 插槽 |
| 扮演引擎 | agent-presets/roleplay/*.mjs | DSH 的 agent 子系统 | ESM、异步、事件钩子、依赖注入、存盘 |
| 桌宠 | deskpet.mjs + pet/*.ps1 | Node 拉起 PowerShell | 子进程、编码坑、Windows 窗口 |
| 测试 | test/core.test.mjs | Node | 断言、测试组织、静态门禁 |

要一份「本项目用了哪些技术」的总账,直接翻 **11-技术全景.md**,那章是给这种问题准备的。

--------------------------------------------
## 跑起来需要的环境

- Node.js 22 以上(咱们在 24 上开发)
- Windows + PowerShell(桌宠和便签窗口要用)
- 不需要:TypeScript 编译器、webpack/vite 这类打包器 —— 这个项目刻意「零构建」,
  浏览器那半边是手写的,由 DSH 自己的模块加载器直接吃下去。

常用命令(背下来,能省很多时间):

    # 全量测试,改完代码必跑
    node test/core.test.mjs

    # 只想看某个文件语法有没有崩(比跑测试快得多)
    node --check agent-presets/roleplay/roleplay-host.mjs

    # 在 Node 里直接把一个模块 import 进来玩
    node -e "import('./agent-presets/roleplay/lib/chat-core.mjs').then(m => console.log(Object.keys(m)))"

    # 改完代码要让 DSH 用上新版本(刷新本地安装的副本)
    dsh plugin --profile web remove @ajuwm/dsh-roleplay-plugin
    dsh plugin --profile web add file:D:/dsh/repo/dsh-roleplay-plugin

【C++ 老习惯会坑你】JS 没有真正的「编译期」。node --check 只看看语法对不对,
真正的执行从 import 那一刻才开始。所以「语法检查过了」≠「跑起来没事」。

--------------------------------------------
## 怎么读

- 只想看懂这个项目 → 01、04、06、07、09
- 想系统补 JS → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 10
- 想看「怎么查 bug」 → 直接跳 09,三个真实事故的完整破案过程
- 想动手 → 10 里全是练习题,每题都指回项目里的真实代码
- 想知道「都用到了啥」 → 11 技术全景

   01-心智模型.md       JS 和 C++ 到底哪儿不一样
   02-语法对照.md       语法点一个个对着 C++ 讲
   03-异步.md           事件循环 / Promise / async-await / 怎么取消
   04-模块.md           ESM 和 CJS,以及一场真实血案
   05-Node.md           文件、进程、HTTP、沙箱
   06-插件与依赖注入.md   ctx / inject / provide / 事件 / waterfall / 隔离域
   07-浏览器侧.md        模块加载器 / fetch / React / CSS / 插槽
   08-工程实践.md        测试、调试、报错处理、编码坑、数据安全、发布
   09-实战复盘.md        三个 bug:从现象到根因
   10-练习与进阶.md      分层练习 + 下一步学什么
   11-技术全景.md        这个项目用到的所有技术,一网打尽

--------------------------------------------
## 一条必须记住的纪律

**别拿 PowerShell 的 Get-Content / Set-Content 去改带中文的代码文件。**
Windows PowerShell 5.1 默认按 ANSI 解码,一写就把文件写坏(中文变乱码、脚本直接报语法错)。
改文件用支持 UTF-8 的工具;PowerShell 脚本必须自带 UTF-8 BOM(开头三个字节 EF BB BF)。
这条不是洁癖 —— 这个项目真被坑过,08 章有完整复盘,测试里也专门加了门禁盯着它。
