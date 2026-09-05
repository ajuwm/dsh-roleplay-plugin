// roleplay 好感度档位行为核心(纯函数)——供引擎系统提示注入与侧栏进度条使用。
// 档位来源: 关系阶段(陌生0→特殊4) + 心动档(1..3); 行为产出: 称呼/风格/主动度/可做小互动。

const STAGE_TIER = { stranger: 0, acquaintance: 1, friend: 2, close_friend: 3, special: 4 }
export function stageTierOf(stage) {
  return STAGE_TIER[String(stage || 'stranger')] || 0
}

// 数值在档位内的进度百分比(0..1): 档1=0-33 档2=33-66 档3=66-100
export function progressOf(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  const x = Math.max(0, Math.min(100, n))
  if (x <= 33) return (x / 33)
  if (x <= 66) return ((x - 33) / 33)
  return ((x - 66) / 34)
}
// 档位显示文案(距下一档提示): 满分档返回 null
export function nextTierText(v) {
  const n = Math.max(0, Math.min(100, Number(v) || 0))
  if (n <= 33) return '距「二档」还差 ' + Math.ceil(33 - n) + ' 分'
  if (n <= 66) return '距「三档」还差 ' + Math.ceil(66 - n) + ' 分'
  return '已是顶档 🎉'
}

// 行为表: 按阶段档位(0..4)取
const GREETING = [
  '保持礼貌的距离，称呼「您」，称呼玩家为他的称呼/名字。',
  '称呼「你」，语气客气而不生硬。',
  '称呼「你」，偶尔叫玩家的名字。',
  '称呼「你」，会亲昵地叫玩家的名字或小称呼。',
  '有专属的亲昵称呼，随时可以自然地叫出口。',
]
const STYLE = [
  '拘谨客气，句子短，不敢多说；被夸奖会不知所措。',
  '礼貌，会开小玩笑；害羞频率开始降低。',
  '自然，话变多，偶尔主动分享；被夸奖时有点高兴。',
  '黏人，会撒娇，主动找话题；被夸奖时开心但不掩藏。',
  '放松亲昵，偶尔任性；被夸奖时大大方方。',
]
const ACTIVE = [
  '只在你开口时回应，绝不主动打扰。',
  '偶尔主动问候一声。',
  '会主动分享日常小事。',
  '会主动邀约、布置小惊喜。',
  '会主动制造属于你们俩的小瞬间。',
]
const ACTS = [
  '可以做的互动：点头、轻声问好。',
  '可以做的互动：并肩同行、递东西。',
  '可以做的互动：并肩而坐、分享同一杯饮料。',
  '可以做的互动：摸摸头、把手放在你肩上。',
  '可以做的互动：牵手、靠近、撒娇、窝在一起。',
]

export function tierBehaviorOf(stage, heartTier) {
  const t = Math.max(0, Math.min(4, stageTierOf(stage)))
  const h = Number(heartTier) || 1
  const heartNote = h >= 3
    ? '心动已到顶档(三档): 你会更频繁想起他，心跳事件会自然出现——比如突然脸红、夜里想念、偷偷写便签。'
    : h >= 2
      ? '心动(二档): 你已经在意这个人，只是还没完全说出口。'
      : '心动(一档): 大多时候若无其事，偶尔有点在意。'
  return { tier: t, greeting: GREETING[t], style: STYLE[t], active: ACTIVE[t], acts: ACTS[t], heartNote, heartTier: h }
}

export function tierBehaviorText(stage, heartTier) {
  const b = tierBehaviorOf(stage, heartTier)
  return [
    '【关系档位行为】当前阶段(0-4): ' + b.tier + ' -> 称呼与语气请严格按档位表：',
    b.greeting,
    b.style,
    b.active,
    b.acts,
    b.heartNote,
    '注意：档位行为的语气应自然流露，不要照念; 档位变化时可以在台词里轻轻体现(更亲近/更黏)，不需要报数字。',
  ].join('\n')
}
