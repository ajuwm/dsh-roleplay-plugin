// roleplay 引擎核心路径自动化测试（免框架，node 直接跑）
// 用法: node test/core.test.mjs
// 覆盖: 卡库旧/新格式兼容 · 角色切换不丢卡 · progress 隔离(亲密度) · 朋友向轴 · OC 空白 ·
//       养成/商城开关门卫 · start 恢复 · 记忆隔离
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ENGINE_URL = new URL('../agent-presets/roleplay/roleplay-host.mjs', import.meta.url).href;

let PASS = 0, FAIL = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { PASS++; console.log('  ✅ ' + name); }
  else { FAIL++; failures.push(name); console.log('  ❌ ' + name); }
}

// 一次全新引擎实例 + 独立临时数据根（reuseRoot 传入时复用同一数据根，用于跨实例断言）
async function boot(style = 'love', seedChar = null, dataRoot = '.roleplay', reuseRoot = null) {
  const root = reuseRoot || mkdtempSync(join(tmpdir(), 'rp-test-'));
  if (!reuseRoot) mkdirSync(join(root, dataRoot), { recursive: true });
  if (seedChar) writeFileSync(join(root, dataRoot, 'character.json'), JSON.stringify(seedChar));
  const captured = { tools: {}, svc: null, sections: [], events: {} };
  const fake = { id: 't-session', session: null };
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
  await b.call('roleplay_relation', { favor: 10 });
  let st = await b.gs();
  ok(st.relation && st.relation.favor === 40, '甲 favor 30→40');
  await b.call('roleplay_start', { name: '乙', persona: 'p乙' });
  st = await b.gs();
  ok(st.relation && st.relation.favor === 30, '乙 全新(30), 不继承甲');
  await b.svc.loadCard({ sessionId: 't-session', card: '甲' });
  st = await b.gs();
  ok(st.relation && st.relation.favor === 40, '切回甲 favor 仍是 40');
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

console.log('\n======== 结果: ' + PASS + ' 通过 / ' + FAIL + ' 失败 ========');
if (failures.length) { console.log('失败项:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('ALL TESTS PASSED ✔');
