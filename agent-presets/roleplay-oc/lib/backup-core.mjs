// roleplay 备份核心(纯函数)——供引擎(L1/L2/L3)与桥接(L4/L5)共用,可单测。
// 分层: L1 写盘前 .bak(单文件) / L2 workspace 内每日快照 / L3 启动恢复 / L4 用户级镜像 / L5 灾后回流。
// 路径拼接交给调用方; 本模块只负责命名、清单、保留策略、镜像/回流判定。

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isDateName(x) {
  return DATE_RE.test(String(x || ''))
}

// 快照保留策略: 输入日期名列表(升序), 返回 { drop: 应删除的旧日期, keep: 保留的日期 }
export function pickSnapshotDir(entries, keep = 3) {
  const sorted = (entries || []).filter(isDateName).sort()
  const n = Math.max(0, Number(keep) || 3)
  const cut = Math.max(0, sorted.length - n)
  return { drop: sorted.slice(0, cut), keep: sorted.slice(cut) }
}

// 恢复清单: 只补缺失文件, 不覆盖现存(不复活用户主动删除的内容)
export function missingOf(wanted, present) {
  const have = new Set((present || []).map((x) => String(x)))
  return (wanted || []).filter((f) => !have.has(String(f)))
}

// L4 镜像增量: workspace 有、远端还没有的日期(需要镜像)
export function needMirror(localDates, remoteDates) {
  const rs = new Set((remoteDates || []).map((x) => String(x)))
  return (localDates || []).filter(isDateName).filter((d) => !rs.has(String(d)))
}

// L5 回流失策: 数据根"有意义文件"(非 .bak)为空且镜像有 → 用最近镜像日期
export function restoreSourceOf(remoteDates, presentFiles) {
  const meaningful = (presentFiles || []).filter((f) => !String(f).endsWith('.bak'))
  if (meaningful.length > 0) return null
  const sorted = (remoteDates || []).filter(isDateName).sort()
  return sorted.length ? sorted[sorted.length - 1] : null
}
