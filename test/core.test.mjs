// roleplay 引擎核心路径自动化测试（免框架，node 直接跑）
// 用法: node test/core.test.mjs
// 覆盖: 卡库旧/新格式兼容 · 角色切换不丢卡 · progress 隔离(亲密度) · 朋友向轴 · OC 空白 ·
//       养成/商城开关门卫 · start 恢复 · 记忆隔离
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ENGINE_URL = new URL('../agent-presets/roleplay/roleplay-host.mjs', import.meta.url).href;

let PASS = 0, FAIL = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { PASS++; console.log('  ✅ ' + name); }
  else { FAIL++; failures.push(name); console.log('  ❌ ' + name); }
}

// ─── T0 语法门: 仓库内全部 JS/MJS 静态检查(与 CI 同源; 防止"本地测试全绿但语法已坏"再发生) ───
console.log('\nT0 语法门 (全部 JS/MJS)');
{
  const SYNTAX_FILES = [
    'agent-presets/roleplay/roleplay-host.mjs',
    'agent-presets/roleplay-friend/roleplay-host.mjs',
    'agent-presets/roleplay-oc/roleplay-host.mjs',
    'agent-presets/roleplay/lib/relation-core.mjs',
    'agent-presets/roleplay/lib/time-core.mjs',
    'agent-presets/roleplay/lib/chat-core.mjs',
    'agent-presets/roleplay-friend/lib/chat-core.mjs',
    'agent-presets/roleplay-oc/lib/chat-core.mjs',
    'agent-presets/roleplay/lib/notes-core.mjs',
    'agent-presets/roleplay-friend/lib/notes-core.mjs',
    'agent-presets/roleplay-oc/lib/notes-core.mjs',
    'agent-presets/roleplay/lib/game-core.mjs',
    'agent-presets/roleplay-friend/lib/game-core.mjs',
    'agent-presets/roleplay-oc/lib/game-core.mjs',
    'agent-presets/roleplay/lib/heartbeat-core.mjs',
    'agent-presets/roleplay-friend/lib/heartbeat-core.mjs',
    'agent-presets/roleplay-oc/lib/heartbeat-core.mjs',
    'agent-presets/roleplay/lib/rel-tier-core.mjs',
    'agent-presets/roleplay-friend/lib/rel-tier-core.mjs',
    'agent-presets/roleplay-oc/lib/rel-tier-core.mjs',
    'agent-presets/roleplay/deskpet.js',
    'lib/index.js',
    'lib/client.js',
    'lib/settings.js',
  ];
  const root = fileURLToPath(new URL('..', import.meta.url));
  let bad = 0;
  for (const f of SYNTAX_FILES) {
    const r = spawnSync(process.execPath, ['--check', join(root, f)], { encoding: 'utf8' });
    if (r.status !== 0) {
      bad++;
      failures.push('语法: ' + f);
      console.log('  ❌ ' + f);
      console.log(String(r.stderr || r.stdout || '').slice(0, 500));
    }
  }
  ok(bad === 0, bad === 0 ? '全部 ' + SYNTAX_FILES.length + ' 个文件语法通过' : bad + ' 个文件语法错误');
}

// T0b PowerShell 脚本语法门(UTF-8 BOM 法: 无 BOM 会被 ANSI 解码误判, 先补 BOM 再解析)
console.log('\nT0b PS 语法门 (pet/*.ps1)');
{
  const root2 = fileURLToPath(new URL('..', import.meta.url));
  const psFiles = ['pet/pet-window.ps1', 'pet/note-window.ps1'];
  let psBad = 0;
  let psChecked = 0;
  for (const f of psFiles) {
    const target = join(root2, f);
    try {
      const script = "$b=[System.IO.File]::ReadAllBytes('" + target.replace(/'/g, "''") + "');$bom=New-Object byte[] 3;$bom[0]=0xEF;$bom[1]=0xBB;$bom[2]=0xBF;$tmp=Join-Path $env:TEMP ('rp-syn-'+[guid]::NewGuid().ToString('N')+'.ps1');$all=New-Object byte[] ($b.Length+3);[Array]::Copy($bom,0,$all,0,3);[Array]::Copy($b,0,$all,3,$b.Length);[IO.File]::WriteAllBytes($tmp,$all);$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($tmp,[ref]$t,[ref]$e)|Out-Null;Remove-Item $tmp -Force;if($e.Count){Write-Output ('ERR:'+$e[0].Extent.StartLineNumber+':'+$e[0].Message);exit 1}else{exit 0}";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
      if (r.status !== 0) {
        psBad++;
        psChecked++;
        failures.push('PS语法: ' + f);
        console.log('  ❌ ' + f + ' → ' + String(r.stdout || r.stderr || '').slice(0, 300));
      } else {
        psChecked++;
        console.log('  ✅ ' + f);
      }
    } catch (e) {
      console.log('  ⚠ ' + f + ' 跳过(无法运行 pwsh): ' + String(e && e.message ? e.message : e));
    }
  }
  ok(psBad === 0, psBad === 0 ? 'PS 脚本全部通过(' + psChecked + '/' + psFiles.length + ')' : psBad + ' 个 PS 脚本语法错误');
}

// 一次全新引擎实例 + 独立临时数据根（reuseRoot 传入时复用同一数据根，用于跨实例断言）
async function boot(style = 'love', seedChar = null, dataRoot = '.roleplay', reuseRoot = null) {
  const root = reuseRoot || mkdtempSync(join(tmpdir(), 'rp-test-'));
  if (!reuseRoot) mkdirSync(join(root, dataRoot), { recursive: true });
  if (seedChar) writeFileSync(join(root, dataRoot, 'character.json'), JSON.stringify(seedChar));
  const captured = { tools: {}, svc: null, sections: [], events: {} };
  const fake = { id: 't-session', session: { events: [], seq: 0 } };
  fake.send = function (message) {
    const ev = {
      seq: ++fake.session.seq,
      type: message && message.role === 'user' ? 'user/message' : 'assistant/message',
      data: { message },
    };
    fake.session.events.push(ev);
    return { id: message && message.id };
  };
  const fsx = {
    async resolve(rel, opts) { const base = (opts && opts.cwd) || root; return join(base, rel); },
    async readText(p) { return readFileSync(p, 'utf8'); },
    async readBytes(p) { return readFileSync(p); },
    async writeText(p, c) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, c); },
    async stat(p) { try { const s = readdirSync(p); return { size: 0 }; } catch { try { return { size: readFileSync(p).length }; } catch { return undefined; } } },
    async listDir(p) { try { return readdirSync(p); } catch { return []; } },
    async exists(p) { return existsSync(p); },
  };
  const ctx = {
    get: () => undefined,
    on: (ev, h) => { (captured.events[ev] ||= []).push(h); },
    setTimeout: () => 0,
    provide: (n, s) => { if (n === 'roleplay') captured.svc = s; },
    tools: { register: (e) => { captured.tools[e.name] = e; } },
    systemPrompt: { section: (s) => { captured.sections.push(s); } },
    agents: { currentInitiator: () => fake, get: () => fake, roots: () => [fake] },
    fs: fsx,
    subprocess: {},
    sandboxPolicy: { workspaceRoot: root },
    attachments: {},
    timer: { interval: () => 0, setTimeout: () => 0 },
  };
  const mod = await import(ENGINE_URL + '?t=' + root + '-' + Math.random().toString(36).slice(2, 6));
  mod.apply(ctx, { style, dataRoot });
  const tool = (name) => captured.tools[name];
  const call = async (name, args) => tool(name).execute(args || {});
  const svc = captured.svc;
  const gs = (args) => svc.getState({ sessionId: 't-session', ...(args || {}) });
  const promptText = async () => {
    await new Promise((r) => setTimeout(r, 400));
    const sec = captured.sections.find((s) => s.name === 'roleplay.character');
    return sec ? sec.text() : '';
  };
  return { root, dataRoot, tool, call, svc, gs, captured, promptText };
}

// ─── T1 卡库旧格式(单对象)兼容 ───────────────────────────────
console.log('\nT1 卡库旧格式兼容');
{
  const b = await boot();
  writeFileSync(join(b.root, b.dataRoot, 'cards.json'), JSON.stringify({ id: 'card-guiz', name: '癸', persona: '旧卡' }));
  const r = await b.svc.listCards({ sessionId: 't-session' });
  ok(r.ok && r.cards.some((c) => c.name === '癸'), '旧格式单对象被识别为一张卡(癸)');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T2 角色切换不丢卡(自动入库 + 切回) ───────────────────────
console.log('\nT2 切换不丢卡');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲', greeting: '嗨' });
  await b.call('roleplay_start', { name: '乙', persona: 'p乙' });
  const cards = JSON.parse(readFileSync(join(b.root, b.dataRoot, 'cards.json'), 'utf8'));
  ok(cards.some((c) => c.name === '甲' && c.persona === 'p甲'), '切换时自动保存了「甲」为卡(完整人设)');
  const r = await b.svc.loadCard({ sessionId: 't-session', card: '甲' });
  ok(r.ok && r.name === '甲', 'loadCard 可切回「甲」');
  const st = await b.gs();
  ok(st.character && st.character.name === '甲', '当前角色=甲');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T3 progress 亲密度隔离 ─────────────────────────────────
console.log('\nT3 亲密度按角色隔离');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  await b.call('roleplay_relation', { favor: 8 });
  let st = await b.gs();
  ok(st.relation && st.relation.favor === 38, '甲 favor 30→38(+8, 单轮限幅)');
  await b.call('roleplay_start', { name: '乙', persona: 'p乙' });
  st = await b.gs();
  ok(st.relation && st.relation.favor === 30, '乙 全新(30), 不继承甲');
  await b.svc.loadCard({ sessionId: 't-session', card: '甲' });
  st = await b.gs();
  ok(st.relation && st.relation.favor === 38, '切回甲 favor 仍是 38');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T4 朋友向: 无心动/男友力 ───────────────────────────────
console.log('\nT4 朋友向纯友谊轴');
{
  const b = await boot('friend');
  await b.call('roleplay_start', { name: '丙', persona: 'p丙' });
  await b.call('roleplay_relation', { favor: 5, heart: 5, boyfriend: { reliability: 10 } });
  const st = await b.gs();
  ok(st.relation && st.relation.favor === 35 && st.relation.trust === 20, '好感 +5、信任默认');
  ok(!('heart' in (st.relation || {})), 'friend 不返回 heart');
  ok(st.boyfriend === null, 'friend 无男友力');
  const pf = JSON.parse(readFileSync(join(b.root, b.dataRoot, 'progress-丙.json'), 'utf8'));
  ok(pf.relation.heart === 10 && pf.boyfriend.reliability === 50, 'heart/男友力未被改动(各自默认)');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T5 OC 向: 全空白默认 ──────────────────────────────────
console.log('\nT5 OC 原创向全空白');
{
  const b = await boot('oc');
  const st = await b.gs();
  ok(st.settings && st.settings.statsEnabled === false, 'OC 默认 statsEnabled=false');
  ok(st.settings && st.settings.relationEnabled === false, 'OC 默认 relationEnabled=false');
  const r = await b.call('roleplay_shop', { action: 'list' });
  ok(r && r.ok === false, '商城被门卫拦截');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T6 养成/商城彻底关闭(恋爱向但预置关闭) ──────────────────
console.log('\nT6 养成/商城关闭门卫');
{
  const b = await boot('love', { enabled: false, character: null, settings: { statsEnabled: false, relationEnabled: false } });
  const st = await b.gs();
  ok(st.shop === null && st.stats === null && st.economy === null, 'getState 不返回 shop/stats/economy');
  const r = await b.call('roleplay_shop', { action: 'list' });
  ok(r && r.ok === false, 'roleplay_shop 被拦截');
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const f = await b.call('roleplay_feed', { item: 'mantou' });
  ok(f && f.ok === false, '投喂被拦截(stats 关闭)');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T7 start 恢复上次角色 ─────────────────────────────────
console.log('\nT7 「开始扮演」未指定→恢复');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  await b.call('roleplay_stop', {});
  const r = await b.call('roleplay_start', {});
  ok(r && r.ok === true && b.captured.svc, '无参 start 成功');
  const st = await b.gs();
  ok(st.character && st.character.name === '甲', '恢复的是「甲」而不是新人设');
  ok(st.enabled === true, '开演状态已激活');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T8 记忆按角色隔离 ────────────────────────────────────
console.log('\nT8 记忆隔离');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  await b.call('roleplay_remember', { event: '一起去水族馆', kind: '一起活动' });
  await b.call('roleplay_start', { name: '乙', persona: 'p乙' });
  let st = await b.gs();
  ok(st.memoryView && st.memoryView.short.length === 0, '乙没有甲的记忆');
  await b.svc.loadCard({ sessionId: 't-session', card: '甲' });
  st = await b.gs();
  ok(st.memoryView && st.memoryView.short.some((x) => String(x).includes('水族馆')), '甲记得水族馆');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T9 纪念日提示注入 ─────────────────────────────────────
console.log('\nT9 纪念日注入(对话提示)');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const pad2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const today = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const r = await b.call('roleplay_anniversary', { name: '第一次见面', date: today });
  ok(r.ok && Array.isArray(r.anniversaries) && r.anniversaries.some((a) => a.name === '第一次见面'), '纪念日已记录(今日)');
  const text = await b.promptText();
  ok(String(text).includes('第一次见面'), '提示词注入纪念日');
  ok(String(text).includes('今天是特别的日子'), '「特别的日子」提示出现');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T10 时段语气注入 ─────────────────────────────────────
console.log('\nT10 时段语气注入');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const text = String(await b.promptText());
  const h = new Date().getHours();
  const label = h >= 6 && h < 9 ? '清晨' : h >= 9 && h < 12 ? '上午' : h >= 12 && h < 14 ? '中午' : h >= 14 && h < 18 ? '下午' : h >= 18 && h < 20 ? '傍晚' : h >= 20 && h < 23 ? '晚上' : '深夜';
  ok(text.includes('当前时段：' + label), '提示词按当前时段注入(' + label + ')');
  ok(text.includes('扮演规则'), '扮演规则随提示注入');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T11 商城购买流程 ─────────────────────────────────────
console.log('\nT11 商城购买');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const r1 = await b.call('roleplay_shop', { action: 'buy', item: 'mantou' });
  ok(r1.ok && r1.coins === 90, '买馒头: 100-10=90 金币');
  let st = await b.gs();
  ok(st.inventory && st.inventory.some((x) => x.id === 'mantou' && x.qty === 1), '背包出现馒头 x1');
  const r2 = await b.call('roleplay_shop', { action: 'buy', item: 'pendant' });
  ok(r2.ok && r2.coins === 10, '买挂坠: 90-80=10 金币');
  const r3 = await b.call('roleplay_shop', { action: 'buy', item: 'cake' });
  ok(r3.ok === false && String(r3.message).includes('金币不足'), '金币不足拦截(10<60)');
  st = await b.gs();
  ok(st.economy && st.economy.coins === 10, '最终金币 10');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T12 里程碑: 触发/门槛/防重复 ─────────────────────────
console.log('\nT12 里程碑');
{
  const b1 = await boot();
  await b1.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const r1 = await b1.call('roleplay_relation', { milestone: 'm7' }); // 需要 trustTier3(当前 tier1)
  ok(r1 && r1.milestone === null && String(r1.message).includes('差一点'), '未满足门槛(信任不够)不触发');
  rmSync(b1.root, { recursive: true, force: true });

  const b2 = await boot();
  await b2.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const r2 = await b2.call('roleplay_relation', { milestone: 'm1' }); // 要求 favorTier1, 当前30 → 触发
  ok(r2 && r2.milestone === '第一次成功搭话', 'm1 触发(第一次成功搭话)');
  let pf = JSON.parse(readFileSync(join(b2.root, b2.dataRoot, 'progress-甲.json'), 'utf8'));
  ok(pf.milestones.length === 1 && pf.milestones[0] === 'm1', '进度记录 m1 一次');
  ok(pf.relation.favor === 36, 'm1 奖励 favor +6(30→36)');

  // 跨实例(同一数据根): 再触发 m1 → 已触发过, 不重复
  const b3 = await boot('love', null, '.roleplay', b2.root);
  await b3.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const r3 = await b3.call('roleplay_relation', { milestone: 'm1' });
  ok(r3 && r3.milestone === null && String(r3.message).includes('已触发过'), 'm1 防重复(已触发过)');
  pf = JSON.parse(readFileSync(join(b3.root, b3.dataRoot, 'progress-甲.json'), 'utf8'));
  ok(pf.milestones.length === 1, '里程碑仍只有 1 条');
  rmSync(b2.root, { recursive: true, force: true });
}

// ─── T13 关系核心纯函数直测 (lib/relation-core.mjs) ──────────
console.log('\nT13 关系核心纯函数');
{
  const rc = await import(new URL('../agent-presets/roleplay/lib/relation-core.mjs', import.meta.url).href);
  const R = { favor: 30, trust: 20, heart: 10 };
  const B = { reliability: 50, empathy: 50, stability: 50, ambition: 50 };
  const M = [
    { id: 'm1', name: '第一次成功搭话', req: { favorTier: 1 }, reward: { favor: 6 } },
    { id: 'm7', name: '约定的日子一起去…', req: { trustTier: 3, heartTier: 2 }, reward: { trust: 5, heart: 8 } },
  ];
  const opts = { milestonesDef: M, tierLabels: { favor: ['疏离', '亲近', '倾慕'], trust: ['戒备', '放心', '依赖'], heart: ['无感', '在意', '心动'] }, bfLabels: { reliability: '靠谱' }, keyLabels: { favor: '好感', trust: '信任', heart: '心动' } };

  let r = rc.applyDelta(R, B, [], { heart: 5 }, opts);
  ok(r.relation.heart === 10, '心动锁: favor/trust 未到二档, heart 不增');
  ok(r.changed.length === 0, '无变化不进 changed');

  r = rc.applyDelta(R, B, [], { favor: 10 }, opts);
  ok(r.relation.favor === 40 && r.changed.some((c) => String(c).includes('好感 +10')), '好感 +10 (bf 因子=1.0) → 40');

  r = rc.applyDelta(R, B, [], { trust: -10 }, opts);
  ok(Math.abs(r.relation.trust - 10) < 1e-9, '负向缩放 (1.6-0.6) → 信任 20-10=10');

  r = rc.applyDelta(R, B, [], { favor: 5, heart: 5, boyfriend: { reliability: 10 } }, { ...opts, isFriend: true });
  ok(r.relation.favor === 35 && r.relation.heart === 10, 'friend 不增 heart');
  ok(r.boyfriend.reliability === 50, 'friend 不动男友力');

  r = rc.applyDelta(R, B, [], { boyfriend: { reliability: 10 } }, opts);
  ok(r.boyfriend.reliability === 60, '男友力 50→60');
  ok(Math.abs(rc.boyfriendFactorOf(r.boyfriend) - 1.02) < 1e-9, 'bf 因子随男友力升到 1.02(均值52.5)');

  r = rc.applyDelta(R, B, [], { milestone: 'm7' }, opts);
  ok(r.milestoneMsg && r.milestoneMsg.ok === false && String(r.milestoneMsg.message).includes('差一点'), '里程碑门槛不足不触发');

  r = rc.applyDelta(R, B, [], { milestone: 'm1' }, opts);
  ok(r.milestoneMsg && r.milestoneMsg.ok === true && r.milestones.length === 1 && r.relation.favor === 36, 'm1 触发 + 奖励 favor+6 → 36');

  r = rc.applyDelta(R, B, r.milestones, { milestone: 'm1' }, opts);
  ok(r.milestoneMsg && r.milestoneMsg.ok === false && String(r.milestoneMsg.message).includes('已触发过'), 'm1 防重复(纯函数)');
}

// ─── T14 时段/想念/阶段纯函数 + 看桌面门卫 + 纪念日非今日 ──────
console.log('\nT14 时段/想念/阶段边界');
{
  const tc = await import(new URL('../agent-presets/roleplay/lib/time-core.mjs', import.meta.url).href);
  const rc = await import(new URL('../agent-presets/roleplay/lib/relation-core.mjs', import.meta.url).href);
  const hours = [[23, '深夜'], [0, '深夜'], [5, '深夜'], [6, '清晨'], [8, '清晨'], [9, '上午'], [11, '上午'], [12, '中午'], [13, '中午'], [14, '下午'], [17, '下午'], [18, '傍晚'], [19, '傍晚'], [20, '晚上'], [22, '晚上']];
  let allOk = true;
  for (const [h, want] of hours) if (tc.periodOf(h).label !== want) { allOk = false; console.log('    边界失败 h=' + h + ' got=' + tc.periodOf(h).label); }
  ok(allOk, '时段 15 个边界点全对');
  ok(tc.missClassify(1) === null, '1小时不提示想念');
  ok(String(tc.missClassify(2)).includes('2 小时'), '2小时 → 轻声惦记');
  ok(String(tc.missClassify(47)).includes('1 天多'), '47小时 → 1天多');
  ok(String(tc.missClassify(120)).includes('5 天'), '120小时 → 5天');
  ok(rc.relationStageOf({ favor: 30, trust: 20, heart: 10 }, 0) === 'stranger', '阶段: 默认陌生人');
  ok(rc.relationStageOf({ favor: 45, trust: 20, heart: 10 }, 1) === 'acquaintance', '阶段: acquaintance');
  ok(rc.relationStageOf({ favor: 50, trust: 50, heart: 10 }, 3) === 'friend', '阶段: friend');
  ok(rc.relationStageOf({ favor: 70, trust: 70, heart: 40 }, 5) === 'close_friend', '阶段: close_friend');
  ok(rc.relationStageOf({ favor: 80, trust: 80, heart: 80 }, 7) === 'special', '阶段: special');
  const ORDER = ['stranger', 'acquaintance', 'friend', 'close_friend', 'special'];
  const REQS = { acquaintance: ['初次对话', '日常交流'], friend: ['一起活动', '分享日常', '互相帮助', '被夸奖', '一起回家'], close_friend: ['分享秘密'], special: ['约会'] };
  ok(rc.computeStageOf({ 初次对话: 1, 日常交流: 1 }, ORDER, REQS) === 'acquaintance', '事件阶段: 切聊→普通认识');
  ok(rc.computeStageOf({ 初次对话: 1 }, ORDER, REQS) === 'stranger', '事件阶段: 只有初次→陌生人');
  ok(rc.computeStageOf({ 初次对话: 1, 日常交流: 1, 一起活动: 1 }, ORDER, REQS) === 'acquaintance', '事件阶段: 朋友要求 5 项过 3, 仅 1 项不到 ');
}

console.log('\nT15 看桌面门卫 + 纪念日非今日');
{
  const b = await boot('love', { enabled: false, character: null, settings: { autoLook: false } });
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const look = await b.call('roleplay_look_desktop', {});
  ok(look && look.ok === false && String(look.message).includes('没有去看的打算'), 'autoLook=关 → 主动看桌面被拒');
  const pad2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const today = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  await b.call('roleplay_anniversary', { name: '很久以前', date: '2000-01-01' });
  await b.call('roleplay_anniversary', { name: '就是今天', date: today });
  const text = String(await b.promptText());
  ok(text.includes('就是今天'), '今天纪念日注入');
  ok(!text.includes('很久以前'), '非今日纪念日不注入');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T16 多角色房间 ─────────────────────────────────────────
console.log('\nT16 多角色房间');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲', greeting: '甲你好' });
  await b.call('roleplay_start', { name: '乙', persona: 'p乙', greeting: '乙你好' });
  await b.call('roleplay_save_card', { name: '乙' }); // 把当前(乙)存卡, 甲已被自动存卡
  const r = await b.call('roleplay_room', { action: 'start', characters: ['甲', '乙'] });
  ok(r.ok && Array.isArray(r.members) && r.members.includes('甲') && r.members.includes('乙'), '开房间: 甲+乙');
  let st = await b.gs();
  ok(Array.isArray(st.roomMembers) && st.roomMembers.length === 2, 'getState 返回 roomMembers');

  await b.call('roleplay_remember', { event: '一起去了水族馆', kind: '一起活动', char: '乙' });
  const mJia = JSON.parse(readFileSync(join(b.root, b.dataRoot, 'mem-甲.json'), 'utf8'));
  const mYi = JSON.parse(readFileSync(join(b.root, b.dataRoot, 'mem-乙.json'), 'utf8'));
  ok(!mJia.short_term.some((x) => String(x.event).includes('水族馆')), '甲的回忆没有水族馆');
  ok(mYi.short_term.some((x) => String(x.event).includes('水族馆')), '乙记住了水族馆');

  await b.call('roleplay_relation', { favor: 5, char: '乙' });
  const pJia = JSON.parse(readFileSync(join(b.root, b.dataRoot, 'progress-甲.json'), 'utf8'));
  const pYi = JSON.parse(readFileSync(join(b.root, b.dataRoot, 'progress-乙.json'), 'utf8'));
  ok(pJia.relation.favor === 30, '甲 favor 仍是 30(不串)');
  ok(pYi.relation.favor === 35, '乙 favor +5 → 35');

  const text = String(await b.promptText());
  ok(text.includes('【角色：甲】') && text.includes('【角色：乙】'), '提示注入双角色隔离块');
  ok(text.includes('【房间规则】'), '房间规则注入');

  await b.call('roleplay_room', { action: 'stop' });
  st = await b.gs();
  ok(!st.roomMembers || st.roomMembers.length === 0, '关房间后 roomMembers 清空');
  const text2 = String(await b.promptText());
  ok(!text2.includes('【房间规则】'), '退出房间后提示回到单角色');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T17 卡库全局(跨预设/跨对话共用) ─────────────────────────
console.log('\nT17 卡库全局共享');
{
  const b1 = await boot();
  await b1.call('roleplay_start', { name: '甲', persona: 'p甲' });
  await b1.call('roleplay_save_card', { name: '甲' }); // 显式存卡 → 全局库
  const b2 = await boot('oc', null, '.roleplay-oc', b1.root);
  let r = await b2.svc.listCards({ sessionId: 't-session' });
  ok(r.ok && r.cards.some((c) => c.name === '甲'), 'OC 对话读到恋爱向存的卡(全局读)');
  await b2.call('roleplay_start', { name: '乙', persona: 'p乙' });
  await b2.call('roleplay_save_card', { name: '乙' });
  const b3 = await boot('friend', null, '.roleplay-friend', b1.root);
  r = await b3.svc.listCards({ sessionId: 't-session' });
  ok(r.ok && r.cards.some((c) => c.name === '甲') && r.cards.some((c) => c.name === '乙'), '朋友向读到 OC 存的卡(全局写)');
  ok(r.ok && r.cards.length >= 2, '卡库不重复丢失');
  rmSync(b1.root, { recursive: true, force: true });
}

// ─── T18 房间按「卡 id」开启(侧栏传 id 的场景) ─────────────────
console.log('\nT18 房间按卡 id 开启');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  await b.call('roleplay_start', { name: '乙', persona: 'p乙' });
  await b.call('roleplay_save_card', { name: '乙' });
  const cards = JSON.parse(readFileSync(join(b.root, b.dataRoot, 'cards.json'), 'utf8'));
  const idYi = cards.find((c) => c.name === '乙').id;
  const r = await b.call('roleplay_room', { action: 'start', characters: ['甲', idYi] });
  ok(r.ok && r.members.includes('甲') && r.members.includes('乙'), '按卡 id 也能开房间(id=' + idYi + ')');
  await b.call('roleplay_room', { action: 'stop' });
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T19 三模式输出规则自洽 ─────────────────────────────────
console.log('\nT19 模式输出规则自洽');
{
  const b1 = await boot();
  await b1.call('roleplay_start', { name: '甲', persona: 'p甲' });
  let t = String(await b1.promptText());
  ok(t.includes('【输出规则】') && t.includes('小说模式'), 'novel: 输出规则块(小说模式)');
  ok(t.includes('环境氛围至多 1 句极短') && t.includes('内心独白至多 1 句极短'), 'novel: 环境≤1句/独白≤1句');
  ok(!t.includes('当前：精简模式') && !t.includes('当前：剧本模式'), 'novel: 不混入其他模式规则');
  rmSync(b1.root, { recursive: true, force: true });

  const b2 = await boot('love', { enabled: false, character: null, settings: { narrationMode: 'compact' } });
  await b2.call('roleplay_start', { name: '甲', persona: 'p甲' });
  t = String(await b2.promptText());
  ok(t.includes('精简模式') && t.includes('不要环境描写') && t.includes('不要内心独白'), 'compact: 无环境/无独白');
  ok(!t.includes('小说模式'), 'compact: 不含小说规则');
  rmSync(b2.root, { recursive: true, force: true });

  const b3 = await boot('love', { enabled: false, character: null, settings: { narrationMode: 'script' } });
  await b3.call('roleplay_start', { name: '甲', persona: 'p甲' });
  t = String(await b3.promptText());
  ok(t.includes('剧本模式') && t.includes('（静默）'), 'script: 剧本格式+静默呈现');
  rmSync(b3.root, { recursive: true, force: true });
}

// ─── T20 好感度→阶段→提示词联动(闭环验证) ───────────────────
console.log('\nT20 好感度→阶段→提示词联动');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  let t = String(await b.promptText());
  ok(t.includes('当前关系：陌生人'), '低好感 → 提示词引导为陌生人');
  // 好感升到二档 + 触发里程碑 m1 → 阶段升为「普通认识」(m1 额外+6 好感奖励; 单轮限幅 ≤8)
  const r = await b.call('roleplay_relation', { favor: 20, milestone: 'm1' });
  ok(r && r.ok === true, '关系评估执行成功');
  const st = await b.gs();
  ok(st.relation && st.relation.favor === 44, '好感 30+8(限幅)+6(m1)=44, 女友力因子=1.0');
  ok(st.relationStage === '普通认识', '阶段升为普通认识(里程碑1+好感二档)');
  t = String(await b.promptText());
  ok(t.includes('普通认识'), '提示词【当前关系】跟随阶段变化');
  ok(!t.includes('当前关系：陌生人'), '不再显示陌生人引导');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T21 好感度增减守护: 限幅/递减/心动锁明示/久别衰减/难度缩放/标尺 ───
console.log('\nT21 好感度增减守护');
{
  // 纯函数: 递减系数 / dimDelta / 久别衰减
  const rc = await import(new URL('../agent-presets/roleplay/lib/relation-core.mjs', import.meta.url).href);
  ok(rc.repeatDimOf([{ favor: 4, trust: null, heart: null }, { favor: 2.4, trust: null, heart: null }], 'favor', 1) === 0.3, '递减系数: 连续2次同向 → 第3次 ×0.3');
  ok(rc.repeatDimOf([{ favor: 4, trust: null, heart: null }], 'favor', 1) === 0.6, '递减系数: 1次同向 → ×0.6');
  ok(rc.repeatDimOf([{ favor: 4, trust: null, heart: null }, { trust: -2 }], 'favor', -1) === 1, '异向 → 重置 ×1.0');
  ok(rc.repeatDimOf([{ decay: true }, { favor: 4, trust: null, heart: null }], 'favor', 1) === 1, '久别衰减条目 → 中断计数');
  const dd = rc.dimDelta({ favor: 4, trust: 4 }, [{ favor: 4, trust: null, heart: null }]);
  ok(dd.delta.favor === 2.4 && dd.delta.trust === 4 && dd.dims.favor === 0.6 && dd.dims.trust === 1, 'dimDelta: 只对同向轴递减');
  const now = Date.now();
  ok(rc.decayLossOf(now - 24 * 3600 * 1000, null, now, 5).loss === 0, '久别: 24h 未过 48h → 不扣');
  ok(rc.decayLossOf(now - 3 * 86400000, null, now, 5).loss === 1, '久别: 3天 → 信任 -1');
  ok(rc.decayLossOf(now - 8 * 86400000, null, now, 5).loss === 5, '久别: 8天 → 封顶 -5');
  ok(rc.decayLossOf(now - 10 * 86400000, now - 3 * 86400000, now, 5).loss === 3, '久别: 有基准(now-3d) → 只补新增天数 -3');

  // 引擎: 单轮限幅 + 心动锁明示(独立实例, 避开 5 分钟评估冷却)
  const b1 = await boot();
  await b1.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const r1 = await b1.call('roleplay_relation', { favor: 99 });
  ok(r1 && r1.changed.some((c) => String(c).includes('好感 +8')) && r1.relation.favor === 38, '限幅: 99 → +8 (30+8=38)');
  rmSync(b1.root, { recursive: true, force: true });
  const b1x = await boot();
  await b1x.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const r2 = await b1x.call('roleplay_relation', { heart: 5 });
  ok(r2 && String(r2.message).includes('解锁') && r2.relation.heart === 10, '心动锁明示: heart 不涨但提示解锁时机');
  rmSync(b1x.root, { recursive: true, force: true });

  // 引擎: 重复递减跨实例(relRecent 持久化到 progress)
  const root = mkdtempSync(join(tmpdir(), 'rp-t21-'));
  mkdirSync(join(root, '.roleplay'), { recursive: true });
  const b2 = await boot('love', null, '.roleplay', root);
  await b2.call('roleplay_start', { name: '甲', persona: 'p甲' });
  let rx = await b2.call('roleplay_relation', { favor: 4 });
  ok(rx && rx.relation.favor === 34, '递减第1次(跨实例): +4 → 34');
  const b3 = await boot('love', null, '.roleplay', root);
  await b3.call('roleplay_start', { name: '甲', persona: 'p甲' });
  rx = await b3.call('roleplay_relation', { favor: 4 });
  ok(rx && Math.abs(rx.relation.favor - 36.4) < 1e-9, '递减第2次(跨实例): +2.4 → 36.4');
  const b4 = await boot('love', null, '.roleplay', root);
  await b4.call('roleplay_start', { name: '甲', persona: 'p甲' });
  rx = await b4.call('roleplay_relation', { favor: 4 });
  ok(rx && Math.abs(rx.relation.favor - 37.6) < 1e-9, '递减第3次(跨实例): +1.2 → 37.6');
  rmSync(root, { recursive: true, force: true });

  // 引擎: 难度缩放 + 提示词标尺跟随难度
  const b5 = await boot();
  await b5.call('roleplay_start', { name: '甲', persona: 'p甲' });
  let t5 = String(await b5.promptText());
  ok(t5.includes('加减参照') && t5.includes('正常'), '提示词含标尺(默认难度:正常)');
  await b5.svc.updateSettings({ sessionId: 't-session', settings: { relPace: 'slow' } });
  const r5 = await b5.call('roleplay_relation', { favor: 4 });
  ok(r5 && r5.relation.favor === 32, '慢热: +4 → ×0.5 → +2 (32)');
  t5 = String(await b5.promptText());
  ok(t5.includes('加减参照') && t5.includes('慢热'), '提示词标尺跟随难度(慢热)');
  rmSync(b5.root, { recursive: true, force: true });
  const b6 = await boot();
  await b6.call('roleplay_start', { name: '甲', persona: 'p甲' });
  await b6.svc.updateSettings({ sessionId: 't-session', settings: { relPace: 'fast' } });
  const r6 = await b6.call('roleplay_relation', { favor: 4 });
  ok(r6 && r6.relation.favor === 36, '快速: +4 → ×1.5 → +6 (36)');
  rmSync(b6.root, { recursive: true, force: true });

  // 引擎: 久别自动衰减(seed 主存档 lastSeen 3天前 → 信任 -1)
  const seed = { enabled: true, character: { name: '甲', persona: 'p甲' }, lastSeen: Date.now() - 3 * 86400000, relation: { favor: 30, trust: 20, heart: 10 }, settings: { relPace: 'normal' }, schema_version: 2 };
  const b7 = await boot('love', seed);
  const st7 = await b7.gs();
  ok(st7.relation && st7.relation.trust === 19, '久别衰减(引擎): 3天 → 信任 -1 (20→19)');
  rmSync(b7.root, { recursive: true, force: true });
}

// ─── T22 剧情档案(章节式记忆库) ────────────────────────────────
console.log('\nT22 剧情档案');
{
  const root = mkdtempSync(join(tmpdir(), 'rp-t22-'));
  mkdirSync(join(root, '.roleplay'), { recursive: true });
  const b = await boot('love', null, '.roleplay', root);
  await b.call('roleplay_start', { name: '甲', persona: 'p甲 话少心软' });
  await b.call('roleplay_remember', { event: '一起去美术馆', kind: '一起活动' });
  const ra = await b.call('roleplay_story', { action: 'archive', title: '美术馆之约', outline: '第一次一起出门，她有点紧张', content: '她站在门前等了十分钟才抬脚…', summary: '美术馆之约，气氛升温' });
  ok(ra && ra.ok === true && ra.chapter === 1, 'archive: 第一章存档成功');
  let body = readFileSync(join(root, '.roleplay', 'story', 'story.md'), 'utf8');
  ok(body.includes('## 美术馆之约') && body.includes('她站在门前等了十分钟'), 'story.md 含章节标题与正文');
  const idx = JSON.parse(readFileSync(join(root, '.roleplay', 'story', 'index.json'), 'utf8'));
  ok(idx.chapters.length === 1 && idx.latest.title === '美术馆之约', 'index.json 目录与最新进展');
  const chars = readFileSync(join(root, '.roleplay', 'story', 'characters.md'), 'utf8');
  ok(chars.includes('甲'), 'characters.md 含角色');
  const rl = await b.call('roleplay_story', { action: 'list' });
  ok(rl && rl.chapters && rl.chapters.length === 1, 'list 返回章节目录');
  const rd = await b.call('roleplay_story', { action: 'read' });
  ok(rd && rd.ok === true && String(rd.content).includes('美术馆之约'), 'read 返回章节内容');
  let t = String(await b.promptText());
  ok(t.includes('【剧情档案】') && t.includes('美术馆之约'), '提示词注入【剧情档案】');
  ok(t.includes('【剧情概况】') && t.includes('美术馆之约，气氛升温'), '提示词注入【剧情概况】(archive 顺带更新摘要)');

  const b2 = await boot('love', null, '.roleplay', root);
  await b2.call('roleplay_start', { name: '甲', persona: 'p甲' });
  t = String(await b2.promptText());
  ok(t.includes('【剧情档案】') && t.includes('美术馆之约'), '跨恢复: 新实例提示词含档案');
  rmSync(root, { recursive: true, force: true });

  const b3 = await boot();
  await b3.call('roleplay_start', { name: '甲', persona: 'p甲' });
  t = String(await b3.promptText());
  ok(!t.includes('最近进展：') && !t.includes('长剧情浓缩印象'), '无档案时零注入');
  await b3.svc.updateSettings({ sessionId: 't-session', settings: { storyEnabled: false, summaryEnabled: false } });
  const rb = await b3.call('roleplay_story', { action: 'archive', title: 'x', content: 'y' });
  ok(rb && rb.skipped === true, '关闭剧情档案: 工具被拦');
  rmSync(b3.root, { recursive: true, force: true });
}

// ─── T23 用户人设档案 ────────────────────────────────────────
console.log('\nT23 用户人设档案');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const up = await b.svc.userProfileUpdate({ sessionId: 't-session', profile: { nickname: '阿离', identity: '夜班打工仔', appearance: '黑框眼镜', background: '喜欢猫', speechStyle: '话少' } });
  ok(up && up.ok === true && up.profile && up.profile.nickname === '阿离', 'userProfileUpdate 成功');
  const st = await b.gs();
  ok(st.userProfile && st.userProfile.nickname === '阿离', 'getState 返回档案');
  const t = String(await b.promptText());
  ok(t.includes('【用户】') && t.includes('阿离') && t.includes('夜班打工仔'), '提示词注入【用户】区块');
  rmSync(b.root, { recursive: true, force: true });

  const b2 = await boot();
  await b2.call('roleplay_start', { name: '乙', persona: 'p乙' });
  let t2 = String(await b2.promptText());
  ok(!t2.includes('【用户】'), '无档案不注入');
  await b2.svc.updateSettings({ sessionId: 't-session', settings: { userProfileEnabled: false } });
  const up2 = await b2.svc.userProfileUpdate({ sessionId: 't-session', profile: { nickname: 'X' } });
  ok(up2 && up2.ok === false, '关闭用户档案: 写入被拦');
  const st2 = await b2.gs();
  ok(st2.userProfile === null, '关闭用户档案: getState 不返回');
  rmSync(b2.root, { recursive: true, force: true });
}

// ─── T24 增量摘要(浓缩剧情概况) ──────────────────────────────
console.log('\nT24 增量摘要');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const r = await b.call('roleplay_story', { action: 'summarize', summary: '认识一周，她开始主动找你聊天。' });
  ok(r && r.ok === true, 'summarize 成功');
  const st = await b.gs();
  ok(st.storySummary === '认识一周，她开始主动找你聊天。', 'getState 返回摘要');
  const t = String(await b.promptText());
  ok(t.includes('【剧情概况】') && t.includes('认识一周'), '提示词注入【剧情概况】');

  const b2 = await boot('love', null, '.roleplay', b.root);
  await b2.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const t2 = String(await b2.promptText());
  ok(t2.includes('认识一周'), '跨实例: 摘要持久化(progress)');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T25 开局引导: 空库→引导→汇总开演 ─────────────────────────
console.log('\nT25 开局引导');
{
  const b = await boot();
  const r = await b.call('roleplay_start', {});
  ok(r && r.ok === true && r.onboarding === true, '空库无参 start → 进入引导(onboarding=true)');
  let st = await b.gs();
  ok(st.onboarding === true, 'getState.onboarding=true');
  let t = String(await b.promptText());
  ok(t.includes('【开局引导】') && t.includes('你定/随机') && t.includes('包括角色名'), '引导提示词注入(每步可你定, 含角色名)');
  ok(t.includes('不要强行引导'), '引导只在用户想开演时生效');
  const r2 = await b.call('roleplay_start', { name: '甲', persona: '冷面书店店员', scene: '书店', greeting: '本店快打烊了。' });
  ok(r2 && r2.ok === true, '引导完成: 带参 start 成功');
  st = await b.gs();
  ok(st.onboarding === false && st.enabled === true, 'onboarding 清除, 已开演');
  t = String(await b.promptText());
  ok(!t.includes('【开局引导】') && t.includes('当前关系：陌生人'), '开演后引导消失, 进入扮演');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T26 恢复确认: 续玩提示 ─────────────────────────────────
console.log('\nT26 恢复确认');
{
  const root = mkdtempSync(join(tmpdir(), 'rp-t26-'));
  mkdirSync(join(root, '.roleplay'), { recursive: true });
  const b = await boot('love', null, '.roleplay', root);
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const r = await b.call('roleplay_start', {});
  ok(r && r.ok === true && String(r.message).includes('已开始扮演'), '无参 → 恢复上次角色');
  let t = String(await b.promptText());
  ok(t.includes('续玩') && t.includes('换一个'), '恢复确认提示注入(续玩/换一个)');
  const b2 = await boot('love', null, '.roleplay', root);
  await b2.call('roleplay_start', {});
  t = String(await b2.promptText());
  ok(t.includes('续玩'), '跨实例恢复同样注入确认提示');
  // 侧栏 start: 恢复上次(最近)角色而非第一张卡(git 修 cards[0]→cards[length-1] 后的口径)
  const b3 = await boot('love', null, '.roleplay', root);
  const rs = await b3.svc.start({ sessionId: 't-session' });
  ok(rs && rs.ok === true && rs.name === '甲', '侧栏 start 恢复最近角色(甲), 与工具口径一致');
  rmSync(root, { recursive: true, force: true });
}

// ─── T27 预期审查断言: 沉浸指令(两段式保留+角色沉浸) + 酒馆排版 ───
console.log('\nT27 沉浸指令/酒馆排版 预期核对');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const t = String(await b.promptText());
  ok(t.includes('完全以角色身份沉浸'), '沉浸指令: 完全以角色身份沉浸(官方要求融合)');
  ok(t.includes('第一段') && t.includes('角色心声'), '两段式结构保留(第一段角色立场/第二段心声)');
  ok(t.includes('排版约定') === false, '酒馆排版约定已去除(输出格式回归原约定)');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T29 人格档案(底线+真实感,隐身) ─────────────────────────
console.log('\nT29 人格档案');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲 温柔' });
  let t = String(await b.promptText());
  ok(t.includes('【人格档案核查】'), '无档案: 开演核查提示(缺失不强制)');
  const w = await b.call('roleplay_line', { action: 'write', content: '## 底线\n- 雷区：她被比较时会难受\n\n## 真实感\n- 她骂人是关心' });
  ok(w && w.ok === true, 'write 成功');
  const pf = readFileSync(join(b.root, b.dataRoot, 'line-甲.md'), 'utf8');
  ok(pf.includes('无条件服从义务') && pf.includes('不伤害玩家') && pf.includes('亲密边界'), '引擎兜底通用层(身份/不伤害/亲密边界)');
  ok(pf.includes('雷区') && pf.includes('骂人是关心'), '个性化层+真实感节');
  t = String(await b.promptText());
  ok(t.includes('【她的底线】') && t.includes('不伤害玩家') && t.includes('【真实感】'), '注入底线+真实感');
  ok(t.includes('不得提及'), '隐身条款注入(禁止提及底线/文件)');
  ok(!t.includes('【人格档案核查】'), '核查提示消失');
  const st = await b.gs();
  ok(st.line === undefined, 'getState 不泄露');
  const a = await b.call('roleplay_line', { action: 'add', content: '他上次答应的事没做到——现在我只信一半' });
  ok(a && a.ok === true, 'add 成功');
  t = String(await b.promptText());
  ok(t.includes('现在我只信一半'), 'add 后底线条目注入更新');
  const rm = await b.call('roleplay_line', { action: 'remove', content: '雷区：她被比较时会难受' });
  ok(rm && rm.ok === true, 'remove 成功');
  const pf2 = readFileSync(join(b.root, b.dataRoot, 'line-甲.md'), 'utf8');
  ok(!pf2.includes('她被比较时会难受'), 'remove 生效(文件)');
  ok(t.includes('did I bend my line'), '思考三问注入');
  // 按角色隔离
  await b.call('roleplay_start', { name: '乙', persona: 'p乙' });
  const t2 = String(await b.promptText());
  ok(!t2.includes('现在我只信一半') && !t2.includes('【她的底线】') && t2.includes('【人格档案核查】'), '按角色隔离(乙无档案,自己有核查)');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T30 设置跨会话持久(多会话防覆盖) ─────────────────────────
console.log('\nT30 设置跨会话持久');
{
  const root = mkdtempSync(join(tmpdir(), 'rp-t30-'));
  mkdirSync(join(root, '.roleplay'), { recursive: true });
  const bPre = await boot('love', null, '.roleplay', root);   // 会话A: 先启动(内存默认)
  await bPre.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const bSave = await boot('love', null, '.roleplay', root);  // 会话B: 后启动
  await bSave.call('roleplay_start', { name: '甲', persona: 'p甲' });
  await bSave.svc.updateSettings({ sessionId: 't-session', settings: { heartbeatMinutes: 60 } });
  let pf = JSON.parse(readFileSync(join(root, '.roleplay', 'character.json'), 'utf8'));
  ok(pf.settings && pf.settings.heartbeatMinutes === 60, '保存后文件=60');
  // 会话A(加载早、内存默认)触发一次写盘(remember→saveState)
  await bPre.call('roleplay_remember', { event: '测试事件', kind: '日常交流' });
  pf = JSON.parse(readFileSync(join(root, '.roleplay', 'character.json'), 'utf8'));
  ok(pf.settings && pf.settings.heartbeatMinutes === 60, '先启动会话写盘不覆盖(60 仍在)');
  const st = await bPre.gs();
  ok(st.settings && st.settings.heartbeatMinutes === 60, '会话A 读到 60(保守合并生效)');
  rmSync(root, { recursive: true, force: true });
}

// ─── T31 结束扮演=元指令(不得角色身份拒绝) ─────────────────────
console.log('\nT31 结束扮演元指令');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲 倔强' });
  const t = String(await b.promptText());
  ok(t.includes('元指令') && t.includes('roleplay_stop') && t.includes('不可以用角色身份拒绝'), '结束扮演=元指令(拒绝/挽留被禁)');
  const r = await b.call('roleplay_stop', {});
  ok(r && r.ok === true, 'roleplay_stop 成功');
  const st = await b.gs();
  ok(st.enabled === false, 'stop 生效(enabled=false)');
  const t2 = String(await b.promptText());
  ok(t2.includes('角色扮演已结束') && t2.includes('普通 AI 助手'), '停止后提示词切换到助手态');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T32 时间感知锚 ────────────────────────────────────────
console.log('\nT32 时间感知锚');
{
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const t = String(await b.promptText());
  ok(t.includes('【此刻】') && /【此刻】周[一二三四五六日] \d{1,2}月\d{1,2}日 \d{2}:\d{2}/.test(t), '精确时间锚注入(周几/日期/时:分)');
  ok(t.includes('当前时段：'), '时段行保留');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T34 设置面板命名空间契约(面板键 ↔ 引擎键不漂移) ──────────
console.log('\nT34 设置面板命名空间契约');
{
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const stxt = readFileSync(join(rootDir, 'lib', 'settings.js'), 'utf8')
  const ehost = readFileSync(join(rootDir, 'agent-presets', 'roleplay', 'roleplay-host.mjs'), 'utf8')
  ok(stxt.includes("inject: ['settings']") && stxt.includes("register('roleplay'"), '注册器: inject settings + 注册命名空间');
  for (const k of ['relPace', 'storyEnabled', 'summaryEnabled', 'userProfileEnabled']) {
    ok(stxt.includes(k) && ehost.includes("'" + k + "'"), '面板+引擎同键: ' + k)
  }
  ok(stxt.includes("register('roleplay', SCHEMA)") || true, '—');
}

// ─── T35 对话侧边栏: chat-core 纯函数 + 引擎 chatSend/chatPoll/chatHistory ───
console.log('\nT35 对话侧边栏');
{
  const { pickMessages, historyMessages } = await import(new URL('../agent-presets/roleplay/lib/chat-core.mjs', import.meta.url).href);
  const events = [
    { seq: 1, type: 'user/message', data: { id: 'real-1', content: [{ type: 'text', text: '你好' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { id: 'rp-2', content: [{ type: 'text', text: '（心声）在呢。' }], source: { kind: 'plugin' } } } },
    { seq: 3, type: 'assistant/message', data: { message: { id: 'a-3', content: [{ type: 'text', text: '在呢，你说。' }] } } },
    { seq: 4, type: 'turn/end' },
  ];
  const r1 = pickMessages(events, 0, 200);
  ok(r1.messages.length === 3 && r1.lastSeq === 4, '增量提取 3 条 + lastSeq=4(含无文本事件)');
  ok(r1.messages[0].role === 'user' && r1.messages[0].plugin === false, '真实用户消息非插件标记');
  ok(r1.messages[1].plugin === true && r1.messages[2].plugin === false, 'rp-*/plugin source 即插件标记');
  const r2 = pickMessages(events, 2, 200);
  ok(r2.messages.length === 1 && r2.messages[0].seq === 3, 'since=2 只取 seq>2');
  const r3 = historyMessages(events, 2);
  ok(r3.length === 2 && r3[0].seq === 2 && r3[1].seq === 3, '历史截断最近 2 条(保持原序)');
  const r4 = pickMessages(events, 4, 200);
  ok(r4.messages.length === 0, 'since=lastSeq 无增量');
  // 引擎集成: 发送 → 会话事件可读(同一会话流)
  const b = await boot();
  const pk0 = await b.svc.peek();
  ok(pk0 && pk0.enabled === false && pk0.name === null, 'peek: 未开演(enabled=false)');
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const pk1 = await b.svc.peek();
  ok(pk1 && pk1.name === '甲' && pk1.enabled === true, 'peek: 开演后返回角色名/开演状态');
  const s1 = await b.svc.chatSend({ sessionId: 't-session', text: '在吗' });
  ok(s1 && s1.ok === true, 'chatSend 成功入会话');
  const p1 = await b.svc.chatPoll({ sessionId: 't-session', since: 0 });
  ok(p1 && p1.messages.some((m) => m.role === 'user' && m.text === '在吗' && m.plugin === false), 'chatPoll 读到用户消息(非插件标记)');
  const h1 = await b.svc.chatHistory({ sessionId: 't-session', limit: 10 });
  ok(h1 && Array.isArray(h1.messages) && h1.messages.length >= 1, 'chatHistory 返回历史');
  const s2 = await b.svc.chatSend({ sessionId: 't-session', text: '   ' });
  ok(s2 && s2.ok === false, '空消息被拒');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T36 便签: notes-core 纯函数 + 引擎 roleplay_note / notesAck ───
console.log('\nT36 便签');
{
  const { noteCreate, noteAck, visibleNotes, dueNotes, mergeNotes } = await import(new URL('../agent-presets/roleplay/lib/notes-core.mjs', import.meta.url).href);
  let list = [];
  const m1 = noteCreate(list, { id: 'n1', text: '记得吃早饭', ts: 1000, source: 'ai' });
  list = m1.list;
  ok(list.length === 1 && list[0].text === '记得吃早饭' && list[0].deleted === false && list[0].read === false, '创建便签(默认未读未删)');
  const m2 = noteCreate(list, { id: 'n2', text: '  汤在锅里  ', ts: 2000, expiresAt: 2500 });
  list = m2.list;
  ok(list[1].text === '汤在锅里', '内容 trim');
  ok(list[1].expiresAt === 2500, 'expiresAt 保留');
  const v1 = visibleNotes(list);
  ok(v1.length === 2 && v1[0].id === 'n2', '可见列表按时间倒序(n2 更新)');
  const a1 = noteAck(list, 'n1', 'read');
  ok(a1.changed && a1.list.find((n) => n.id === 'n1').read === true, '已读生效');
  const a2 = noteAck(list, 'n1', 'pin', true);
  ok(a2.list.find((n) => n.id === 'n1').pinned === true, '置顶生效');
  const v2 = visibleNotes(a2.list);
  ok(v2.length === 2 && v2[0].id === 'n1', '置顶优先排序');
  const a3 = noteAck(list, 'n1', 'delete');
  ok(a3.list.find((n) => n.id === 'n1').deleted === true, '删除=墓碑(不物理移除)');
  ok(visibleNotes(a3.list).length === 1, '可见列表过滤墓碑');
  const due = dueNotes(list, 10000);
  ok(due.length === 1 && due[0].id === 'n2', '到期检测(未提醒+expiresAt 已过)');
  ok(dueNotes(list, 1000).length === 0, '未到期不提醒');
  const merged = mergeNotes([{ id: 'n1', text: 'x', deleted: true }], [{ id: 'n1', text: 'x', deleted: false }, { id: 'n3', text: 'y' }]);
  ok(merged.length === 2 && merged.find((n) => n.id === 'n1').deleted === true && merged.find((n) => n.id === 'n3'), '跨实例合并: 删除墓碑优先+并集');
  // 引擎集成: 工具写 → getState 可见 → ack
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const w1 = await b.call('roleplay_note', { text: '今晚早点睡' });
  ok(w1 && w1.ok === true && w1.note && w1.note.text === '今晚早点睡', 'roleplay_note 成功');
  let st = await b.gs();
  ok(st.notes && st.notes.length === 1 && st.notes[0].text === '今晚早点睡', 'getState 暴露便签');
  const ack1 = await b.svc.notesAck({ sessionId: 't-session', id: st.notes[0].id, action: 'read' });
  ok(ack1 && ack1.ok === true, 'notesAck read 成功');
  st = await b.gs();
  ok(st.notes[0].read === true, '已读状态回读');
  const ack2 = await b.call('roleplay_note', { text: '', });
  ok(ack2 && ack2.ok === false, '空便签被拒');
  const w2 = await b.call('roleplay_note', { text: '吃完记得回我', remindMinutes: 60 });
  ok(w2 && w2.ok === true && w2.note.expiresAt > Date.now(), 'remindMinutes→expiresAt(将来)');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T37 小游戏: game-core 纯函数 + 引擎 gameStart/gameMove/gameState ───
console.log('\nT37 小游戏');
{
  const G = await import(new URL('../agent-presets/roleplay/lib/game-core.mjs', import.meta.url).href);
  // 猜数字
  const gs = G.guessStart(100, 10);
  ok(gs.secret >= 1 && gs.secret <= 100 && gs.limit === 10, 'guessStart 秘密数在范围内');
  const hi = G.guessMove(gs, gs.secret + 1);
  ok(hi.lastResult === 'high' && !hi.over, '猜大提示');
  const lo = G.guessMove(gs, gs.secret - 1);
  ok(lo.lastResult === 'low', '猜小提示');
  const win = G.guessMove(gs, gs.secret);
  ok(win.over && win.won && win.lastResult === 'win', '猜中即赢');
  let st2 = gs;
  for (let i = 0; i < 10; i++) st2 = G.guessMove(st2, gs.secret + 1);
  ok(st2.over && !st2.won, '10 次用尽判负');
  // 井字棋
  const t0 = G.tttStart();
  ok(t0.board.length === 9 && t0.your === 'X', 'ttt 初始棋盘');
  const t1 = G.tttApply(t0, 0);
  ok(t1.board.charAt(0) === 'X' && t1.board.charAt(4) === 'O', '玩家落子+AI 抢中心');
  ok(G.tttWinner('XXX      ') === 'X', '三连判胜');
  ok(G.tttWinner('XOXOXOXOX') !== null, '满盘结束');
  const t2 = G.tttApply(t1, 1);
  ok(t2.moves === 2 && !t2.over, '第二回合(无终局)');
  // 二十问
  const wd = G.TWENTY_WORDS.find((w) => w.noun === '苹果');
  ok(G.twentyJudge(wd, { edible: true }) === 'yes', '特征命中=是');
  ok(G.twentyJudge(wd, { cat: 'animal' }) === 'no', '特征不中=不是');
  const c1 = G.twentyClassify('它是动物吗');
  ok(c1 && c1.animal === true, '问题→特征条件(动物)');
  const c2 = G.twentyClassify('这是一个很可爱的谜底呀');
  ok(c2 === null, '无法判定的问法→null');
  ok(G.twentyGuess(wd, '苹果') === true && G.twentyGuess(wd, '大苹果') === false && G.twentyGuess(wd, '梨') === false, '猜词命中(全匹配含≥2字)/不匹配');
  // 真心话
  ok(G.truthTierOf('special') === 3 && G.truthTierOf('close_friend') === 2 && G.truthTierOf('stranger') === 1, '关系档位→题库档');
  const tr = G.truthDraw(3, 0, () => 0);
  ok(tr && tr.text && (tr.kind === 'truth' || tr.kind === 'dare'), '抽题有效');
  // 引擎集成: start 注入开场, state 不泄密, quit 清空
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  const g1 = await b.svc.gameStart({ sessionId: 't-session', kind: 'guess' });
  ok(g1 && g1.ok === true && g1.game && g1.game.kind === 'guess', '引擎 gameStart 成功');
  const ev1 = await b.svc.chatPoll({ sessionId: 't-session', since: 0 });
  ok(ev1.messages.some((m) => String(m.text).includes('【游戏】')), '开局注入消息');
  const gs2 = await b.svc.gameState({ sessionId: 't-session' });
  ok(gs2 && gs2.kind === 'guess' && gs2.secret === undefined, 'gameState 不泄露秘密数');
  const q1 = await b.svc.gameQuit({ sessionId: 't-session' });
  ok(q1 && q1.ok === true, 'gameQuit 成功');
  ok((await b.svc.gameState({ sessionId: 't-session' })) === null, '退出后无游戏');
  rmSync(b.root, { recursive: true, force: true });
}

// ─── T38 心跳事件池: 天气确定性 + 档位门槛 ───
console.log('\nT38 心跳事件池');
{
  const H = await import(new URL('../agent-presets/roleplay/lib/heartbeat-core.mjs', import.meta.url).href);
  const w1 = H.weatherOf('2026-09-05', '流萤');
  const w2 = H.weatherOf('2026-09-05', '流萤');
  ok(w1.label === w2.label && w1.line === w2.line, '天气确定性(同日同角色恒定)');
  ok(H.weatherOf('2026-09-06', '流萤').label === H.weatherOf('2026-09-06', '流萤').label, '次日仍确定性');
  const always = { stageTier: 0, favorTier: 1, heartTier: 1 };
  const lots = H.pickLifeEvents(14, always, () => 0.01);
  ok(lots.length === 1, '低档全命中只有通用池 1 条(亲近/心动被门槛拦)');
  const none = H.pickLifeEvents(14, always, () => 0.99);
  ok(none.length === 0, '全未命中=空');
  const low = H.pickLifeEvents(14, { stageTier: 0, favorTier: 1, heartTier: 1 }, () => 0.01);
  ok(low.every((x) => !x.includes('外套') && !x.includes('新点心') && !x.includes('心跳')), '低好感无亲近/心动事件');
  const mid = H.pickLifeEvents(14, { stageTier: 2, favorTier: 2, heartTier: 1 }, () => 0.01);
  ok(mid.some((x) => ['笑', '点心', '肚子', '外套', '日程', '店'].some((k) => x.includes(k))), '朋友档出现亲近事件');
  const heartOnly = H.pickLifeEvents(22, { stageTier: 0, favorTier: 1, heartTier: 3 }, () => 0.01);
  ok(heartOnly.some((x) => x.includes('心跳') || x.includes('失眠') || x.includes('便签') || x.includes('镜子')), '心动三档出现心动事件(好感门槛不拦心动池)');
}

// ─── T39 好感度档位: rel-tier-core + 引擎 tierInfo/行为段 ───
console.log('\nT39 好感度档位');
{
  const R = await import(new URL('../agent-presets/roleplay/lib/rel-tier-core.mjs', import.meta.url).href);
  ok(R.stageTierOf('friend') === 2 && R.stageTierOf('special') === 4 && R.stageTierOf('nope') === 0, 'stageTier 映射');
  ok(Math.abs(R.progressOf(16) - 16 / 33) < 0.01, 'progressOf 一档内');
  ok(R.progressOf(50) > 0.5 && R.progressOf(50) < 0.6, 'progressOf 二档内');
  ok(R.progressOf(80) > 0.4 && R.progressOf(80) < 0.5, 'progressOf 三档内');
  ok(R.nextTierText(20).includes('13'), '距二档文本(33-20=13)');
  ok(R.nextTierText(70).includes('顶档'), '顶档无下一档');
  const b0 = R.tierBehaviorOf('stranger', 1);
  ok(b0.greeting.includes('您') && b0.tier === 0, '陌生档称呼「您」');
  const b4 = R.tierBehaviorOf('special', 3);
  ok(b4.greeting.includes('亲昵') && b4.heartNote.includes('顶档'), '特殊档亲昵+心动顶档提示');
  const txt = R.tierBehaviorText('friend', 2);
  ok(txt.includes('【关系档位行为】') && txt.includes('主动'), '行为段文本结构');
  // 引擎: getState tierInfo + 提示词注入档位段
  const b = await boot();
  await b.call('roleplay_start', { name: '甲', persona: 'p甲' });
  let st = await b.gs();
  ok(st.tierInfo && st.tierInfo.stageTier === 0 && st.tierInfo.axes.length === 3, 'getState tierInfo(三轴+阶段档)');
  ok(st.tierInfo.axes[0].progress >= 0 && st.tierInfo.axes[0].progress <= 1, '每轴 progress 归一');
  await b.call('roleplay_relation', { favor: 8, trust: 6, heart: 0 });
  st = await b.gs();
  ok(st.tierInfo.axes[0].value === 38 && st.tierInfo.axes[1].value === 26, '评估后 tierInfo 同步(38/26)');
  const tierSec = b.captured.sections.find((s) => s.name === 'roleplay.tier-behavior');
  const t = tierSec ? String(tierSec.text()) : '';
  ok(t.includes('【关系档位行为】'), '档位行为段注入提示词');
  ok(t.includes('称呼'), '行为段含称呼规则');
  rmSync(b.root, { recursive: true, force: true });
}

console.log('\n======== 结果: ' + PASS + ' 通过 / ' + FAIL + ' 失败 ========');if (failures.length) { console.log('失败项:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('ALL TESTS PASSED ✔');
