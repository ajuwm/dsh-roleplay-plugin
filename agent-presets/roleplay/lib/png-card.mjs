// SillyTavern 人物卡 PNG 读写(零依赖, 只用 node:zlib 与内置 Buffer)。
// ST 卡约定: PNG 块链中的 tEXt/iTXt 块, keyword='chara' 的文本是该卡的 JSON(可含 V2/V3 元数据)。
// 导出: 保留原图全部块(IDAT 不动, 图像零损失), 仅替换/新增 chara 块并重算 CRC。

import zlib from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// CRC32(表驱动, 与 PNG 规范一致)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function isPng(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return b.length > 8 && b.subarray(0, 8).equals(PNG_SIG)
}

// 遍历 PNG 块 → [{type, data, rawStart, rawLen}]
function scanChunks(b) {
  const chunks = []
  let off = 8
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off)
    const type = b.toString('ascii', off + 4, off + 8)
    const dataStart = off + 8
    if (dataStart + len + 4 > b.length) break
    chunks.push({ type, data: b.subarray(dataStart, dataStart + len), rawStart: off, rawLen: 8 + len + 4 })
    off = dataStart + len + 4
    if (type === 'IEND') break
  }
  return chunks
}

// tEXt: keyword\0text    iTXt: keyword\0compFlag\0compMethod\0lang\0transKeyword\0text(UTF-8)
function extractTextValue(data, keyword) {
  const nul = data.indexOf(0)
  if (nul < 0) return null
  const key = data.toString('latin1', 0, nul)
  if (key !== keyword) return null
  const rest = data.subarray(nul + 1)
  // 无法区分 tEXt/iTXt 时: 若有多个连续 \0 且第二个字段可解析为数字 → iTXt 结构
  const parts = []
  let p = 0
  for (let i = 0; i < 4 && p < rest.length; i++) {
    const nx = rest.indexOf(0, p)
    if (nx < 0) { parts.push(rest.subarray(p)); p = rest.length; break }
    parts.push(rest.subarray(p, nx))
    p = nx + 1
  }
  // tEXt 部分: ST 卡的 chara JSON 常为 UTF-8(中文) → 先按 UTF-8 解析(能过 JSON 就用), 回退 latin1
  if (parts.length >= 5) {
    const compFlag = parts[0].toString('latin1')
    let textBuf = parts[4]
    if (parts.length > 5) textBuf = rest.subarray(rest.length - (parts[4].length + parts[5].length))
    try {
      if (compFlag === '1') return zlib.inflateSync(textBuf).toString('utf8')
      return textBuf.toString('utf8')
    } catch (e) { return null }
  }
  try {
    const u = parts[0].toString('utf8')
    JSON.parse(u)
    return u
  } catch (e) {
    try { return parts[0].toString('latin1') } catch (e2) { return null }
  }
}

export function readCardFromPng(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (!isPng(b)) throw new Error('不是有效的 PNG 文件。')
  const chunks = scanChunks(b)
  for (const c of chunks) {
    if (c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') {
      const val = extractTextValue(c.data, 'chara')
      if (val) {
        try {
          const j = JSON.parse(val)
          if (j && typeof j === 'object') return { json: j, text: val }
        } catch (e) { /* 继续找 */ }
      }
    }
  }
  throw new Error('PNG 中没有找到 SillyTavern 角色卡数据(chara 字段)。')
}

function makeChunk(type, data) {
  const out = Buffer.alloc(4 + 4 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

// 空白占位卡图(512x512 纯白, 单 IDAT)
function placeholderPng(width = 512, height = 512) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width * 3; x += 3) {
      raw[row + 1 + x] = 245; raw[row + 2 + x] = 240; raw[row + 3 + x] = 230
    }
  }
  const idat = zlib.deflateSync(raw)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    PNG_SIG, makeChunk('IHDR', ihdr), makeChunk('IDAT', idat), makeChunk('IEND', Buffer.alloc(0)),
  ])
}

// 导出: basePng 为原卡 PNG(保留原图); 无原图时生成占位图
export function writeCardToPng(json, basePng) {
  const payload = Buffer.from(JSON.stringify(json), 'utf8')
  const hasBase = basePng && basePng.length > 8 && isPng(basePng)
  if (hasBase) {
    const b = Buffer.isBuffer(basePng) ? basePng : Buffer.from(basePng)
    const chunks = scanChunks(b)
    if (!chunks.length) return writeCardToPng(json, null)
    const out = [b.subarray(0, 8)]
    let inserted = false
    for (const c of chunks) {
      if (c.type === 'tEXt' || c.type === 'iTXt') {
        // 跳过旧 chara 块(后面统一插入)
        const nul = c.data.indexOf(0)
        const key = nul >= 0 ? c.data.toString('latin1', 0, nul) : ''
        if (key === 'chara') continue
      }
      out.push(b.subarray(c.rawStart, c.rawStart + c.rawLen))
      if (!inserted && c.type === 'IDAT') {
        out.push(makeChunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), payload])))
        inserted = true
      }
    }
    if (!inserted) {
      // IDAT 前没有插入成功(无 IDAT), 追加到 IEND 前
      const iend = out.findIndex((x) => x.toString('ascii', 4, 8) === 'IEND')
      const c = makeChunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), payload]))
      if (iend >= 0) out.splice(iend, 0, c)
      else out.push(c)
    }
    return Buffer.concat(out.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))))
  }
  const base = placeholderPng()
  const chunks = scanChunks(base)
  const out = [base.subarray(0, 8)]
  for (const c of chunks) {
    out.push(base.subarray(c.rawStart, c.rawStart + c.rawLen))
    if (c.type === 'IDAT') out.push(makeChunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), payload])))
  }
  return Buffer.concat(out)
}
