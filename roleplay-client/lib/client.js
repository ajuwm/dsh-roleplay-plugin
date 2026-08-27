// DSH 角色扮演插件 · 持久化 Browser half（手写合规 client bundle）
// 契约（见 packages/client/tsdown.client.ts 的 clientConfig）：
//   - CJS 工厂经 `window.__ModuleLoader__.load({ id, factory })` 注册；
//   - `id` 必须等于 boot graph 的行 id（包名 '@dsh-user/roleplay-client'）；
//   - 外部依赖只允许模块表种子词（react 等），通过注入的 require 解析；
//   - factory 的返回值就是 Cordis 插件（{ name, inject, apply }）。
// UI：输入框上方右对齐入口按钮 + 右侧 260px 边栏（角色头/记忆/日记/演出区）。
// 数据：经 Connection RPC 通道 `/roleplay`（get-state / stop）读取主机侧
//       per-session 的 `roleplay` 服务。

window.__ModuleLoader__.load({
  id: '@dsh-user/roleplay-client',
  factory: function (require) {
    var React = require('react')

    // 亲密度常量（与 roleplay-host.mjs 保持一致）
    var REL_DEFS = [['favor', '好感', 'satiety'], ['trust', '信任', 'health'], ['heart', '心动', 'mood']]
    var REL_TIER = { favor: ['疏离', '亲近', '倾慕'], trust: ['戒备', '放心', '依赖'], heart: ['无感', '在意', '心动'] }
    var BF_DEFS = [['reliability', '靠谱'], ['empathy', '感性'], ['stability', '情绪稳'], ['ambition', '上进']]
    var relTier = function (k, v) { return REL_TIER[k][v <= 33 ? 0 : v <= 66 ? 1 : 2] }
    var relRecentText = function (last) {
      if (!last) return ''
      var bits = []
      var keys = [['favor', '好感'], ['trust', '信任'], ['heart', '心动']]
      for (var i = 0; i < keys.length; i++) {
        var v = last[keys[i][0]]
        if (typeof v === 'number' && v !== 0) bits.push((v > 0 ? '+' : '') + v + ' ' + keys[i][1])
      }
      return bits.join(' · ') || '尚无变化'
    }

    // 商店目录不再在客户端复制：价格单一数据源来自 roleplay-host 的 get-state（shop 字段），
    // 显示与扣款始终一致（历史教训：双端各写一份价格表曾出现显示 40 扣 30 的不一致）。
    var STAT_DEFS = [['satiety', '饱食'], ['health', '健康'], ['mood', '心情'], ['hp', '生命']]

    var plugin = {
      name: 'roleplay-client',
      inject: ['slots'],
      apply: function (ctx) {
        var slots = ctx.slots
        // DSH 0.1.1-rc.2 起不再有 connection 服务：改用同源 fetch 直连
        // 宿主桥接挂载的 /roleplay/<endpoint> 前缀（自有协议：POST JSON → {ok,value,error}）
        var rpc = function (ep, payload) {
          return fetch('/roleplay/' + ep, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload || {}),
          }).then(function (r) {
            return r.json().catch(function () { return { ok: false, error: { message: 'HTTP ' + r.status } } })
          })
        }

        // ── 样式（随插件卸载移除） ──────────────────────────────────────────
        var style = document.createElement('style')
        style.dataset.plugin = '@dsh-user/roleplay-client'
        style.textContent = [
          '.rp-dock { display:flex; justify-content:flex-end; padding:4px 14px; font-size:12px; }',
          '.rp-dock-btn { display:inline-flex; align-items:center; gap:8px; padding:5px 14px; border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.08); color:var(--color-text, inherit); cursor:pointer; font-size:12px; border-radius:20px; }',
          '.rp-dock-btn:hover { background:rgba(128,128,128,.16); }',
          '.rp-dock-btn.rp-open { background:rgba(128,128,128,.22); border-color:rgba(128,128,128,.6); }',
          '.rp-dock-name { font-weight:600; }',
          '.rp-dock-meta { opacity:.6; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
          '.rp-sb { position:fixed; top:0; right:0; bottom:0; width:min(300px,96vw); background:rgba(18,20,26,.97); color:#ececec; border-left:1px solid rgba(128,128,128,.28); z-index:1400; display:flex; flex-direction:column; font-size:13px; box-shadow:-8px 0 30px rgba(0,0,0,.35); }',
          '.rp-sb-head { padding:12px 14px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(128,128,128,.16); flex:0 0 auto; }',
          '.rp-sb-title { font-weight:700; font-size:14px; }',
          '.rp-sb-close { border:none; background:transparent; color:inherit; cursor:pointer; font-size:18px; line-height:1; opacity:.6; padding:2px 8px; border-radius:6px; }',
          '.rp-sb-close:hover { opacity:1; background:rgba(128,128,128,.15); }',
          '.rp-sb-body { flex:1; overflow-y:scroll; padding:10px 14px; display:flex; flex-direction:column; gap:6px; min-height:0; scrollbar-width:thin; scrollbar-color:rgba(128,128,128,.4) transparent; }',
          '.rp-sb-body::-webkit-scrollbar { width:8px; }',
          '.rp-sb-body::-webkit-scrollbar-thumb { background:rgba(128,128,128,.4); border-radius:4px; }',
          '.rp-sb-row { display:flex; gap:10px; padding:3px 0; border-top:1px solid rgba(128,128,128,.12); flex:0 0 auto; }',
          '.rp-sb-k { flex:0 0 44px; opacity:.55; }',
          '.rp-sb-row > span:last-child { flex:1; min-width:0; overflow-wrap:break-word; }',
          '.rp-sb-name { font-size:18px; font-weight:700; flex:0 0 auto; }',
          '.rp-sb-persona { opacity:.75; line-height:1.6; max-height:140px; overflow-y:auto; flex:0 0 auto; scrollbar-width:thin; }',
          '.rp-sb-status { display:flex; flex-wrap:wrap; gap:4px 12px; opacity:.85; }',
          '.rp-sb-section { border-top:1px solid rgba(128,128,128,.18); padding-top:5px; display:flex; flex-direction:column; min-height:0; flex:0 0 auto; }',
          '.rp-sb-section-title { font-size:11px; opacity:.5; letter-spacing:2px; margin-bottom:3px; flex:0 0 auto; }',
          '.rp-sb-scroll { overflow-y:scroll; font-size:12px; line-height:1.6; min-height:0; scrollbar-width:thin; scrollbar-color:rgba(128,128,128,.35) transparent; }',
          '.rp-sb-scroll::-webkit-scrollbar { width:6px; }',
          '.rp-sb-scroll::-webkit-scrollbar-thumb { background:rgba(128,128,128,.35); border-radius:3px; }',
          '.rp-sb-scroll .rp-sb-item { padding:1px 0; opacity:.85; }',
          '.rp-sb-scroll .rp-sb-item-dim { opacity:.55; }',
          '.rp-sb-mem { height:110px; flex:0 0 110px; }',
          '.rp-sb-diary { height:140px; flex:0 0 140px; }',
          '.rp-sb-diary-date { opacity:.5; font-size:11px; margin-bottom:2px; }',
          '.rp-sb-empty { opacity:.45; font-size:12px; line-height:1.6; }',
          '.rp-sb-stage-wrap { flex:1 1 auto; min-height:50px; border-top:1px solid rgba(128,128,128,.18); padding-top:5px; display:flex; flex-direction:column; min-height:0; }',
          '.rp-sb-stage-title { font-size:11px; opacity:.5; letter-spacing:2px; margin-bottom:3px; flex:0 0 auto; }',
          '.rp-sb-stage-list { flex:1; overflow-y:scroll; display:flex; flex-direction:column; gap:2px; min-height:0; scrollbar-width:thin; }',
          '.rp-sb-stage-item { font-style:italic; opacity:.85; line-height:1.55; }',
          '.rp-sb-stage-env { opacity:.65; }',
          '.rp-sb-stop { margin-top:6px; padding:8px 0; border:1px solid rgba(220,100,100,.5); border-radius:8px; background:transparent; color:#e8a0a0; cursor:pointer; font-size:13px; flex:0 0 auto; }',
          '.rp-sb-stop:hover { background:rgba(220,100,100,.12); }',
          '.rp-sb-pet-btns { display:flex; gap:8px; margin-top:6px; }',
          '.rp-sb-room-badge { flex:1 1 auto; font-size:13px; color:inherit; opacity:.92; }',
          '.rp-turn-badge { display:inline-flex; align-items:center; gap:4px; margin:6px 0 2px; padding:2px 10px; border-radius:999px; font-size:11px; opacity:.55; border:1px solid rgba(128,128,128,.25); background:rgba(128,128,128,.06); user-select:none; }',
          '.rp-turn-badge:hover { opacity:.85; }',
          '.rp-sb-pet-btn { flex:1; padding:6px 0; border-radius:8px; cursor:pointer; font-size:13px; }',
          '.rp-sb-pet-on { border:1px solid rgba(120,200,140,.5); background:transparent; color:#a8d8b4; }',
          '.rp-sb-pet-on:hover { background:rgba(120,200,140,.12); }',
          '.rp-sb-pet-off { border:1px solid rgba(200,150,80,.5); background:transparent; color:#e0c090; }',
          '.rp-sb-pet-off:hover { background:rgba(200,150,80,.12); }',
          '.rp-sb-card-row { display:flex; gap:8px; align-items:center; margin-top:6px; }',
          '.rp-sb-card-select { flex:1; min-width:0; padding:5px 8px; border-radius:8px; border:1px solid rgba(128,128,128,.4); background:rgba(128,128,128,.1); color:inherit; font-size:13px; }',
          '.rp-sb-card-switch { padding:6px 12px; border-radius:8px; border:1px solid rgba(120,160,220,.5); background:transparent; color:#a8c8e8; cursor:pointer; font-size:13px; flex:0 0 auto; }',
          '.rp-sb-card-switch:hover { background:rgba(120,160,220,.12); }',
          '.rp-sb-card-del { padding:6px 10px; border-radius:8px; border:1px solid rgba(220,120,120,.5); background:transparent; color:#e8a0a0; cursor:pointer; font-size:13px; flex:0 0 auto; }',
          '.rp-sb-card-del:hover { background:rgba(220,120,120,.12); }',
          '.rp-sb-look { width:100%; padding:6px 0; border-radius:8px; border:1px solid rgba(160,140,220,.5); background:transparent; color:#c8b8e8; cursor:pointer; font-size:13px; margin-top:6px; }',
          '.rp-sb-look:hover { background:rgba(160,140,220,.12); }',
          '.rp-sb-lookmsg { opacity:.75; font-size:12px; margin-top:4px; line-height:1.5; }',
          '.rp-sb-set-row { display:flex; gap:8px; align-items:center; margin-top:6px; }',
          '.rp-sb-set-label { flex:0 0 72px; opacity:.6; font-size:12px; }',
          '.rp-sb-set-input { flex:1; min-width:0; padding:4px 8px; border-radius:6px; border:1px solid rgba(128,128,128,.4); background:rgba(128,128,128,.1); color:inherit; font-size:12px; }',
          '.rp-sb-set-textarea { flex:1; min-width:0; padding:4px 8px; border-radius:6px; border:1px solid rgba(128,128,128,.4); background:rgba(128,128,128,.1); color:inherit; font-size:12px; resize:vertical; min-height:64px; line-height:1.5; }',
          '.rp-sb-set-check { display:flex; gap:6px; align-items:center; font-size:12px; opacity:.85; margin-top:6px; cursor:pointer; }',
          '.rp-sb-set-save { margin-top:8px; padding:6px 0; width:100%; border-radius:8px; border:1px solid rgba(120,200,140,.5); background:transparent; color:#a8d8b4; cursor:pointer; font-size:13px; }',
          '.rp-sb-set-save:hover { background:rgba(120,200,140,.12); }',
          '.rp-sb-set-msg { opacity:.7; font-size:12px; margin-top:4px; text-align:center; }',
          '.rp-sb-start { display:block; width:100%; margin:10px 0 6px; padding:8px 0; border-radius:8px; border:1px solid rgba(120,200,140,.5); background:transparent; color:#a8d8b4; cursor:pointer; font-size:13px; }',
          '.rp-sb-start:hover { background:rgba(120,200,140,.12); }',
          // ── 养成系统：状态条 / 商城 / 背包（纯美：细条渐变、圆角、克制） ──
          '.rp-status-line { display:flex; align-items:center; gap:6px; font-size:12px; margin-top:6px; flex:0 0 auto; }',
          '.rp-status-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }',
          '.rp-status-dot.green { background:#8fd0a8; box-shadow:0 0 6px rgba(143,208,168,.5); }',
          '.rp-status-dot.yellow { background:#e0c080; box-shadow:0 0 6px rgba(224,192,128,.5); }',
          '.rp-status-dot.orange { background:#e0a070; box-shadow:0 0 6px rgba(224,160,112,.5); }',
          '.rp-status-dot.red { background:#e08090; box-shadow:0 0 6px rgba(224,128,144,.5); }',
          '.rp-stat-row { display:flex; align-items:center; gap:8px; margin-top:5px; }',
          '.rp-stat-name { flex:0 0 36px; font-size:11px; opacity:.6; }',
          '.rp-stat-track { flex:1; height:4px; border-radius:2px; background:rgba(128,128,128,.18); overflow:hidden; }',
          '.rp-stat-fill { height:100%; border-radius:2px; transition:width .5s ease; }',
          '.rp-stat-fill.satiety { background:linear-gradient(90deg,#f4c28d,#e8a05c); }',
          '.rp-stat-fill.health { background:linear-gradient(90deg,#9ed8c0,#6fbfa0); }',
          '.rp-stat-fill.mood { background:linear-gradient(90deg,#c3b5e0,#9d8cc9); }',
          '.rp-stat-fill.hp { background:linear-gradient(90deg,#e8a8b8,#d47892); }',
          '.rp-stat-val { flex:0 0 30px; font-size:11px; opacity:.55; text-align:right; }',
          '.rp-stat-tier { flex:0 0 52px; font-size:11px; opacity:.5; text-align:right; }',
          '.rp-fold { border-top:1px solid rgba(128,128,128,.18); padding-top:5px; margin-top:6px; flex:0 0 auto; }',
          '.rp-fold-head { display:flex; align-items:center; justify-content:space-between; padding:4px 0; cursor:pointer; user-select:none; font-size:12px; }',
          '.rp-fold-caret { opacity:.6; font-size:10px; margin-right:4px; transition:transform .15s; }',
          '.rp-fold-open { transform:rotate(90deg); }',
          '.rp-fold-title { letter-spacing:2px; font-size:11px; opacity:.5; }',
          '.rp-fold-coins { font-size:11px; opacity:.75; }',
          '.rp-shop-row { display:flex; align-items:center; gap:8px; padding:5px 2px; border-radius:8px; }',
          '.rp-shop-row:hover { background:rgba(255,255,255,.06); }',
          '.rp-shop-name { flex:1; min-width:0; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
          '.rp-shop-price { flex:0 0 auto; font-size:11px; opacity:.6; }',
          '.rp-shop-btn { flex:0 0 auto; padding:3px 12px; border-radius:999px; border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; cursor:pointer; font-size:11px; }',
          '.rp-shop-btn:hover { background:rgba(128,128,128,.15); }',
          '.rp-shop-btn.buy { border-color:rgba(120,200,140,.5); color:#a8d8b4; }',
          '.rp-shop-btn.buy:hover { background:rgba(120,200,140,.12); }',
          '.rp-shop-btn.use { border-color:rgba(120,160,220,.5); color:#a8c8e8; }',
          '.rp-shop-btn.use:hover { background:rgba(120,160,220,.12); }',
          '.rp-econ-msg { opacity:.75; font-size:11px; margin-top:3px; min-height:14px; line-height:1.5; }',
          // ── 投喂选择弹窗 ──
          '.rp-feed-overlay { position:fixed; inset:0; background:rgba(10,12,16,.55); z-index:2200; display:flex; align-items:center; justify-content:center; }',
          '.rp-feed-modal { width:280px; max-width:86vw; background:#1c1f26; border:1px solid rgba(128,128,128,.28); border-radius:14px; padding:14px 16px; box-shadow:0 12px 40px rgba(0,0,0,.5); }',
          '.rp-feed-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; font-size:14px; font-weight:600; }',
          '.rp-feed-close { border:none; background:transparent; color:inherit; cursor:pointer; font-size:18px; line-height:1; opacity:.6; padding:2px 6px; border-radius:6px; }',
          '.rp-feed-close:hover { opacity:1; background:rgba(128,128,128,.15); }',
          '.rp-feed-item { cursor:pointer; }',
          '.rp-feed-item:hover { background:rgba(255,255,255,.08); }',
          // ── UI 改版：卡片化 + 折叠 + 胶囊（覆盖，置后生效） ──
          '.rp-sb-body { gap:10px; padding:12px 12px 16px; }',
          '.rp-sb-section { border-top:none; padding:12px 14px; margin:0; background:rgba(255,255,255,.03); border-radius:16px; box-shadow:0 1px 0 rgba(255,255,255,.04); }',
          '.rp-sb-section-title { letter-spacing:1.5px; opacity:.55; margin-bottom:6px; }',
          '.rp-sb-row { border-top:none; padding:2px 0; }',
          '.rp-sb-stage-wrap { border-top:none; padding:12px 14px; background:rgba(255,255,255,.03); border-radius:16px; box-shadow:0 1px 0 rgba(255,255,255,.04); }',
          '.rp-sb-stage-title { letter-spacing:1.5px; opacity:.55; margin-bottom:6px; }',
          '.rp-sb-stop, .rp-sb-look, .rp-sb-pet-btn, .rp-sb-card-switch, .rp-sb-card-del, .rp-sb-start, .rp-sb-set-save, .rp-sb-pet-btn { border-radius:999px; }',
          '.rp-sb-empty { opacity:.6; font-size:12px; line-height:1.7; }',
          '.rp-sb-spacer { flex:1; }',
          '.rp-capsule { display:flex; align-items:center; gap:8px; padding:9px 14px; background:rgba(255,255,255,.03); border-radius:16px; cursor:pointer; box-shadow:0 1px 0 rgba(255,255,255,.04); }',
          '.rp-capsule:hover { background:rgba(255,255,255,.06); }',
          '.rp-capsule-name { font-size:15px; font-weight:700; flex:0 0 auto; }',
          '.rp-capsule-meta { font-size:11px; opacity:.65; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
          '.rp-capsule-caret { opacity:.5; font-size:10px; }',
          '.rp-capbody { padding:12px 14px; background:rgba(255,255,255,.02); border-radius:16px; }',
          '.rp-fold { border-top:none; padding:10px 14px; background:rgba(255,255,255,.03); border-radius:16px; margin:0 0 10px; box-shadow:0 1px 0 rgba(255,255,255,.04); }',
          '.rp-fold-head { border-radius:12px; }',
          '.rp-sb-set-input, .rp-sb-set-textarea, .rp-sb-card-select { border-radius:10px; }',
          '.rp-sb-set-save { border-radius:999px; }',
          '.rp-sb { border-radius:16px 0 0 16px; overflow:hidden; }',
          '.rp-empty-center { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:28px 16px; gap:10px; }',
          '.rp-empty-emoji { font-size:34px; opacity:.7; }',
          '.rp-empty-line { font-size:14px; font-weight:600; opacity:.8; }',
          '.rp-empty-hint { font-size:12px; opacity:.45; }',
          // ── 面板弹出动画：胶囊右飞出 + 侧栏右滑入 ──
          '.rp-dock-btn { transition: transform .45s cubic-bezier(.2,.8,.2,1), opacity .45s; }',
          '.rp-dock-btn.fly-out { transform: translateX(360px); opacity:0; pointer-events:none; }',
          '.rp-sb { animation: rpSlideIn .42s cubic-bezier(.2,.8,.2,1); }',
          '@keyframes rpSlideIn { from { transform: translateX(100%); opacity:.4; } to { transform: translateX(0); opacity:1; } }',
          // ── DSH「插件配置」→「角色扮演」卡片 ──
          '.rp-card { display:flex; flex-direction:column; gap:6px; padding:2px 0 8px; }',
          '.rp-card-lab { font-size:12px; opacity:.6; margin-top:4px; }',
          '.rp-card-select { padding:4px 8px; border-radius:8px; border:1px solid rgba(128,128,128,.4); background:rgba(128,128,128,.1); color:inherit; font-size:12px; }',
          '.rp-card-input { padding:4px 8px; border-radius:8px; border:1px solid rgba(128,128,128,.4); background:rgba(128,128,128,.1); color:inherit; font-size:12px; width:90px; }',
          '.rp-card-chk { display:flex; gap:6px; align-items:center; font-size:12px; opacity:.85; cursor:pointer; }',
          '.rp-card-save { flex:1; padding:6px 0; border-radius:999px; border:1px solid rgba(120,200,140,.5); background:transparent; color:#a8d8b4; cursor:pointer; font-size:13px; }',
          '.rp-card-save:hover { background:rgba(120,200,140,.12); }',
          '.rp-card-actions { display:flex; gap:8px; margin-top:8px; }',
          '.rp-card-reset { flex:1; padding:6px 0; border-radius:999px; border:1px solid rgba(128,128,128,.4); background:transparent; color:inherit; cursor:pointer; font-size:13px; opacity:.75; }',
          '.rp-card-reset:hover { background:rgba(128,128,128,.12); opacity:1; }',
          '.rp-card-hint { font-size:11px; opacity:.5; margin-bottom:2px; }',
          '.rp-card-msg { opacity:.75; font-size:12px; text-align:center; }',
          '.rp-card-load { opacity:.6; font-size:12px; }',
          // ── 危机提醒（状态危急：倒下/危急） ──
          '.rp-danger-dot { width:8px; height:8px; border-radius:50%; background:#e08090; box-shadow:0 0 8px rgba(224,128,144,.8); flex:0 0 auto; }',
          '.rp-dock-btn.rp-danger { border-color:rgba(220,100,100,.7); }',
          '.rp-alert { margin:2px 0 8px; padding:8px 10px; border:1px solid rgba(255,69,58,.4); background:rgba(255,69,58,.12); color:#ff9a92; border-radius:14px; font-size:12px; line-height:1.55; }',
          // ── 苹果化覆盖层（系统色 / 毛玻璃 / 大圆角 / 柔和阴影 / iOS 开关，置后生效）──
          '.rp-sb, .rp-sb * { font-family:-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif; }',
          '.rp-sb { width:min(360px,94vw); background:rgba(30,30,32,.74); -webkit-backdrop-filter:saturate(180%) blur(30px); backdrop-filter:saturate(180%) blur(30px); border-left:1px solid rgba(255,255,255,.08); box-shadow:0 18px 60px rgba(0,0,0,.38), 0 2px 14px rgba(0,0,0,.22); border-radius:24px 0 0 24px; }',
          '.rp-sb-head { background:transparent; padding:16px 20px; border-bottom:1px solid rgba(255,255,255,.08); }',
          '.rp-sb-title { font-size:15px; font-weight:600; letter-spacing:-0.2px; }',
          '.rp-sb-body { padding:14px 16px 22px; gap:12px; }',
          '.rp-sb-section, .rp-fold, .rp-capsule, .rp-sb-stage-wrap, .rp-capbody { background:rgba(255,255,255,.055); border-radius:18px; box-shadow:0 1px 0 rgba(255,255,255,.06) inset, 0 6px 24px rgba(0,0,0,.14); }',
          '.rp-sb-section-title, .rp-fold-title { color:rgba(235,235,245,.5); letter-spacing:1px; font-size:11px; font-weight:500; }',
          '.rp-sb-empty { color:rgba(235,235,245,.45); }',
          '.rp-sb-item { color:rgba(235,235,245,.78); }',
          '.rp-sb-start, .rp-sb-look, .rp-sb-set-save, .rp-sb-pet-on { border-color:rgba(10,132,255,.5); color:#7fb4ff; border-radius:999px; transition:background .25s ease; }',
          '.rp-sb-start:hover, .rp-sb-look:hover, .rp-sb-set-save:hover, .rp-sb-pet-on:hover { background:rgba(10,132,255,.14); }',
          '.rp-sb-stop, .rp-sb-card-del, .rp-feed-close { border-color:rgba(255,69,58,.5); color:#ff8b82; border-radius:999px; }',
          '.rp-sb-stop:hover, .rp-sb-card-del:hover { background:rgba(255,69,58,.14); }',
          '.rp-sb-pet-off { border-color:rgba(255,159,10,.5); color:#ffb340; border-radius:999px; }',
          '.rp-sb-card-switch { border-color:rgba(10,132,255,.4); color:#7fb4ff; border-radius:999px; }',
          '.rp-sb-set-input, .rp-sb-set-textarea, .rp-sb-card-select, .rp-card-select, .rp-card-input { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.1); border-radius:10px; color:#f5f5f7; font-size:13px; }',
          '.rp-sb-set-input:focus, .rp-sb-set-textarea:focus, .rp-sb-card-select:focus, .rp-card-select:focus, .rp-card-input:focus { border-color:#0a84ff; outline:none; }',
          '.rp-sb-set-label, .rp-card-lab { color:rgba(235,235,245,.6); }',
          '.rp-sb-set-msg, .rp-card-msg { color:rgba(235,235,245,.7); }',
          '.rp-sb-set-check, .rp-card-chk { color:rgba(235,235,245,.85); }',
          '.rp-sb-set-check input[type="checkbox"], .rp-card-chk input[type="checkbox"] { appearance:none; -webkit-appearance:none; width:42px; height:24px; border-radius:13px; background:rgba(120,120,128,.34); position:relative; cursor:pointer; transition:background .2s ease; flex:0 0 auto; margin:0; }',
          '.rp-sb-set-check input[type="checkbox"]::after, .rp-card-chk input[type="checkbox"]::after { content:""; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.35); transition:transform .2s cubic-bezier(.22,.61,.36,1); }',
          '.rp-sb-set-check input[type="checkbox"]:checked, .rp-card-chk input[type="checkbox"]:checked { background:#30d158; }',
          '.rp-sb-set-check input[type="checkbox"]:checked::after, .rp-card-chk input[type="checkbox"]:checked::after { transform:translateX(18px); }',
          '.rp-stat-fill.satiety { background:linear-gradient(90deg,#ff9f0a,#ffb340); }',
          '.rp-stat-fill.health { background:linear-gradient(90deg,#30d158,#4be07a); }',
          '.rp-stat-fill.mood { background:linear-gradient(90deg,#0a84ff,#4aa3ff); }',
          '.rp-stat-fill.hp { background:linear-gradient(90deg,#ff453a,#ff6a5e); }',
          '.rp-status-dot.green { background:#30d158; }',
          '.rp-status-dot.yellow { background:#ffd60a; }',
          '.rp-status-dot.orange { background:#ff9f0a; }',
          '.rp-status-dot.red { background:#ff453a; }',
          '.rp-danger-dot { background:#ff453a; }',
          '.rp-dock-btn { border:1px solid rgba(255,255,255,.14); background:rgba(30,30,32,.62); -webkit-backdrop-filter:saturate(160%) blur(20px); backdrop-filter:saturate(160%) blur(20px); box-shadow:0 4px 18px rgba(0,0,0,.28); border-radius:999px; transition:all .3s cubic-bezier(.22,.61,.36,1); }',
          '.rp-dock-btn:hover { background:rgba(42,42,46,.72); }',
          '.rp-dock-btn.rp-open { background:rgba(10,132,255,.18); border-color:rgba(10,132,255,.5); }',
          '.rp-fold-caret, .rp-capsule-caret { transition:transform .25s cubic-bezier(.22,.61,.36,1); }',
          '.rp-card { color:#f5f5f7; }',
          '.rp-card-save { border-color:rgba(10,132,255,.5); color:#7fb4ff; }',
          '.rp-card-save:hover { background:rgba(10,132,255,.14); }',
          '.rp-card-reset { border-color:rgba(255,255,255,.14); color:#a1a1a6; }',
          '.rp-card-reset:hover { background:rgba(255,255,255,.1); }',
          '.rp-card-hint { color:rgba(235,235,245,.45); }',
          '.rp-shop-btn { border-radius:999px; }',
          '.rp-shop-btn.buy { border-color:rgba(10,132,255,.5); color:#7fb4ff; }',
          '.rp-shop-btn.use { border-color:rgba(10,132,255,.4); color:#7fb4ff; }',
          '.rp-feed-modal { background:rgba(28,28,30,.9); border:1px solid rgba(255,255,255,.1); border-radius:18px; box-shadow:0 18px 60px rgba(0,0,0,.4); -webkit-backdrop-filter:saturate(160%) blur(24px); backdrop-filter:saturate(160%) blur(24px); }',
          // ── 浅色主题（侧栏/dock 加 .theme-light 类时生效）──
          'body:not([data-ds-dark-theme]) .rp-sb { background:rgba(248,248,250,.82); border-left-color:rgba(0,0,0,.08); box-shadow:0 18px 60px rgba(0,0,0,.14), 0 2px 14px rgba(0,0,0,.08); color:#1c1c1e; }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-head { border-bottom-color:rgba(0,0,0,.08); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-title { color:#000; }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-close { color:rgba(0,0,0,.55); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-close:hover { background:rgba(0,0,0,.08); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-section, body:not([data-ds-dark-theme]) .rp-sb .rp-fold, body:not([data-ds-dark-theme]) .rp-sb .rp-capsule, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-stage-wrap, body:not([data-ds-dark-theme]) .rp-sb .rp-capbody { background:rgba(255,255,255,.62); box-shadow:0 1px 0 rgba(0,0,0,.05) inset, 0 6px 24px rgba(0,0,0,.08); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-section-title, body:not([data-ds-dark-theme]) .rp-sb .rp-fold-title { color:rgba(60,60,67,.55); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-empty, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-lookmsg, body:not([data-ds-dark-theme]) .rp-sb .rp-econ-msg { color:rgba(60,60,67,.55); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-item, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-persona, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-status, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-stage-item { color:rgba(0,0,0,.74); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-name, body:not([data-ds-dark-theme]) .rp-sb .rp-capsule-name { color:#1c1c1e; }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-k { color:rgba(0,0,0,.5); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-set-input, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-set-textarea, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-card-select { background:rgba(120,120,128,.09); border-color:rgba(0,0,0,.14); color:#1c1c1e; }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-set-label { color:rgba(0,0,0,.58); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-set-check, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-row > span, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-scroll .rp-sb-item-dim { color:rgba(0,0,0,.78); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-start, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-look, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-set-save, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-pet-on, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-card-switch { border-color:rgba(0,122,255,.5); color:#0060df; }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-start:hover, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-look:hover, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-set-save:hover, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-pet-on:hover { background:rgba(0,122,255,.1); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-stop, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-card-del { border-color:rgba(255,59,48,.5); color:#d70015; }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-stop:hover, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-card-del:hover { background:rgba(255,59,48,.08); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-pet-off { border-color:rgba(255,149,0,.5); color:#c93400; }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-card-select { color:#1c1c1e; }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-set-msg { color:rgba(0,0,0,.7); }',
          'body:not([data-ds-dark-theme]) .rp-dock-btn { border-color:rgba(0,0,0,.14); background:rgba(255,255,255,.7); color:#1c1c1e; }',
          'body:not([data-ds-dark-theme]) .rp-dock-btn:hover { background:rgba(255,255,255,.88); }',
          'body:not([data-ds-dark-theme]) .rp-dock-btn.rp-open { background:rgba(0,122,255,.14); border-color:rgba(0,122,255,.45); }',
          // ── 质感增强：更透的毛玻璃 + 细腻高光/阴影 + 更顺滑过渡 ──
          '.rp-sb { background:rgba(28,28,30,.60); -webkit-backdrop-filter:saturate(200%) blur(38px); backdrop-filter:saturate(200%) blur(38px); box-shadow:0 24px 80px rgba(0,0,0,.42), 0 4px 20px rgba(0,0,0,.24), inset 0 1px 0 rgba(255,255,255,.10); }',
          'body:not([data-ds-dark-theme]) .rp-sb { background:rgba(248,248,250,.66); box-shadow:0 24px 80px rgba(0,0,0,.16), 0 4px 20px rgba(0,0,0,.09), inset 0 1px 0 rgba(255,255,255,.9); }',
          '.rp-dock-btn { background:rgba(28,28,30,.5); -webkit-backdrop-filter:saturate(180%) blur(26px); backdrop-filter:saturate(180%) blur(26px); box-shadow:0 6px 24px rgba(0,0,0,.32); }',
          'body:not([data-ds-dark-theme]) .rp-dock-btn { background:rgba(255,255,255,.62); }',
          '.rp-sb-section, .rp-fold, .rp-capsule, .rp-sb-stage-wrap, .rp-capbody { background:rgba(255,255,255,.075); box-shadow:0 1px 0 rgba(255,255,255,.12) inset, 0 10px 30px rgba(0,0,0,.16); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-section, body:not([data-ds-dark-theme]) .rp-sb .rp-fold, body:not([data-ds-dark-theme]) .rp-sb .rp-capsule, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-stage-wrap, body:not([data-ds-dark-theme]) .rp-sb .rp-capbody { background:rgba(255,255,255,.78); box-shadow:0 1px 0 rgba(0,0,0,.04) inset, 0 10px 30px rgba(0,0,0,.10); }',
          '.rp-sb, .rp-dock-btn { transition:background .35s ease, box-shadow .35s ease; }',
          '.rp-dock-btn:active, .rp-sb-start:active, .rp-sb-set-save:active, .rp-sb-look:active, .rp-sb-pet-on:active, .rp-sb-stop:active, .rp-sb-card-del:active { transform:scale(.97); }',
          '.rp-sb-start, .rp-sb-set-save, .rp-sb-look, .rp-sb-pet-on, .rp-sb-stop, .rp-sb-card-del, .rp-sb-card-switch { transition:background .25s ease, border-color .25s ease, transform .12s ease; }',
          '.rp-stat-fill { box-shadow:0 0 8px rgba(255,255,255,.12) inset; }',
          '.rp-sb-set-input, .rp-sb-set-textarea, .rp-sb-card-select { background:rgba(255,255,255,.09); }',
          'body:not([data-ds-dark-theme]) .rp-sb .rp-sb-set-input, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-set-textarea, body:not([data-ds-dark-theme]) .rp-sb .rp-sb-card-select { background:rgba(120,120,128,.10); }',
          // ── 插件设置卡片：跟随 DSH 主题（body 无 data-ds-dark-theme = 浅色）──
          'body:not([data-ds-dark-theme]) .rp-card { color:#1c1c1e; }',
          'body:not([data-ds-dark-theme]) .rp-card-lab { color:rgba(0,0,0,.6); }',
          'body:not([data-ds-dark-theme]) .rp-card-hint { color:rgba(0,0,0,.5); }',
          'body:not([data-ds-dark-theme]) .rp-card-chk { color:rgba(0,0,0,.8); }',
          'body:not([data-ds-dark-theme]) .rp-card-select, body:not([data-ds-dark-theme]) .rp-card-input { background:rgba(0,0,0,.05); border-color:rgba(0,0,0,.16); color:#1c1c1e; }',
          'body:not([data-ds-dark-theme]) .rp-card-load { color:rgba(0,0,0,.6); }',
          'body:not([data-ds-dark-theme]) .rp-card-reset { color:#3a3a3c; border-color:rgba(0,0,0,.2); }',
          'body:not([data-ds-dark-theme]) .rp-card-reset:hover { background:rgba(0,0,0,.06); }',
          'body:not([data-ds-dark-theme]) .rp-card-save { color:#0060df; }',
          'body:not([data-ds-dark-theme]) .rp-card-save:hover { background:rgba(0,122,255,.1); }',
          'body:not([data-ds-dark-theme]) .rp-card-msg { color:rgba(0,0,0,.7); }',
          // ── 演出区：修复标题与内容重叠（加 gap / line-height / 保底高度）──
          '.rp-sb-stage-wrap { gap:6px; min-height:80px; }',
          '.rp-sb-stage-title { line-height:1.5; margin:0; letter-spacing:1.5px; }',
          '.rp-sb-stage-list { gap:4px; }'
        ].join('\n')
        document.head.appendChild(style)
        ctx.effect(function () {
          return function () {
            if (style.parentNode) style.parentNode.removeChild(style)
          }
        })

        var sbOpen = false
        var listeners = new Set()
        var setSbOpen = function (v) { sbOpen = v; listeners.forEach(function (fn) { fn(sbOpen) }) }
        var subscribeSb = function (fn) { listeners.add(fn); return function () { listeners.delete(fn) } }

        function useRoleplayState(sessionId) {
          var state = React.useState(null)
          var st = state[0]
          var setSt = state[1]
          var alive = true
          var refresh = function () {
            rpc('get-state', sessionId ? { sessionId: sessionId } : {})
              .then(function (result) { if (alive && result.ok) setSt(result.value) })
              .catch(function () {})
          }
          React.useEffect(function () {
            alive = true
            refresh()
            var id = window.setInterval(refresh, 15000)
            return function () { alive = false; window.clearInterval(id) }
          }, [])
          return { st: st, refresh: refresh }
        }

        // 桌宠状态：经同一 /roleplay 通道读取/控制（host 桥接 serviceFor('deskpet')）。
        function usePetState(sessionId) {
          var state = React.useState(null)
          var st = state[0]
          var setSt = state[1]
          var payload = function () { return sessionId ? { sessionId: sessionId } : {} }
          var refresh = function () {
            rpc('pet-status', payload())
              .then(function (result) { if (result && result.ok) setSt(result.value) })
              .catch(function () {})
          }
          React.useEffect(function () {
            var alive = true
            var tick = function () {
              rpc('pet-status', payload())
                .then(function (result) { if (alive && result && result.ok) setSt(result.value) })
                .catch(function () {})
            }
            tick()
            var id = window.setInterval(tick, 5000)
            return function () { alive = false; window.clearInterval(id) }
          }, [])
          var act = function (ep) {
            return function () {
              rpc(ep, payload())
                .then(function (result) { if (result && result.ok) setSt(result.value) })
                .catch(function () {})
              window.setTimeout(refresh, 1200)
            }
          }
          return { st: st, start: act('pet-start'), stop: act('pet-stop') }
        }

        // 角色卡列表：经同一 /roleplay 通道读取/切换。
        function useCards(sessionId) {
          var state = React.useState({ list: [], loaded: false })
          var cards = state[0]
          var setCards = state[1]
          var payload = function () { return sessionId ? { sessionId: sessionId } : {} }
          var refresh = function () {
            rpc('cards-list', payload())
              .then(function (result) { if (result && result.ok && result.value && result.value.cards) setCards({ list: result.value.cards, loaded: true }) })
              .catch(function () {})
          }
          React.useEffect(function () {
            refresh()
            var id = window.setInterval(refresh, 10000)
            return function () { window.clearInterval(id) }
          }, [])
          var load = function (card) {
            rpc('cards-load', Object.assign(payload(), { card: card }))
              .then(function () { window.setTimeout(refresh, 800) })
              .catch(function () {})
          }
          var del = function (card) {
            rpc('cards-delete', Object.assign(payload(), { card: card }))
              .then(function () { window.setTimeout(refresh, 800) })
              .catch(function () {})
          }
          return { cards: cards, load: load, del: del }
        }

        // 看桌面：用户主动触发，截图注入扮演对话。
        function useLookDesktop(sessionId) {
          var state = React.useState(null)
          var msg = state[0]
          var setMsg = state[1]
          var look = function () {
            setMsg('截图并注入中…')
            rpc('look-desktop', sessionId ? { sessionId: sessionId } : {})
              .then(function (result) {
                var v = result && result.ok && result.value ? result.value : null
                if (v && v.ok) setMsg(v.message || '已发送。')
                else setMsg((v && v.message) || '发送失败')
              })
              .catch(function () { setMsg('发送失败') })
            window.setTimeout(function () { setMsg(null) }, 8000)
          }
          return { msg: msg, look: look }
        }

        // ── 输入框上方的入口按钮 ─────────────────────────────────────────────
        slots.inject('conversation.input.dock', function () {
          return slots.register(
            { name: 'conversation.input.dock', id: 'roleplay-entry', order: 100, label: '角色扮演' },
            function (props) {
              var sessionId = props && props.sessionId ? props.sessionId : undefined
              var openState = React.useState(sbOpen)
              var open = openState[0]
              var setLocal = openState[1]
              var flyOut = React.useState(false)
              React.useEffect(function () { return subscribeSb(function (v) { setLocal(v) }) }, [])
              var sth = useRoleplayState(sessionId)
              var st = sth.st
              var active = st && st.enabled && st.character
              var c = active ? st.character : null
              var statusText = c && c.status ? Object.keys(c.status).map(function (k) { return k + ' ' + c.status[k] }).join(' · ') : ''
              var crisis = !!(st && st.statsStatus && st.statsStatus.tone === 'red')
              return React.createElement('div', { className: 'rp-dock' },
                React.createElement('button', {
                  className: 'rp-dock-btn' + (open ? ' rp-open' : '') + (flyOut[0] ? ' fly-out' : '') + (crisis ? ' rp-danger' : ''),
                  onClick: function () {
                    if (sbOpen) { setSbOpen(false); return }
                    flyOut[1](true)
                    window.setTimeout(function () {
                      setSbOpen(true)
                      flyOut[1](false)
                    }, 450)
                  },
                  title: active ? ('角色扮演中：' + c.name) : '角色扮演（未开演）',
                },
                  React.createElement('span', null, '🎭'),
                  React.createElement('span', { className: 'rp-dock-name' }, active ? c.name : '角色扮演'),
                  crisis ? React.createElement('span', { className: 'rp-danger-dot', title: (st.statsStatus && st.statsStatus.desc) || '状态危急' }) : null,
                  statusText ? React.createElement('span', { className: 'rp-dock-meta' }, statusText) : null
                )
              )
            }
          )
        })

        // ── 对话消息尾部徽章：角色扮演会话的每条角色消息下挂一枚 🎭 标签 ──
        slots.inject('conversation.chat.turnTail', function () {
          return slots.register(
            { name: 'conversation.chat.turnTail', select: function () { return { rp: true } } },
            function (props) {
              var seg = useRoleplayState(props && props.sessionId)
              var st = seg.st
              if (!st || !st.enabled || !st.character) return null
              var label = '🎭 ' + st.character.name + (st.stageLabel ? ' · ' + st.stageLabel : '')
              if (st.roomMembers && st.roomMembers.length) label = '🎭 房间 ' + st.roomMembers.join(' · ')
              return React.createElement('div', { className: 'rp-turn-badge' }, label)
            }
          )
        })

        // ── 右侧边栏 ─────────────────────────────────────────────────────────
        slots.inject('conversation.input.overlay', function () {
          return slots.register(
            { name: 'conversation.input.overlay', id: 'roleplay-sidebar', order: 10, label: '角色扮演侧栏' },
            function (props) {
              var sessionId = props && props.sessionId ? props.sessionId : undefined
              var openState = React.useState(sbOpen)
              var open = openState[0]
              var setLocal = openState[1]
              React.useEffect(function () { return subscribeSb(function (v) { setLocal(v) }) }, [])
          var sth = useRoleplayState(sessionId)
          var st = sth.st
          var pet = usePetState(sessionId)
          var cards = useCards(sessionId)
          var look = useLookDesktop(sessionId)
          var cardSel = React.useState('')
          var startBusy = React.useState(false)
          var startMsg = React.useState(null)
          var saveMsg = React.useState(null)
          var shopOpen = React.useState(false)
          var packOpen = React.useState(false)
          var feedOpen = React.useState(false)
          var moreOpen = React.useState(true)
          var capOpen = React.useState(false)
          var memOpen = React.useState(false)
          var diaryOpen = React.useState(false)
          var econMsg = React.useState(null)
          var econAct = function (ep) {
            return function (id) {
              rpc(ep, Object.assign(sessionId ? { sessionId: sessionId } : {}, { item: id }))
                .then(function (result) {
                  var v = result && result.ok && result.value ? result.value : null
                  econMsg[1](v && v.ok ? v.message : ((v && v.message) || '操作失败'))
                  window.setTimeout(function () { econMsg[1](null) }, 2600)
                  if (sth.refresh) sth.refresh()
                })
                .catch(function () { econMsg[1]('操作失败') })
            }
          }
          var buy = econAct('shop-buy')
          var use = econAct('inventory-use')
          var roomSel = React.useState('')
          var roomStart = function () {
            var first = st && st.character ? st.character.name : null
            var chosen = (cards.cards.list || []).filter(function (x) { return x.id === roomSel[0] })[0]
            var second = chosen ? chosen.name : null
            if (!first || !second || first === second) { econMsg[1]('先选一张与当前角色不同的卡'); window.setTimeout(function () { econMsg[1](null) }, 2600); return }
            rpc('room-start', Object.assign(sessionId ? { sessionId: sessionId } : {}, { characters: [first, second] }))
              .then(function (result) {
                var v = result && result.ok && result.value ? result.value : null
                econMsg[1](v && v.ok ? v.message : ((v && v.message) || '开房间失败'))
                window.setTimeout(function () { econMsg[1](null) }, 2600)
                if (sth.refresh) sth.refresh()
              })
              .catch(function (e) { econMsg[1]('开房间失败: ' + String(e && e.message ? e.message : e)); window.setTimeout(function () { econMsg[1](null) }, 4000) })
          }
          var roomStop = function () {
            rpc('room-stop', sessionId ? { sessionId: sessionId } : {})
              .then(function (result) {
                var v = result && result.ok && result.value ? result.value : null
                econMsg[1](v && v.ok ? v.message : '关房间失败')
                window.setTimeout(function () { econMsg[1](null) }, 2600)
                if (sth.refresh) sth.refresh()
              })
              .catch(function (e) { econMsg[1]('关房间失败: ' + String(e && e.message ? e.message : e)); window.setTimeout(function () { econMsg[1](null) }, 4000) })
          }
          var saveSettings = function () {
            var g = function (id) { var el = document.getElementById(id); return el ? el.value : '' }
            var auto = document.getElementById('rp-autolook')
            var statsEn = document.getElementById('rp-statsen')
            rpc('settings-update', Object.assign(sessionId ? { sessionId: sessionId } : {}, {
              settings: {
                heartbeatMinutes: Number(g('rp-hb')) || 30,
                shotMaxW: Number(g('rp-shotw')) || 0,
                autoLook: !!(auto && auto.checked),
                narrationMode: g('rp-narr') || 'novel',
                scriptStart: g('rp-sstart'),
                scriptEnd: g('rp-send'),
                statsEnabled: !!(statsEn && statsEn.checked),
                difficulty: Number(g('rp-diff')) || 2,
                relationEnabled: !!(document.getElementById('rp-relen') && document.getElementById('rp-relen').checked),
                relPace: g('rp-relpace') || 'normal',
                storyEnabled: !!(document.getElementById('rp-storyen') && document.getElementById('rp-storyen').checked),
                summaryEnabled: !!(document.getElementById('rp-summen') && document.getElementById('rp-summen').checked),
                userProfileEnabled: !!(document.getElementById('rp-uppen') && document.getElementById('rp-uppen').checked),
                persona: g('rp-persona'),
                scene: g('rp-scene'),
                mode: g('rp-mode'),
                greeting: g('rp-greet'),
              },
            })).then(function (result) {
              var v = result && result.ok && result.value ? result.value : null
              saveMsg[1](v && v.ok ? '已保存 ✓' : '保存失败')
              window.setTimeout(function () { saveMsg[1](null) }, 2500)
              if (sth.refresh) sth.refresh()
            }).catch(function () { saveMsg[1]('保存失败') })
          }
          var saveProfile = function () {
            var g = function (id) { var el = document.getElementById(id); return el ? el.value : '' }
            rpc('user-profile-update', Object.assign(sessionId ? { sessionId: sessionId } : {}, {
              profile: {
                nickname: g('rp-upnick'), identity: g('rp-upid'), appearance: g('rp-upapp'),
                background: g('rp-upbg'), speechStyle: g('rp-upsp'),
              },
            })).then(function (result) {
              var v = result && result.ok && result.value ? result.value : null
              saveMsg[1](v && v.ok ? '档案已保存 ✓' : '保存失败')
              window.setTimeout(function () { saveMsg[1](null) }, 2500)
              if (sth.refresh) sth.refresh()
            }).catch(function () { saveMsg[1]('保存失败') })
          }
          if (!open) return null
              var c = st && st.enabled && st.character ? st.character : null
              var stage = st && st.stage ? st.stage : []
              var mem = st && st.memoryView ? st.memoryView : null
              var diary = st && st.diaryView ? st.diaryView : null
              var modeLabel = c && c.mode ? ({ default: '默认', fast: '快速', deep: '深度' }[c.mode] || c.mode) : null
              var audit = st && st.lastTurn ? st.lastTurn : null
              return React.createElement('div', { className: 'rp-sb' },
                React.createElement('div', { className: 'rp-sb-head' },
                  React.createElement('span', { className: 'rp-sb-title' }, '🎭 角色扮演'),
                  React.createElement('button', { className: 'rp-sb-close', onClick: function () { setSbOpen(false) } }, '×')
                ),
                React.createElement('div', { className: 'rp-sb-body' },
                  !c
                    ? React.createElement('div', { className: 'rp-empty-center' },
                        React.createElement('div', { className: 'rp-empty-emoji' }, '🎭'),
                        React.createElement('div', { className: 'rp-empty-line' }, '还没有角色在扮演'),
                        React.createElement('button', {
                          className: 'rp-sb-start',
                          disabled: startBusy[0],
                          style: startBusy[0] ? { opacity: .5, cursor: 'default' } : undefined,
                          onClick: function () {
                            if (startBusy[0]) return
                            startBusy[1](true)
                            rpc('start', sessionId ? { sessionId: sessionId } : {})
                              .then(function (result) {
                                var v = result && result.ok && result.value ? result.value : null
                                if (v && v.ok === false) { startMsg[1](v.message || '开始失败') }
                                else if (v && v.name) { startMsg[1]('已开演「' + v.name + '」') }
                                else if (v && v.onboarding) { startMsg[1]('（进入开局引导：让 TA 问你想演谁吧）') }
                                else if (result && result.error) { startMsg[1](result.error.message || '开始失败') }
                                window.setTimeout(function () {
                                  startBusy[1](false)
                                  if (sth.refresh) sth.refresh()
                                }, 1200)
                                window.setTimeout(function () { startMsg[1](null) }, 3500)
                              })
                              .catch(function (e) { startBusy[1](false); startMsg[1]('开始失败' + (e && e.message ? ': ' + e.message : '')) })
                          },
                        }, startBusy[0] ? '开演中…' : ((cards.cards.list || []).length
                          ? '▶ 继续上次演「' + ((cards.cards.list[cards.cards.list.length - 1] || {}).name || '') + '」'
                          : '＋ 开始新角色')),
                        React.createElement('div', { className: 'rp-empty-hint' }, (cards.cards.list || []).length
                          ? '或说「开始/开演」接着演上次的'
                          : '或说「开始/开演」——我先问你几个问题，带你创建一个角色'),
                        startMsg[0] ? React.createElement('div', { className: 'rp-sb-set-msg' }, startMsg[0]) : null)
                    : React.createElement(React.Fragment, null,
                        React.createElement('button', { className: 'rp-capsule', style: { width: '100%' }, onClick: function () { capOpen[1](!capOpen[0]) } },
                          React.createElement('span', { className: 'rp-capsule-name' }, c.name),
                          React.createElement('span', { className: 'rp-capsule-meta' },
                            (st.relationStage ? st.relationStage + ' · ' : '') + (st.statsStatus ? st.statsStatus.label : '')),
                          React.createElement('span', { className: 'rp-capsule-caret' + (capOpen[0] ? ' rp-fold-open' : '') }, '▸')),
                        capOpen[0] ? React.createElement('div', { className: 'rp-capbody' },
                          st && st.stats && st.statsStatus ? React.createElement('div', { className: 'rp-sb-section', key: 'stats' },
                            React.createElement('div', { className: 'rp-sb-section-title' }, '状 态'),
                            st.statsStatus.tone === 'red' ? React.createElement('div', { className: 'rp-alert' },
                              '⚠ 她状态危急：' + (st.statsStatus.desc || '需要你的照顾') + ' 去商城买药或投喂救治吧。') : null,
                            React.createElement('div', { className: 'rp-status-line' },
                              React.createElement('span', { className: 'rp-status-dot ' + (st.statsStatus.tone || 'green') }),
                              React.createElement('span', null, st.statsStatus.label)),
                            STAT_DEFS.map(function (d) {
                              return React.createElement('div', { className: 'rp-stat-row', key: d[0] },
                                React.createElement('span', { className: 'rp-stat-name' }, d[1]),
                                React.createElement('div', { className: 'rp-stat-track' },
                                  React.createElement('div', { className: 'rp-stat-fill ' + d[0], style: { width: Math.max(0, Math.min(100, st.stats[d[0]] || 0)) + '%' } })),
                                React.createElement('span', { className: 'rp-stat-val' }, String(Math.round(st.stats[d[0]] || 0))))
                            })
                          ) : null,
                          st && st.relationEnabled && st.relation ? React.createElement('div', { className: 'rp-sb-section', key: 'rel' },
                            React.createElement('div', { className: 'rp-sb-section-title' }, '关 系'),
                            React.createElement('div', { className: 'rp-status-line' },
                              React.createElement('span', null, st.relationStage || ''),
                              React.createElement('span', { style: { flex: 1 } }),
                              React.createElement('span', { className: 'rp-fold-coins' }, '里程 ' + ((st.milestones || []).length) + '/8')),
                            REL_DEFS.map(function (d) {
                              return React.createElement('div', { className: 'rp-stat-row', key: d[0] },
                                React.createElement('span', { className: 'rp-stat-name' }, d[1]),
                                React.createElement('div', { className: 'rp-stat-track' },
                                  React.createElement('div', { className: 'rp-stat-fill ' + d[2], style: { width: Math.max(0, Math.min(100, st.relation[d[0]] || 0)) + '%' } })),
                                React.createElement('span', { className: 'rp-stat-tier' }, relTier(d[0], st.relation[d[0]] || 0)),
                                React.createElement('span', { className: 'rp-stat-val' }, String(Math.round(st.relation[d[0]] || 0))))
                            }),
                            (st.relRecent && st.relRecent.length ? React.createElement('div', { className: 'rp-sb-row' },
                              React.createElement('span', { className: 'rp-sb-k' }, '最近变化'),
                              React.createElement('span', null, relRecentText(st.relRecent[st.relRecent.length - 1])),
                              React.createElement('span', { style: { flex: 1 } }),
                              React.createElement('span', { className: 'rp-fold-coins' }, ({ slow: '慢热', normal: '正常', fast: '快速' }[st.relPace] || '正常'))
                      ) : React.createElement('span', null, '')),
                            BF_DEFS.map(function (b) {
                              return React.createElement('div', { className: 'rp-stat-row', key: b[0] },
                                React.createElement('span', { className: 'rp-stat-name' }, b[1]),
                                React.createElement('div', { className: 'rp-stat-track' },
                                  React.createElement('div', { className: 'rp-stat-fill health', style: { width: Math.max(0, Math.min(100, st.boyfriend[b[0]] || 0)) + '%' } })),
                                React.createElement('span', { className: 'rp-stat-val' }, String(Math.round(st.boyfriend[b[0]] || 0))))
                            })
                          ) : null,
                          React.createElement('div', { className: 'rp-sb-persona' }, c.persona),
                          c.scene ? React.createElement('div', { className: 'rp-sb-row' },
                            React.createElement('span', { className: 'rp-sb-k' }, '场景'),
                            React.createElement('span', null, c.scene)) : null,
                          c.status && Object.keys(c.status).length ? React.createElement('div', { className: 'rp-sb-row' },
                            React.createElement('span', { className: 'rp-sb-k' }, '状态'),
                            React.createElement('span', { className: 'rp-sb-status' },
                              Object.keys(c.status).map(function (k) { return React.createElement('span', { key: k }, k + ' ' + c.status[k]) }))) : null,
                          st.stageLabel ? React.createElement('div', { className: 'rp-sb-row' },
                            React.createElement('span', { className: 'rp-sb-k' }, '关系'),
                            React.createElement('span', null, st.stageLabel)) : null,
                          React.createElement('div', { className: 'rp-sb-row' },
                            React.createElement('span', { className: 'rp-sb-k' }, '模式'),
                            React.createElement('span', null, modeLabel || '默认')),
                          st.nextHeartbeatLabel ? React.createElement('div', { className: 'rp-sb-row' },
                            React.createElement('span', { className: 'rp-sb-k' }, '心跳'),
                            React.createElement('span', null, '下次 ~' + st.nextHeartbeatLabel)) : null,
                          audit ? React.createElement('div', { className: 'rp-sb-row' },
                            React.createElement('span', { className: 'rp-sb-k' }, '审计'),
                            React.createElement('span', null, '上一轮 ' + (audit.tokens != null ? audit.tokens + ' tok · ' : '') + (audit.ms != null ? Math.round(audit.ms / 1000) + 's' : ''))) : null,
                          React.createElement('button', { className: 'rp-sb-look', onClick: look.look }, '👁 让角色看看桌面'),
                          look.msg ? React.createElement('div', { className: 'rp-sb-lookmsg', key: 'lookmsg' }, look.msg) : null
                        ) : null,
                        React.createElement('div', { className: 'rp-fold', key: 'mem' },
                          React.createElement('div', { className: 'rp-fold-head', onClick: function () { memOpen[1](!memOpen[0]) } },
                            React.createElement('span', null,
                              React.createElement('span', { className: 'rp-fold-caret' + (memOpen[0] ? ' rp-fold-open' : '') }, '▸'),
                              React.createElement('span', { className: 'rp-fold-title' }, '记 忆' + (mem && (mem.long.length + mem.short.length) ? ' ·' + (mem.long.length + mem.short.length) : '')))),
                          memOpen[0] ? React.createElement('div', { className: 'rp-sb-scroll', style: { maxHeight: 170 } },
                            mem && (mem.long.length || mem.short.length || mem.likes.length || mem.dislikes.length || mem.topics.length)
                              ? React.createElement(React.Fragment, null,
                                  mem.long.map(function (t, i) { return React.createElement('div', { className: 'rp-sb-item', key: 'l' + i }, '· ' + t) }),
                                  mem.short.map(function (t, i) { return React.createElement('div', { className: 'rp-sb-item', key: 's' + i }, '· ' + t) }),
                                  mem.likes.length ? React.createElement('div', { className: 'rp-sb-item' }, '喜欢：' + mem.likes.join('、')) : null,
                                  mem.dislikes.length ? React.createElement('div', { className: 'rp-sb-item' }, '不喜欢：' + mem.dislikes.join('、')) : null,
                                  mem.topics.length ? React.createElement('div', { className: 'rp-sb-item rp-sb-item-dim' }, '话题：' + mem.topics.join('、')) : null
                                )
                              : React.createElement('div', { className: 'rp-sb-empty' }, '还没有记忆。对话中值得记住的事会自动沉淀到这里。')
                          ) : null
                        ),
                        React.createElement('div', { className: 'rp-fold', key: 'diary' },
                          React.createElement('div', { className: 'rp-fold-head', onClick: function () { diaryOpen[1](!diaryOpen[0]) } },
                            React.createElement('span', null,
                              React.createElement('span', { className: 'rp-fold-caret' + (diaryOpen[0] ? ' rp-fold-open' : '') }, '▸'),
                              React.createElement('span', { className: 'rp-fold-title' }, '日 记'))),
                          diaryOpen[0] ? React.createElement('div', { className: 'rp-sb-scroll' },
                            diary && diary.current
                              ? React.createElement(React.Fragment, null,
                                  React.createElement('div', { className: 'rp-sb-diary-date' }, diary.current.date),
                                  React.createElement('div', null, diary.current.content))
                              : React.createElement('div', { className: 'rp-sb-empty' }, '还没有日记。每天深夜的心跳会写一篇。')
                          ) : null
                        ),
                        React.createElement('div', { className: 'rp-sb-stage-wrap' },
                          React.createElement('div', { className: 'rp-sb-stage-title' }, '演 出'),
                          React.createElement('div', { className: 'rp-sb-stage-list' },
                            stage.length
                              ? stage.slice(0, 20).map(function (e) { return React.createElement('div', { className: 'rp-sb-stage-item' + (e.kind === 'env' ? ' rp-sb-stage-env' : ''), key: e.id }, e.text) })
                              : React.createElement('div', { className: 'rp-sb-empty' }, '演出区等待中…')
                          )
                        ),
                        React.createElement('div', { className: 'rp-sb-section rp-sb-pet' },
                          React.createElement('div', { className: 'rp-sb-section-title' }, '桌 宠'),
                          React.createElement('div', { className: 'rp-sb-row' },
                            React.createElement('span', { className: 'rp-sb-k' }, '状态'),
                            React.createElement('span', null, pet && pet.st
                              ? (pet.st.window === 'running' ? '🟢 运行中' : (pet.st.enabled ? '⏳ 启动中…' : '⚪ 已停用'))
                              : '…')),
                          c ? React.createElement('div', { className: 'rp-sb-row' },
                            React.createElement('span', { className: 'rp-sb-k' }, '角色'),
                            React.createElement('span', null, c.name + (st.stageLabel ? ' · ' + st.stageLabel : ''))) : null,
                          React.createElement('div', { className: 'rp-sb-pet-btns' },
                            React.createElement('button', { className: 'rp-sb-pet-btn rp-sb-pet-on', onClick: pet.start }, '启动桌宠'),
                            React.createElement('button', { className: 'rp-sb-pet-btn rp-sb-pet-off', onClick: pet.stop }, '关闭桌宠'))
                        )
                      ),
                  React.createElement('div', { className: 'rp-sb-section rp-sb-cards' },
                    React.createElement('div', { className: 'rp-sb-section-title' }, '角色 卡'),
                    cards.cards.loaded
                      ? React.createElement('div', { className: 'rp-sb-card-row' },
                          React.createElement('select', {
                            className: 'rp-sb-card-select',
                            value: cardSel[0],
                            onChange: function (ev) { cardSel[1](ev.target.value) },
                          }, cards.cards.list.map(function (ck) {
                            return React.createElement('option', { key: ck.id, value: ck.id }, ck.name)
                          })),
                          React.createElement('button', {
                            className: 'rp-sb-card-switch',
                            onClick: function () { if (cardSel[0]) cards.load(cardSel[0]) },
                          }, '切换'),
                          React.createElement('button', {
                            className: 'rp-sb-card-del',
                            onClick: function () {
                              var chosen = cardSel[0]
                              if (!chosen) return
                              var hit = cards.cards.list.filter(function (x) { return x.id === chosen })[0]
                              if (window.confirm('删除角色卡「' + (hit ? hit.name : chosen) + '」？')) cards.del(chosen)
                            },
                          }, '删卡')
                        )
                      : React.createElement('div', { className: 'rp-sb-empty' }, '还没有角色卡。可在会话里说「保存角色卡」或直接提供角色设定。')
                  ),
                  React.createElement('div', { className: 'rp-sb-section rp-sb-cards' },
                    React.createElement('div', { className: 'rp-sb-section-title' }, '房间 (双人)'),
                    st && st.roomMembers && st.roomMembers.length
                      ? React.createElement('div', { className: 'rp-sb-card-row' },
                          React.createElement('span', { className: 'rp-sb-room-badge' }, '🗣 ' + st.roomMembers.join(' · ')),
                          React.createElement('button', {
                            className: 'rp-sb-card-switch',
                            onClick: roomStop,
                          }, '关房间')
                        )
                      : (cards.cards.loaded
                          ? React.createElement('div', { className: 'rp-sb-card-row' },
                              React.createElement('select', {
                                className: 'rp-sb-card-select',
                                value: roomSel[0],
                                onChange: function (ev) { roomSel[1](ev.target.value) },
                              }, cards.cards.list.map(function (ck) {
                                return React.createElement('option', { key: ck.id, value: ck.id }, ck.name)
                              })),
                              React.createElement('button', {
                                className: 'rp-sb-card-switch',
                                onClick: roomStart,
                              }, '开房间')
                            )
                          : null)
                  ),
                  React.createElement('div', { className: 'rp-fold', key: 'shop' },
                    React.createElement('div', { className: 'rp-fold-head', onClick: function () { shopOpen[1](!shopOpen[0]) } },
                      React.createElement('span', null,
                        React.createElement('span', { className: 'rp-fold-caret' + (shopOpen[0] ? ' rp-fold-open' : '') }, '▸'),
                        React.createElement('span', { className: 'rp-fold-title' }, '商 城')),
                      st && st.economy ? React.createElement('span', { className: 'rp-fold-coins' }, '✦ ' + st.economy.coins) : null),
                    shopOpen[0] ? React.createElement('div', null,
                      st && st.savingGoal ? React.createElement('div', { className: 'rp-econ-msg', style: { marginBottom: 4 } },
                        '她正在攒钱买' + st.savingGoal.name + '（' + st.savingGoal.saved + '/' + st.savingGoal.price + ' ✦）') : null,
                      (st && st.shop ? st.shop : []).map(function (it) {
                        return React.createElement('div', { className: 'rp-shop-row', key: it.id },
                          React.createElement('span', { className: 'rp-shop-name' }, it.name),
                          React.createElement('span', { className: 'rp-shop-price' }, it.price + ' ✦'),
                          React.createElement('button', { className: 'rp-shop-btn buy', onClick: function () { buy(it.id) } }, '购买'))
                      }),
                      econMsg[0] ? React.createElement('div', { className: 'rp-econ-msg' }, econMsg[0]) : null
                    ) : null
                  ),
                  React.createElement('div', { className: 'rp-fold', key: 'pack' },
                    React.createElement('div', { className: 'rp-fold-head', onClick: function () { packOpen[1](!packOpen[0]) } },
                      React.createElement('span', null,
                        React.createElement('span', { className: 'rp-fold-caret' + (packOpen[0] ? ' rp-fold-open' : '') }, '▸'),
                        React.createElement('span', { className: 'rp-fold-title' }, '背 包')),
                      st && st.inventory && st.inventory.length ? React.createElement('span', { className: 'rp-fold-coins' }, st.inventory.length + ' 件') : null),
                    packOpen[0] ? React.createElement('div', null,
                      React.createElement('button', {
                        className: 'rp-shop-btn buy',
                        style: { width: '100%', padding: '6px 0', marginBottom: '4px' },
                        onClick: function () { feedOpen[1](true) },
                      }, '🍙 投喂'),
                      (st && st.inventory ? st.inventory.filter(function (x) { return x.kind !== 'food' }) : []).length
                        ? st.inventory.filter(function (x) { return x.kind !== 'food' }).map(function (it) {
                            return React.createElement('div', { className: 'rp-shop-row', key: it.id },
                              React.createElement('span', { className: 'rp-shop-name' }, it.name + ' ×' + it.qty),
                              React.createElement('button', { className: 'rp-shop-btn use', onClick: function () { use(it.id) } }, '使用'))
                          })
                        : React.createElement('div', { className: 'rp-sb-empty' }, '背包里没有药品/礼物，食物请用上面的「投喂」。'),
                      econMsg[0] ? React.createElement('div', { className: 'rp-econ-msg' }, econMsg[0]) : null
                    ) : null
                  ),
                  React.createElement('div', { className: 'rp-sb-section rp-sb-settings', key: 'settings' },
                    React.createElement('div', { className: 'rp-sb-section-title' }, '设 置'),
                    React.createElement('div', { className: 'rp-sb-set-row' },
                      React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-hb' }, '心跳间隔'),
                      React.createElement('select', { id: 'rp-hb', className: 'rp-sb-set-input', defaultValue: String((st && st.settings && st.settings.heartbeatMinutes) || 30) },
                        [10, 30, 60, 120, 240].map(function (m) {
                          return React.createElement('option', { key: m, value: String(m) }, m + ' 分钟')
                        }))
                    ),
                    React.createElement('div', { className: 'rp-sb-set-row' },
                      React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-narr' }, '叙述风格'),
                      React.createElement('select', { id: 'rp-narr', className: 'rp-sb-set-input', defaultValue: (st && st.settings && st.settings.narrationMode) || 'novel' },
                        [['novel', '小说模式'], ['script', '剧本模式'], ['compact', '精简模式']].map(function (m) {
                          return React.createElement('option', { key: m[0], value: m[0] }, m[1])
                        }))
                    ),
                    React.createElement('div', { className: 'rp-sb-set-row' },
                      React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-diff' }, '养成难度'),
                      React.createElement('select', { id: 'rp-diff', className: 'rp-sb-set-input', defaultValue: String((st && st.settings && st.settings.difficulty) || 2) },
                        [['1', '休闲'], ['2', '标准'], ['3', '困难']].map(function (m) {
                          return React.createElement('option', { key: m[0], value: m[0] }, m[1])
                        }))
                    ),
                    React.createElement('label', { className: 'rp-sb-set-check', htmlFor: 'rp-statsen' },
                      React.createElement('input', { id: 'rp-statsen', type: 'checkbox', defaultChecked: !(st && st.settings && st.settings.statsEnabled === false) }),
                      '属性系统（生命/健康/饱食/心情）'),
                    React.createElement('div', { className: 'rp-fold-head', style: { marginTop: 6 }, onClick: function () { moreOpen[1](!moreOpen[0]) } },
                      React.createElement('span', null,
                        React.createElement('span', { className: 'rp-fold-caret' + (moreOpen[0] ? ' rp-fold-open' : '') }, '▸'),
                        React.createElement('span', { className: 'rp-fold-title' }, '更多设置'))),
                    moreOpen[0] ? React.createElement('div', null,
                      c ? React.createElement('div', { className: 'rp-sb-set-row' },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-mode' }, '扮演模式'),
                        React.createElement('select', { id: 'rp-mode', className: 'rp-sb-set-input', defaultValue: (c && c.mode) || 'default' },
                          [['default', '默认'], ['fast', '快速'], ['deep', '深度']].map(function (m) {
                            return React.createElement('option', { key: m[0], value: m[0] }, m[1])
                          }))
                      ) : null,
                      React.createElement('div', { className: 'rp-sb-set-row', style: { alignItems: 'flex-start' } },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-sstart', style: { paddingTop: 4 } }, '剧本开头'),
                        React.createElement('textarea', { id: 'rp-sstart', className: 'rp-sb-set-textarea', defaultValue: (st && st.settings && st.settings.scriptStart) || '', placeholder: '剧本模式用：起始场景/状态，留空则不限' })
                      ),
                      React.createElement('div', { className: 'rp-sb-set-row', style: { alignItems: 'flex-start' } },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-send', style: { paddingTop: 4 } }, '剧本结尾'),
                        React.createElement('textarea', { id: 'rp-send', className: 'rp-sb-set-textarea', defaultValue: (st && st.settings && st.settings.scriptEnd) || '', placeholder: '剧本模式用：目标结局，到达时自动收束' })
                      ),
                      c ? React.createElement('div', { className: 'rp-sb-set-row' },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-scene' }, '场景'),
                        React.createElement('input', { id: 'rp-scene', className: 'rp-sb-set-input', defaultValue: c.scene || '', placeholder: '当前场景' })
                      ) : null,
                      c ? React.createElement('div', { className: 'rp-sb-set-row', style: { alignItems: 'flex-start' } },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-persona', style: { paddingTop: 4 } }, '人设'),
                        React.createElement('textarea', { id: 'rp-persona', className: 'rp-sb-set-textarea', defaultValue: c.persona || '', placeholder: '角色人设' })
                      ) : null,
                      c ? React.createElement('div', { className: 'rp-sb-set-row' },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-greet' }, '开场白'),
                        React.createElement('input', { id: 'rp-greet', className: 'rp-sb-set-input', defaultValue: c.greeting || '', placeholder: '下次开演时的问候语' })
                      ) : null,
                      React.createElement('div', { className: 'rp-sb-set-row' },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-shotw' }, '截图宽度'),
                        React.createElement('input', { id: 'rp-shotw', className: 'rp-sb-set-input', defaultValue: String((st && st.settings && st.settings.shotMaxW) || 0), placeholder: '0 = 原始分辨率' })
                      ),
                      React.createElement('label', { className: 'rp-sb-set-check', htmlFor: 'rp-autolook' },
                        React.createElement('input', { id: 'rp-autolook', type: 'checkbox', defaultChecked: !!(st && st.settings && st.settings.autoLook) }),
                        '心跳时允许角色主动看桌面'),
                      React.createElement('label', { className: 'rp-sb-set-check', htmlFor: 'rp-relen' },
                        React.createElement('input', { id: 'rp-relen', type: 'checkbox', defaultChecked: !(st && st.settings && st.settings.relationEnabled === false) }),
                        '亲密度系统'),
                      React.createElement('div', { className: 'rp-sb-set-row' },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-relpace' }, '亲密度进度'),
                        React.createElement('select', { id: 'rp-relpace', className: 'rp-sb-set-input', defaultValue: (st && st.settings && st.settings.relPace) || 'normal' },
                          React.createElement('option', { value: 'slow' }, '慢热（涨得慢，细水长流）'),
                          React.createElement('option', { value: 'normal' }, '正常'),
                          React.createElement('option', { value: 'fast' }, '快速（进展飞快）'))
                      ),
                      React.createElement('label', { className: 'rp-sb-set-check', htmlFor: 'rp-storyen' },
                        React.createElement('input', { id: 'rp-storyen', type: 'checkbox', defaultChecked: !(st && st.settings && st.settings.storyEnabled === false) }),
                        '剧情档案（章节式故事库）'),
                      React.createElement('label', { className: 'rp-sb-set-check', htmlFor: 'rp-summen' },
                        React.createElement('input', { id: 'rp-summen', type: 'checkbox', defaultChecked: !(st && st.settings && st.settings.summaryEnabled === false) }),
                        '剧情概况（浓缩摘要防遗忘）'),
                      React.createElement('label', { className: 'rp-sb-set-check', htmlFor: 'rp-uppen' },
                        React.createElement('input', { id: 'rp-uppen', type: 'checkbox', defaultChecked: !(st && st.settings && st.settings.userProfileEnabled === false) }),
                        '用户档案（角色对你的认知）'),
                      React.createElement('div', { className: 'rp-sb-set-label', style: { margin: '6px 0 2px' } }, '我的档案'),
                      React.createElement('div', { className: 'rp-sb-set-row' },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-upnick' }, '称呼'),
                        React.createElement('input', { id: 'rp-upnick', className: 'rp-sb-set-input', defaultValue: (st && st.userProfile && st.userProfile.nickname) || '', placeholder: '她怎么叫你' })
                      ),
                      React.createElement('div', { className: 'rp-sb-set-row' },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-upid' }, '身份'),
                        React.createElement('input', { id: 'rp-upid', className: 'rp-sb-set-input', defaultValue: (st && st.userProfile && st.userProfile.identity) || '', placeholder: '学生/社畜/旅人…' })
                      ),
                      React.createElement('div', { className: 'rp-sb-set-row' },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-upapp' }, '外貌'),
                        React.createElement('input', { id: 'rp-upapp', className: 'rp-sb-set-input', defaultValue: (st && st.userProfile && st.userProfile.appearance) || '', placeholder: '一两句话，她眼里记住的样子' })
                      ),
                      React.createElement('div', { className: 'rp-sb-set-row', style: { alignItems: 'flex-start' } },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-upbg', style: { paddingTop: 4 } }, '背景'),
                        React.createElement('textarea', { id: 'rp-upbg', className: 'rp-sb-set-textarea', defaultValue: (st && st.userProfile && st.userProfile.background) || '', placeholder: '她该知道的你（擅长/经历/秘密…）' })
                      ),
                      React.createElement('div', { className: 'rp-sb-set-row', style: { alignItems: 'flex-start' } },
                        React.createElement('label', { className: 'rp-sb-set-label', htmlFor: 'rp-upsp', style: { paddingTop: 4 } }, '说话方式'),
                        React.createElement('textarea', { id: 'rp-upsp', className: 'rp-sb-set-textarea', defaultValue: (st && st.userProfile && st.userProfile.speechStyle) || '', placeholder: '你怎么说话：简短/毒舌/爱开玩笑…' })
                      ),
                      React.createElement('button', { className: 'rp-sb-set-save', onClick: saveProfile }, '保存我的档案')
                    ) : null,
                    React.createElement('button', { className: 'rp-sb-set-save', onClick: saveSettings }, '保存设置'),
                    saveMsg[0] ? React.createElement('div', { className: 'rp-sb-set-msg' }, saveMsg[0]) : null
                  ),
                  c ? React.createElement('button', {
                    className: 'rp-sb-stop',
                    onClick: function () {
                      rpc('stop', sessionId ? { sessionId: sessionId } : {})
                        .catch(function () {})
                      setSbOpen(false)
                    },
                  }, '结束扮演') : null
                )
              ,
              // 投喂选择弹窗（点选背包中的食物；遮罩或 × 关闭）
              feedOpen[0] ? React.createElement('div', {
                className: 'rp-feed-overlay',
                onClick: function () { feedOpen[1](false) },
              },
                React.createElement('div', {
                  className: 'rp-feed-modal',
                  onClick: function (e) { e.stopPropagation() },
                },
                  React.createElement('div', { className: 'rp-feed-head' },
                    React.createElement('span', null, '🍙 投喂'),
                    React.createElement('button', { className: 'rp-feed-close', onClick: function () { feedOpen[1](false) } }, '×')),
                  st && st.inventory && st.inventory.filter(function (x) { return x.kind === 'food' }).length
                    ? st.inventory.filter(function (x) { return x.kind === 'food' }).map(function (it) {
                        return React.createElement('div', {
                          className: 'rp-shop-row rp-feed-item',
                          key: it.id,
                          onClick: function () { feedOpen[1](false); use(it.id) },
                        },
                          React.createElement('span', { className: 'rp-shop-name' }, it.name),
                          React.createElement('span', { className: 'rp-shop-price' }, '×' + it.qty))
                      })
                    : React.createElement('div', { className: 'rp-sb-empty' }, '背包里没有食物，先去商城买点吧。'),
                  econMsg[0] ? React.createElement('div', { className: 'rp-econ-msg' }, econMsg[0]) : null
                )
              ) : null
            )
            }
          )
        })
          // ── DSH「插件设置」面板卡片已移除（2026-08-27）──
          // rc.2 的 settings 命名空间通道废弃后该卡片长期"无法读取"，用户决定不修；
          // 全部设置已集中在侧栏「设置」区（无需开演角色即可编辑，直接写引擎）。
      },
    }

    return plugin
  },
})
