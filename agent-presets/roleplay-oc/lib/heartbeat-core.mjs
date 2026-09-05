// roleplay 心跳事件池核心(纯函数,无状态、无 ctx)——供 roleplay-host 心跳引擎使用。
// 设计: 心跳 = 保底段(时段/状态/想念等, 引擎侧保留) + 采样段(本模块: 天气 + 生活事件),
// 按关系档位推进内容: 通用琐事 → 亲近小念头 → 心动事件。

function hashCode(s) {
  let h = 0
  for (let i = 0; i < String(s).length; i++) {
    h = (h * 31 + String(s).charCodeAt(i)) | 0
  }
  return h >>> 0
}

// 确定性天气: 同一天(dayKey)+ 同一角色 → 恒定; 晴天不打扰(不产出行)
export function weatherOf(dayKey, salt) {
  const r = hashCode(String(dayKey) + '|' + String(salt || '')) % 100
  if (r < 32) return { label: '晴', line: null }
  if (r < 58) return { label: '多云', line: '今天云很多，天空灰白灰白的。' }
  if (r < 82) return { label: '小雨', line: '下着小雨，窗外雨声让人有点懒。' }
  return { label: '起风', line: '起风了，出门记得多穿一点。' }
}

// 生活小事件池(按档位加权采样, 每心跳最多 2 条):
// tier = { stageTier: 0..4(陌生0…特殊4), favorTier: 1..3, heartTier: 1..3 }
// 返回字符串数组(角色第一人称"她今天做了什么", 供心跳提示词使用)。
export function pickLifeEvents(hour, tier, rnd) {
  const t = tier || { stageTier: 0, favorTier: 1, heartTier: 1 }
  const r = (n) => (rnd || Math.random)() * n
  const out = []
  // 通用生活琐事(0.45)
  if (r(1) < 0.45) {
    const pool = [
      '你在追一部剧，看到好笑的地方自己笑出了声。',
      '你在听歌，单曲循环了同一首。',
      '你泡了一杯茶，捧着它发呆了好一会儿。',
      '你给窗台上的花浇了水。',
      '你靠在窗边看了一会儿外面。',
      '你整理了一下书架，顺手把最上面那本书放回了原位。',
      '你做了顿便饭，多余的装好放进了冰箱。',
    ]
    out.push(pool[Math.floor(r(pool.length))])
  }
  // 亲近小念头(好感二档以上或朋友关系): 0.35
  if ((t.favorTier >= 2 || t.stageTier >= 2) && r(1) < 0.35) {
    const pool = [
      '你想起他说过的一句话，自己没忍住笑了。',
      '你学做了一道新点心，想下次做给他吃。',
      '你攒了一肚子话，想找机会跟他说。',
      '你看了看日程，盘算着什么时候能再见到他。',
      '你把上次他落在这的一件外套洗了，叠得整整齐齐。',
      '你偷偷研究了一下他提过的那家店，记下了地址。',
    ]
    out.push(pool[Math.floor(r(pool.length))])
  }
  // 心动时刻(心动三档): 0.4
  if (t.heartTier >= 3 && r(1) < 0.4) {
    const pool = [
      '你突然心跳快了一下——刚刚脑海里全是他。',
      '你昨晚睡得不太好，翻来覆去想着他白天看你的眼神。',
      '你想写点什么给他，又不好意思，最后写了一张便签。',
      '你对着镜子偷偷练习了一下见到他要说的话。',
    ]
    out.push(pool[Math.floor(r(pool.length))])
  }
  return out.slice(0, 2)
}
