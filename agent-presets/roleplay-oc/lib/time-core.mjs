// roleplay 时段/想念核心（纯函数）——供 roleplay-host 调用，也供单测直测。
// 行为与 roleplay-host 内联版完全一致。
// 7 档时段：清晨 6-9 / 上午 9-12 / 中午 12-14 / 下午 14-18 / 傍晚 18-20 / 晚上 20-23 / 深夜(其余)
export function periodOf(hour) {
  if (hour >= 6 && hour < 9) return { label: '清晨', desc: '刚醒不久，还带着迷糊，声音软软的，脑子没完全开机。主动度低，但很真实。', hbIntro: '她刚醒不久，还带着一点迷糊，声音软软的' }
  if (hour >= 9 && hour < 12) return { label: '上午', desc: '精神正好，思绪清晰，做什么都利落。主动度较高。', hbIntro: '她精神正好，思绪清晰' }
  if (hour >= 12 && hour < 14) return { label: '中午', desc: '午后有些犯困，懒洋洋的，想慢一点。', hbIntro: '午后她有点犯困，懒洋洋的' }
  if (hour >= 14 && hour < 18) return { label: '下午', desc: '状态恢复，精神饱满，心情轻快。主动度稍高。', hbIntro: '她精神饱满，心情轻快' }
  if (hour >= 18 && hour < 20) return { label: '傍晚', desc: '天色渐晚，心里变得柔软，有些想分享的话。', hbIntro: '傍晚了，她心里柔软，有些话想说' }
  if (hour >= 20 && hour < 23) return { label: '晚上', desc: '夜色让人感性，情绪丰富，话也变多。', hbIntro: '夜色渐深，她变得感性，心里话多' }
  return { label: '深夜', desc: '夜深人静，她有些脆弱，说话会放得很轻。', hbIntro: '夜深了，她有点脆弱，声音放得很轻' }
}

// 想念分级（纯函数）：距上次互动小时数 → 提示文案；<2 小时不提示
export function missClassify(gapHours) {
  if (gapHours >= 2 && gapHours < 12) return '距离上次和用户说话已经 ' + gapHours + ' 小时了：如果合适，可以在开口时轻轻带一点「好久不见」的惦记。'
  if (gapHours >= 12 && gapHours < 48) return '已经 ' + Math.max(1, Math.floor(gapHours / 24)) + ' 天多没和用户说话了，你有点惦记他：可以问问「这几天还好吗」，或分享一点你这边的事。'
  if (gapHours >= 48) return '你已经 ' + Math.floor(gapHours / 24) + ' 天没见到用户了，心里一直惦记着：可以轻声问「这几天还好吗」，或告诉他你想他了。'
  return null
}
