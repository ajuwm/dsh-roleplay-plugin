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

// 一次全新引擎实例 + 独立临时数据根
async function boot(style = 'love', seedChar = null, dataRoot = '.roleplay') {
  const root = mkdtempSync(join(tmpdir(), 'rp-test-'));
  mkdirSync(join(root, dataRoot), { recursive: true });
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
  return { root, dataRoot, tool, call, svc, gs, captured };
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

console.log('\n======== 结果: ' + PASS + ' 通过 / ' + FAIL + ' 失败 ========');
if (failures.length) { console.log('失败项:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('ALL TESTS PASSED ✔');
