# 05 · Node:文件、进程、HTTP,还有「沙箱」这回事

浏览器里的 JS 只能玩页面;Node 把它放出来 —— 于是你能读写文件、拉起别的程序、自己当服务器。
这个项目的「宿主桥接」就是一段完整的 Node 程序。

--------------------------------------------
## 5.1 Node 是什么,和浏览器有什么不同

同一个语言,两套运行环境:

| | 浏览器 | Node |
|---|---|---|
| 有什么 | DOM、window、fetch | fs、process、child_process |
| 没什么 | 文件系统、进程 | DOM、window |
| 模块 | 由打包器处理 | 原生 ESM/CJS |

所以这个插件被拆成两半不是巧合:要碰文件、要开进程的部分必须在 Node 里(lib/index.js),
画界面的部分必须在浏览器里(lib/client.js),两者靠 HTTP 说话。

--------------------------------------------
## 5.2 内置模块:这个项目用到的就这几个

    import os from 'node:os'                    // 系统信息(主目录、平台)
    import path from 'node:path'                // 拼路径、取扩展名、取目录
    import fs from 'node:fs'                    // 文件操作(桥接里直接用的)
    import { fileURLToPath } from 'node:url'    // file:// URL 转本地路径

path 的用法要养成习惯,别自己拼字符串:

    path.join('D:/dsh', 'pet', 'lihui.png')     // D:\dsh\pet\lihui.png(按平台给分隔符)
    path.dirname('/a/b/c.txt')                  // /a/b
    path.basename('/a/b/c.txt')                 // c.txt
    path.resolve('x')                           // 变成绝对路径

【C++ 老习惯会坑你】JS 字符串里写 Windows 路径,反斜杠要转义:
'D:\\dsh' 才等于 D:\dsh。偷懒办法是用正斜杠 'D:/dsh' —— Node 在 Windows 上也认。

项目里的真实用法(lib/index.js):

    const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

意思是「以本模块自己的 URL 为基准往上找一层」,拿到包根目录。
import.meta.url 是 ESM 特有的「我这个模块在哪」,比 C++ 的 __FILE__ 更实用 ——
它能直接算相对路径,而且是绝对路径,不受「当前工作目录」影响。

--------------------------------------------
## 5.3 两种文件 API:node:fs 和 DSH 的 fs 服务

这个项目里有两套「读写文件」的写法,别搞混。

**桥接里(lib/index.js)直接用 node:fs**:

    import fs from 'node:fs'
    fs.mkdirSync(dst, { recursive: true })
    fs.copyFileSync(s, d)
    fs.readFileSync(marker, 'utf8').trim() === PKG_VERSION

带 Sync 的是同步版(简单直接,适合启动时干一次的事);不带的是异步版(返回 Promise)。

**引擎里(roleplay-host.mjs)用的是 DSH 提供的 fs 服务**:

    const target = await resolveFile(REL_ROOT + '/character.json')
    await fs.writeText(target, JSON.stringify(stateForSave(), null, 2), undefined, undefined, policyFor())

为什么不直接用 node:fs?因为 DSH 的 fs 服务**带沙箱**:
它会按权限模式检查这个路径能不能写(工作区之外会被拒绝),这样插件就没法偷偷写你的系统盘。
这是安全设计,不是啰嗦。

【这里有个真实大坑】DSH 的 fs.resolve 返回的**不是字符串路径,而是个解析后的对象**
(里面有 displayPath、targetKey 这些字段)。旧代码把它当字符串使,写了:

    await fs.writeText(target + '.bak', cur, ...)     // 错!对象 + 字符串 = [object Object].bak

报错长这样(终端里那条):

    roleplay: backup failed TypeError: Cannot read properties of undefined (reading 'trim')

顺带还让「主存档损坏时从 .bak 恢复」这个功能从来没真正生效过。
修法是给 .bak 单独解析一次路径。教训:**用别人的 API,先搞清楚它返回的是什么。**

--------------------------------------------
## 5.4 拉起别的程序:子进程

桌宠窗口是个 PowerShell 脚本,得由 Node 拉起来。项目里用 subprocess.spawn:

    const proc = subprocess.spawn({
      argv: [exe, '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
             '-WindowStyle', 'Hidden', '-File', script,
             '-Image', image, '-Name', '桌宠', '-Port', String(PORT)],
      cwd: dir,
      stdio: {
        stdin: 'ignore',
        stdout: { collect: { maxBytes: 8192 } },
        stderr: { collect: { maxBytes: 8192 } },
      },
      graceMs: 3000,
    })

逐点解释:
- argv 是「参数数组」,不是一整条命令行字符串 —— 不用操心引号转义,中文参数也不会被搞坏;
- cwd 是子进程的工作目录(脚本里的相对路径以它为准);
- stdio 决定三个标准流怎么办:stdin 不管,stdout/stderr 各收集最多 8KB(出错时能打印,又不会吃爆内存);
- graceMs 是宽限时间;
- 拿到的 proc 能 terminate(),还能用 proc.done.then(...) 知道它什么时候退出。

【C++ 老习惯会坑你】子进程不是线程,它有自己的进程空间;
JS 里没有 waitpid,靠 Promise/回调。而且**一定要处理「它退出了」这件事**,
否则你会一直等一个早就死掉的窗口。

--------------------------------------------
## 5.5 自己当 HTTP 服务器(桥接的核心)

浏览器那半边要读数据、要发消息,怎么跟 Node 说话?项目选了最朴素的办法:
挂一个自己的 HTTP 前缀路由。

    const route = {
      kind: 'prefix',
      path: '/roleplay',
      handler: async (req, res) => {
        if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return }   // 只许本机
        if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return }
        const pathname = (req.url && new URL(req.url, 'http://x').pathname) || ''
        const endpoint = pathname.startsWith('/roleplay/') ? pathname.slice('/roleplay/'.length) : ''
        if (!endpoint) { res.writeHead(404); res.end('not found'); return }
        const payload = await readBody(req)                        // 读请求体(带大小上限)
        let out
        try { out = await dispatch(endpoint, payload) }             // 真正的分发
        catch (error) { out = { ok: false, error: { code: 'handler-error', message: String(error) } } }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      },
    }
    ctx.effect(() => webServer.register(route), 'roleplay-client: /roleplay raw prefix')

这段其实是一份「服务端安全清单」,照着抄都行:

1. **只允许本机访问**(检查来源地址)—— 防止别人从局域网捅进来;
2. **只接受 POST** —— 别让 GET 把状态改了;
3. **未知端点直接拒**(统一白名单)—— 别让人拿它当代理乱调;
4. **请求体设上限**(4MB 掐断)—— 防止内存被撑爆;
5. **整体包 try/catch**,永远回一个结构化 JSON;
6. **响应统一 { ok, value, error }** —— 前端只认这一种形状。

读 body 的那段也值得看(把流式拼包包成 Promise):

    function readBody(req, limit = 4 * 1024 * 1024) {
      return new Promise((resolve) => {
        let size = 0
        const chunks = []
        req.on('data', (c) => {
          size += c.length
          if (size > limit) { req.destroy(); resolve(null); return }
          chunks.push(c)
        })
        req.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
          catch { resolve({}) }
        })
        req.on('error', () => resolve({}))
      })
    }

「把回调包成 Promise」是 Node 里最常见的套路,记住这个形状就够了。

--------------------------------------------
## 5.6 定时任务

桥接里还挂了个「每 60 秒把备份镜像到用户目录」的任务:

    timerSvc.interval(() => {
      mirrorBackups().catch((e) => console.error('[roleplay-backup] mirror failed', e))
    }, 60000)

两个细节:异步函数后面**必须接 .catch**,不然失败会变成「未处理的 Promise 拒绝」;
间隔任务里做的事要幂等(重复跑也不能出错)。

--------------------------------------------
## 5.7 环境变量与「我在哪」

    process.env.DSH_HOME          // DSH 的家目录(默认是用户目录下的 .dsh)
    process.env.DSH_PET_DIR       // 本插件支持的自定义桌宠资源目录
    process.cwd()                 // 进程的当前工作目录(不等于模块所在目录!)

这段判断可以背下来:

    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

「有配置用配置,没有就按约定推一个」—— 写工具的通用姿势。

【C++ 老习惯会坑你】别把「进程启动目录」当成「程序所在目录」。
用户可能在 C:\Program Files\nodejs 里敲 dsh web,那时 cwd 就是那个目录;
要拿自己文件的位置,用 import.meta.url。

--------------------------------------------
## 动手改一改

1. 跑一次 node -e "console.log(process.cwd())",再写个 .mjs 打印 import.meta.url,
   体会这两个「我在哪」的区别。
2. 在 test/core.test.mjs 里找 T41(桥接黑盒测试),看它怎么 mock 出 webServer 和 agents ——
   这就是「不启动真 DSH 也能测 HTTP 路由」的办法。
3. 用 Node 起个自己的小服务:
   node -e "require('node:http').createServer((q,s)=>s.end('hi')).listen(3999)"
   然后浏览器打开 http://127.0.0.1:3999。

--------------------------------------------
## 这一章记住三件事

1. path.join 拼路径;import.meta.url 才是「我在哪」;
2. 子进程要管好 stdio 和退出;定时任务要接 .catch;
3. 对外接口守住五件事:来源、方法、白名单、大小上限、统一错误形状。

下一章:插件与依赖注入 —— 这套框架的世界观,也是这个项目的地基。
