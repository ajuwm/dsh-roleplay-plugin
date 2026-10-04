// 角色扮演「开关」存储适配层 —— 0.1.1 / 0.2.0 双版本共用。
//
// 0.1.1：DSH 设置服务是「命名空间」模型 —— settings.register(ns, schema) 注册，
//        settings.get(ns) 读，settings.update(ns, patch) 写；设置面板自动出现卡片。
// 0.2.0：整套换成 Config 派生表单（SettingsForms）—— 没有 register、没有 get，
//        只有 update / replace / describe / write，且第三方插件没有自动卡片。
//        于是本插件自带设置面板，值落盘到 $DSH_HOME/.roleplay-switches.json。
//
// 分流靠能力探测而不是版本号：设置服务上有 get() 就是命名空间那套。
// 什么都读不到时回落到默认值（默认全开 = 行为与升级前一致）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const NS = 'roleplay'

// 全量默认值（与 lib/settings.js 的 schema 同步维护，两边都要改）
export const SWITCH_DEFAULTS = {
  // ── 稳定版开关 ──
  enabled: true,
  stableMode: false,
  heartbeatEnabled: true,
  deskpetEnabled: true,
  notesEnabled: true,
  gameEnabled: true,
  loreEnabled: true,
  stImportEnabled: true,
  backupEnabled: true,
  desktopLookEnabled: true,
  // ── 原有偏好 ──
  heartbeatMinutes: 30,
  narrationMode: 'novel',
  difficulty: 2,
  statsEnabled: true,
  relationEnabled: true,
  relPace: 'normal',
  autoLook: false,
  shotMaxW: 0,
  storyEnabled: true,
  summaryEnabled: true,
  userProfileEnabled: true,
}

const KNOWN = new Set(Object.keys(SWITCH_DEFAULTS))

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function switchFile() {
  return process.env.DSH_ROLEPLAY_SWITCHES || path.join(dshHome(), '.roleplay-switches.json')
}

function settingsSvc(ctx) {
  try {
    const s = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    return s === undefined || s === null ? null : s
  } catch (e) { return null }
}

function legacyValues(ctx) {
  const s = settingsSvc(ctx)
  if (s === null || typeof s.get !== 'function') return null
  try {
    const v = s.get(NS)
    return v && typeof v === 'object' ? v : null
  } catch (e) { return null }
}

// 一次性搬运：0.1.1 把命名空间值写进 settings.yaml；0.2.0 把该文件改名为
// settings.yaml.imported 之后并不认 roleplay 段（没有同名插件行）。
// 首次落地时从那里把值捞回来，用户既有偏好不会因为升级而丢。
function legacyDocumentValues() {
  for (const name of ['settings.yaml', 'settings.yaml.imported']) {
    let text
    try { text = fs.readFileSync(path.join(dshHome(), name), 'utf8') } catch (e) { continue }
    const lines = text.split(/\r?\n/)
    let inside = false
    const out = {}
    for (const line of lines) {
      if (line.length === 0) continue
      if (line.charAt(0) !== ' ' && line.charAt(0) !== '\t') {
        inside = line.indexOf(NS + ':') === 0
        continue
      }
      if (!inside) continue
      const m = /^[ \t]+([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(line)
      if (m === null || !KNOWN.has(m[1])) continue
      const raw = m[2].trim().replace(/^['\"]|['\"]$/g, '')
      if (raw === '') continue
      if (raw === 'true') out[m[1]] = true
      else if (raw === 'false') out[m[1]] = false
      else if (!Number.isNaN(Number(raw))) out[m[1]] = Number(raw)
      else out[m[1]] = raw
    }
    if (Object.keys(out).length > 0) return out
  }
  return null
}

let cache = { path: '', mtime: -1, at: 0, value: null }

function fileValues() {
  const file = switchFile()
  const now = Date.now()
  if (cache.path === file && now - cache.at < 1000) return cache.value
  let value = null
  let mtime = -1
  try {
    const st = fs.statSync(file)
    mtime = st.mtimeMs
    if (cache.path === file && cache.mtime === mtime) {
      cache.at = now
      return cache.value
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed
  } catch (e) { value = null }
  cache = { path: file, mtime: mtime, at: now, value: value }
  return value
}

function mergeFile(patch) {
  const file = switchFile()
  const cur = fileValues() || {}
  const next = Object.assign({}, cur, patch)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  cache = { path: file, mtime: -1, at: 0, value: null }
  return next
}

// 读全量开关（默认值打底 + 用户值覆盖）。任何异常都不抛，最差返回默认值。
// ⚠️ 只读：绝不写盘。落盘只发生在 writeSwitches / ensureSwitchStore 里 ——
//    否则任何一次读（含单测里挂载预设宿主）都可能往用户 home 里写文件。
export function readSwitches(ctx) {
  const legacy = legacyValues(ctx)
  if (legacy !== null) return Object.assign({}, SWITCH_DEFAULTS, legacy)
  const file = fileValues()
  if (file !== null) return Object.assign({}, SWITCH_DEFAULTS, file)
  const migrated = legacyDocumentValues()
  if (migrated !== null) return Object.assign({}, SWITCH_DEFAULTS, migrated)
  return Object.assign({}, SWITCH_DEFAULTS)
}

// 显式迁移（只在宿主半边 apply 时调一次）：把旧设置文档里的 roleplay 段
// 落到本地 JSON，此后读的就是文件。读路径本身永远不写盘。
export function ensureSwitchStore(ctx) {
  try {
    const legacy = legacyValues(ctx)
    if (legacy !== null) return false          // 0.1.1：命名空间才是权威，不落文件
    if (fileValues() !== null) return false    // 已有文件：不覆盖
    const migrated = legacyDocumentValues()
    if (migrated === null) return false
    mergeFile(migrated)
    return true
  } catch (e) { return false }
}

// 写开关：0.1.1 走命名空间 update；0.2.0 合并进 JSON 文件。返回写入后的全量值。
export async function writeSwitches(ctx, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings 必须是一个对象。')
  const s = settingsSvc(ctx)
  if (s !== null && typeof s.get === 'function' && typeof s.update === 'function') {
    await s.update(NS, patch)
    return readSwitches(ctx)
  }
  mergeFile(patch)
  return readSwitches(ctx)
}
