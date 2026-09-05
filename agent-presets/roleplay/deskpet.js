// 持久化桌宠插件 v11（HTTP 架构）：进程内 pending + DSH webServer 路由 + 会话事件轮询捕获。
// 预设插件运行在 standing 纤维（无 ctx.agent）：目标会话按 preset id 从活跃根会话解析。
// 对外：/pet/* HTTP 路由（窗口用）+ `deskpet` 服务（侧栏桥接用）。
module.exports = {
  name: 'deskpet',
  inject: ['agents', 'subprocess', 'timer', 'fs', 'sandboxPolicy', 'webServer'],
  apply(ctx, config) {
    const agents = ctx.agents
    const subprocess = ctx.subprocess
    const fs = ctx.fs
    const webServer = ctx.webServer
    const PRESET_ID = (config && config.presetId) || 'deskpet'
    // 路径根：桌宠资源/嘀咕数据均在 DSH 工作区内（fs sandbox=workspace-write，仅允许写工作区）。
    // DSH_PET_DIR 可覆盖桌宠资源目录（须在工作区内）。
    // ⚠ 关键：sandboxPolicy.workspaceRoot 是 DSH 进程启动目录（宿主组合里配置为 process.cwd()，
    // 例如在 C:\Program Files\nodejs 里执行 "dsh web" 时），并不等于会话工作区！
    // 必须优先用目标会话的 header.cwd（与 roleplay-host.mjs 的 workspaceRoot() 同一口径）。
    const os = require('node:os'), path = require('node:path')
    function workspaceRoot() {
      try {
        if (targetSessionId) {
          const a = agents.get(targetSessionId)
          if (a && a.session && a.session.header && a.session.header.cwd) return a.session.header.cwd
        }
      } catch (e) { console.error('[deskpet] workspaceRoot fall', e && e.message) }
      return (ctx.sandboxPolicy && ctx.sandboxPolicy.workspaceRoot) || process.cwd() || os.homedir()
    }
    function petDir() { return process.env.DSH_PET_DIR || path.join(workspaceRoot(), 'pet') }
    const IMAGE = () => petDir() + '\\lihui.png'
    const SCRIPT = () => petDir() + '\\pet-window.ps1'
    const NOTE_SCRIPT = () => petDir() + '\\note-window.ps1'
    const PORT = (webServer && typeof webServer.port === 'number') ? webServer.port : 3080

    let targetSessionId = null
    let petProc = null
    let noteProc = null
    let pending = null
    let seq = 0
    let petEnabled = true
    let noteEnabled = true
    let owner = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const routeDisposers = []

    // 目标会话：按 preset id 从活跃根会话解析（多会话共享一个窗口，取最近活跃）。
    function livePresetRoots() {
      const out = []
      let roots = []
      try { roots = agents.roots() || [] } catch (e) { return out }
      for (const agent of roots) {
        try {
          const s = agent.session
          if (!s) continue
          let pid = s.header && s.header.agentPreset ? s.header.agentPreset : null
          const events = s.events
          if (Array.isArray(events)) {
            for (let i = events.length - 1; i >= 0; i--) {
              const ev = events[i]
              if (ev && ev.type === 'agent-preset/selected' && ev.data && ev.data.agentPreset) {
                pid = ev.data.agentPreset
                break
              }
            }
          }
          if (pid === PRESET_ID) out.push(agent)
        } catch (e) { console.error("[deskpet] skip", e) }
      }
      return out
    }

    function resolveTarget() {
      const hits = livePresetRoots()
      if (hits.length === 0) return targetSessionId
      let best = hits[0]
      let bestSeq = -1
      for (const a of hits) {
        try {
          const ev = a.session.events
          const lastSeq = Array.isArray(ev) && ev.length > 0 && typeof ev[ev.length - 1].seq === 'number' ? ev[ev.length - 1].seq : 0
          if (lastSeq > bestSeq) { bestSeq = lastSeq; best = a }
        } catch (e) { console.error("[deskpet] skip", e) }
      }
      targetSessionId = best.id
      return targetSessionId
    }

    function getPolicy() {
      try {
        if (targetSessionId) {
          const agent = agents.get(targetSessionId)
          if (agent && agent.session) return ctx.sandboxPolicy.resolve({ session: agent.session })
        }
      } catch (e) { console.error("[deskpet] fall through", e) }
      try { return ctx.sandboxPolicy.resolve() } catch (e) { return null }
    }

    async function writeConfig(patch) {
      try {
        const target = await fs.resolve(path.join(petDir(), 'config.json'))
        let cfg = {}
        try {
          const raw = await fs.readText(target)
          cfg = JSON.parse(raw || '{}')
        } catch (e) { /* 首次/缺失: 从空配置开始 */ }
        Object.assign(cfg, patch)
        await fs.writeText(target, JSON.stringify(cfg), undefined, undefined, getPolicy())
      } catch (e) { console.error("[deskpet] keep in-memory state", e) }
    }

    function armTimeout(req) {
      if (req.disposer) { try { req.disposer() } catch (e) {} }
      req.disposer = ctx.timeout(() => {
        if (pending === req && !req.done) {
          req.done = true
          finalizePending(req)
        }
      }, 150000)
    }

    function sendPetMessage(text, reqId) {
      if (!targetSessionId) return { ok: false, error: 'no-session' }
      const agent = agents.get(targetSessionId)
      if (!agent) return { ok: false, error: 'no-agent' }
      if (pending) return { ok: false, error: 'busy' }
      const id = 'pet-' + Date.now().toString(36) + '-' + (++seq)
      const message = {
        id,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'deskpet' },
      }
      try {
        agent.send(message, 'next-turn', true)
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
      const req = {
        id,
        userMsgId: id,
        reqId,
        sawUser: false,
        collecting: false,
        texts: [],
        done: false,
        disposer: null,
        collectedThrough: 0,
      }
      pending = req
      armTimeout(req)
      return { ok: true, id }
    }

    function finalizePending(req) {
      if (req.disposer) { try { req.disposer() } catch (e) {} }
      if (pending === req) pending = null
    }

    // 轮询会话事件捕获回复：turn/end 按 seq 比较（规避 live 数组乱序）。
    function checkPending() {
      if (!pending || !targetSessionId) return
      const agent = agents.get(targetSessionId)
      if (!agent) return
      const session = agent.session
      if (!session || !Array.isArray(session.events)) return
      const req = pending
      const events = session.events
      let userMsgSeq = 0
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]
        if (!ev || typeof ev.type !== 'string') continue
        const seqNum = typeof ev.seq === 'number' ? ev.seq : 0
        if (ev.type === 'user/message' && ev.data && ev.data.id === req.userMsgId) {
          if (!req.sawUser) {
            req.sawUser = true
            req.collecting = true
            armTimeout(req)
          }
          userMsgSeq = seqNum
        } else if (req.collecting && !req.done && ev.type === 'assistant/message' && userMsgSeq > 0 && seqNum > userMsgSeq && seqNum > req.collectedThrough) {
          const m = ev.data && ev.data.message
          if (m && Array.isArray(m.content)) {
            for (const b of m.content) {
              if (b && b.type === 'text' && typeof b.text === 'string' && b.text) req.texts.push(b.text)
            }
          }
        } else if (req.sawUser && ev.type === 'turn/end' && userMsgSeq > 0 && seqNum > userMsgSeq) {
          req.done = true
          return
        }
      }
      const last = events[events.length - 1]
      if (last && typeof last.seq === 'number') req.collectedThrough = last.seq
    }

    // 配置监视：config.json 的 enabled 驱动窗口起停（侧栏按钮 / 手动改文件均生效）。
    // 配置监视：config.json 的 enabled 驱动窗口起停（侧栏按钮 / 手动改文件均生效）。
    // 注意：配置缺失/损坏时【默认启用】并继续尝试启动（与“启动中…卡死”问题一致——
    // 之前读不到配置会整个静默跳过，永远不调用 startPet/startNotes）。
    async function checkConfig() {
      let cfg = {}
      try {
        const target = await fs.resolve(path.join(petDir(), 'config.json'))
        const raw = await fs.readText(target)
        cfg = JSON.parse(raw || '{}')
      } catch (e) { console.error('[deskpet] config unreadable, start with defaults', e && e.message) }
      const enabled = cfg && typeof cfg.enabled === 'boolean' ? cfg.enabled : true
      const notes = cfg && typeof cfg.noteEnabled === 'boolean' ? cfg.noteEnabled : true
      petEnabled = enabled
      noteEnabled = notes
      if (petEnabled && !petProc) {
        startPet().catch((e) => console.error('[deskpet] config start', e))
      } else if (!petEnabled && petProc) {
        stopPet()
      }
      if (noteEnabled && !noteProc) {
        startNotes().catch((e) => console.error('[deskpet] config notes start', e))
      } else if (!noteEnabled && noteProc) {
        stopNotes()
      }
    }

    async function drain() {
      try {
        checkPending()
        await checkConfig()
        resolveTarget()
      } catch (e) {
        console.error('[deskpet] drain', e)
      }
    }

    ctx.interval(() => { drain() }, 300)

    async function startPet() {
      if (petProc) return
      let exe = 'powershell.exe'
      try { exe = await subprocess.resolveExecutable('powershell.exe') } catch (e) { }
      const dir = petDir()
      const script = SCRIPT()
      const image = IMAGE()
      console.error('[deskpet] startPet dir=' + dir + ' script=' + script + ' image=' + image + ' port=' + PORT)
      const proc = subprocess.spawn({
        argv: [exe, '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Image', image, '-Name', '\u684c\u5ba0', '-Port', String(PORT)],
        cwd: dir,
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: 8192 } },
          stderr: { collect: { maxBytes: 8192 } },
        },
        graceMs: 3000,
      })
      petProc = proc
      proc.done.then((outcome) => {
        console.log('[deskpet] window exited', JSON.stringify(outcome))
        if (petProc === proc) petProc = null
      }).catch((e) => {
        console.error('[deskpet] window spawn failed', e)
        if (petProc === proc) petProc = null
      })
    }

    function stopPet() {
      if (petProc) {
        try { petProc.terminate() } catch (e) {}
        petProc = null
      }
    }

    // 便签纸条窗(独立进程, 与桌宠同技术栈): 启动/停止由 config.noteEnabled 驱动
    async function startNotes() {
      if (noteProc) return
      let exe = 'powershell.exe'
      try { exe = await subprocess.resolveExecutable('powershell.exe') } catch (e) { }
      const dir = petDir()
      const script = NOTE_SCRIPT()
      console.error('[deskpet] startNotes dir=' + dir + ' script=' + script + ' port=' + PORT)
      const proc = subprocess.spawn({
        argv: [exe, '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Port', String(PORT)],
        cwd: dir,
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: 8192 } },
          stderr: { collect: { maxBytes: 8192 } },
        },
        graceMs: 3000,
      })
      noteProc = proc
      proc.done.then((outcome) => {
        console.log('[deskpet] note window exited', JSON.stringify(outcome))
        if (noteProc === proc) noteProc = null
      }).catch((e) => {
        console.error('[deskpet] note window spawn failed', e)
        if (noteProc === proc) noteProc = null
      })
    }

    function stopNotes() {
      if (noteProc) {
        try { noteProc.terminate() } catch (e) {}
        noteProc = null
      }
    }

    // ── HTTP 路由（窗口对话） ────────────────────────────────────────────────
    function json(res, code, obj) {
      try {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      } catch (e) { /* client gone */ }
    }
    function readBody(req) {
      return new Promise((resolve) => {
        let buf = ''
        req.on('data', (c) => { buf += c; if (buf.length > 1e6) { try { req.destroy() } catch (e) {} } })
        req.on('end', () => resolve(buf))
        req.on('error', () => resolve(''))
      })
    }
    function queryParam(req, name) {
      const q = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : ''
      for (const part of q.split('&')) {
        if (part.indexOf(name + '=') === 0) {
          try { return decodeURIComponent(part.slice(name.length + 1)) } catch (e) { return '' }
        }
      }
      return ''
    }

    routeDisposers.push(webServer.register({ kind: 'exact', path: '/pet/chat', handler: async (req, res) => {
      const body = await readBody(req)
      let text = ''
      let reqId = ''
      try { const p = JSON.parse(body || '{}'); text = p.text; reqId = p.id } catch (e) {}
      if (typeof text !== 'string' || !text.trim()) return json(res, 400, { ok: false, error: 'empty' })
      json(res, 200, sendPetMessage(text.trim(), String(reqId || 'r' + Date.now())))
    } }))

    routeDisposers.push(webServer.register({ kind: 'exact', path: '/pet/touch', handler: async (req, res) => {
      const body = await readBody(req)
      let kind = 'pat'
      let reqId = ''
      try { const p = JSON.parse(body || '{}'); kind = p.kind; reqId = p.id } catch (e) {}
      const lines = {
        pat: '\uff08\u4f60\u4f38\u51fa\u624b\uff0c\u8f7b\u8f7b\u6478\u4e86\u6478\u5979\u7684\u5934\uff09',
        tickle: '\uff08\u4f60\u4f38\u624b\u631b\u4e86\u631b\u5979\u7684\u75d2\u75d2\uff09',
        poke: '\uff08\u4f60\u7528\u624b\u6307\u8f7b\u8f7b\u6233\u4e86\u6233\u5979\u7684\u8138\u989a\uff09',
        hug: '\uff08\u4f60\u5f20\u5f00\u53cc\u81c2\uff0c\u7ed9\u4e86\u5979\u4e00\u4e2a\u5927\u5927\u7684\u62e5\u62b1\uff09',
        brush: '\uff08\u4f60\u8f7b\u8f7b\u5e2e\u5979\u68b3\u4e86\u68b3\u5934\u53d1\uff0c\u5979\u7f29\u4e86\u7f29\u8116\u5b50\uff0c\u6709\u70b9\u75d2\uff09',
        handshake: '\uff08\u4f60\u4f38\u51fa\u624b\uff0c\u5979\u60a3\u4e86\u4e00\u4e0b\u2014\u2014\u7136\u540e\u8f7b\u8f7b\u63e1\u4f4f\u4e86\uff0c\u6307\u5c16\u6709\u70b9\u51c9\uff09',
        kiss: '\uff08\u4f60\u503e\u8eab\uff0c\u5728\u5979\u989d\u5934\u8f7b\u8f7b\u843d\u4e0b\u4e00\u4e2a\u543b\uff09',
        pout: '\uff08\u4f60\u6545\u610f\u9017\u5979\uff0c\u5979\u9f13\u8d77\u4e86\u816e\u5e2e\u5b50\uff0c\u5047\u88c5\u751f\u6c14\uff09',
      }
      json(res, 200, sendPetMessage(lines[kind] || lines.pat, String(reqId || 'r' + Date.now())))
    } }))

    // 桌宠投喂：注入投喂旁白走对话链路（AI 调 roleplay_feed 从背包扣食物；背包空她会转达）
    routeDisposers.push(webServer.register({ kind: 'exact', path: '/pet/feed', handler: async (req, res) => {
      const text = '\uff08\u4f60\u628a\u4e00\u4efd\u70b9\u5fc3\u8f7b\u8f7b\u9012\u5230\u5979\u9762\u524d\uff0c\u60f3\u5582\u5979\u5403\u70b9\u4e1c\u897f\uff0c\u8bf7\u8c03\u7528 roleplay_feed \u5904\u7406\u8fd9\u6b21\u6295\u5582\uff09'
      json(res, 200, sendPetMessage(text, String('r' + Date.now())))
    } }))

    routeDisposers.push(webServer.register({ kind: 'exact', path: '/pet/poll', handler: (req, res) => {
      const id = queryParam(req, 'id')
      if (pending && pending.reqId === id) {
        if (pending.done) {
          const text = pending.texts.join('')
          const r = { status: 'done', text }
          finalizePending(pending)
          return json(res, 200, r)
        }
        return json(res, 200, { status: pending.sawUser ? 'thinking' : 'queued', text: '' })
      }
      json(res, 200, { status: 'none', text: '' })
    } }))

    // 桌宠嘀咕：角色没来得及说出口的念头（roleplay 写入 bubble.txt），窗口低频轮询展示
    let lastBubbleShown = ''
    routeDisposers.push(webServer.register({ kind: 'exact', path: '/pet/bubble', handler: async (req, res) => {
      try {
        const target = await fs.resolve(path.join(workspaceRoot(), '.roleplay', 'bubble.txt'))
        const info = await fs.stat(target)
        if (info === undefined) return json(res, 200, { text: '' })
        const text = (await fs.readText(target)).trim()
        if (!text || text === lastBubbleShown) return json(res, 200, { text: '' })
        lastBubbleShown = text
        json(res, 200, { text })
      } catch (e) {
        json(res, 200, { text: '' })
      }
    } }))

    routeDisposers.push(webServer.register({ kind: 'exact', path: '/pet/status', handler: (req, res) => {
      json(res, 200, { ok: true, window: petProc ? 'running' : 'stopped', enabled: petEnabled, session: targetSessionId })
    } }))

    // 桌宠心情角标: 读共享 character.json 的 stats/relation 推导表情(文件级, 无会话依赖)
    routeDisposers.push(webServer.register({ kind: 'exact', path: '/pet/mood', handler: async (req, res) => {
      const idle = { emoji: '\uD83D\uDCA4', label: '\u672A\u5F00\u6F14', tone: 'idle' }
      try {
        const target = await fs.resolve(path.join(workspaceRoot(), '.roleplay', 'character.json'))
        const info = await fs.stat(target)
        if (info === undefined) return json(res, 200, { ok: true, mood: idle })
        const st = JSON.parse(await fs.readText(target))
        const s = (st && st.stats) || {}
        const rel = (st && st.relation) || {}
        let mood = idle
        if ((s.hp || 100) <= 0) mood = { emoji: '\uD83D\uDCA4', label: '\u7761\u68A6\u4E2D', tone: 'red' }
        else if ((s.health || 85) <= 10) mood = { emoji: '\uD83E\uDD15', label: '\u5371\u6025', tone: 'red' }
        else if ((s.satiety || 75) < 20 || (s.health || 85) < 40) mood = { emoji: '\uD83E\uDD12', label: '\u865A\u5F31', tone: 'orange' }
        else if ((s.satiety || 75) < 40) mood = { emoji: '\uD83C\uDF5A', label: '\u997F\u4E86', tone: 'yellow' }
        else if ((s.mood || 70) < 30) mood = { emoji: '\uD83D\uDC3F', label: '\u4F4E\u843D', tone: 'yellow' }
        else if ((rel.heart || 0) >= 67) mood = { emoji: '\uD83D\uDC97', label: '\u5FC3\u52A8', tone: 'pink' }
        else if ((rel.favor || 0) >= 67) mood = { emoji: '\uD83E\uDD70', label: '\u4EB2\u8FD1', tone: 'green' }
        else if ((rel.favor || 0) >= 34) mood = { emoji: '\uD83D\uDE42', label: '\u4E0D\u9519', tone: 'green' }
        json(res, 200, { ok: true, mood })
      } catch (e) {
        json(res, 200, { ok: true, mood: idle })
      }
    } }))

    routeDisposers.push(webServer.register({ kind: 'exact', path: '/pet/start', handler: async (req, res) => {
      petEnabled = true
      await writeConfig({ enabled: true })
      if (!petProc) startPet().catch((e) => console.error('[deskpet] start', e))
      json(res, 200, { ok: true })
    } }))

    routeDisposers.push(webServer.register({ kind: 'exact', path: '/pet/stop', handler: async (req, res) => {
      petEnabled = false
      await writeConfig({ enabled: false })
      stopPet()
      json(res, 200, { ok: true })
    } }))

    // ── 对外服务（侧栏桥接） ────────────────────────────────────────────────
    ctx.provide('deskpet', {
      getStatus() {
        return { window: petProc ? 'running' : 'stopped', enabled: petEnabled }
      },
      async start() {
        petEnabled = true
        await writeConfig({ enabled: true })
        if (!petProc) startPet().catch((e) => console.error('[deskpet] start', e))
        return { ok: true }
      },
      async stop() {
        petEnabled = false
        await writeConfig({ enabled: false })
        stopPet()
        return { ok: true }
      },
    })

    ctx.on('dispose', () => {
      stopPet()
      stopNotes()
      for (const d of routeDisposers.splice(0)) { try { d() } catch (e) {} }
    })
  },
}
