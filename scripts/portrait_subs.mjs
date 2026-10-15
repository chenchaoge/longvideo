// ================= 竖版烧字幕：SRT → ASS（render.mjs 出片、配音字幕预览用） =================
// 竖版字幕标准（2026-10-14 按抖音界面实测定，见 references/视频动画出片格式标准.md）：一个字 58 像素宽；一行容许宽 720（x 180～900），居中；
// 最下一行字的下沿 y 1520，多出来的行往上长；行距 60（上一行字顶到下一行字顶）
// libass 自动折行时行距固定是字号行高（一个字 58 宽时是 84），调不了，所以这里按字体里每个字的实际宽度自己折行，每行单独一条字幕、从下往上摆
// 字幕里本来就有的换行（用户在剪映里手动换的）照断，每行超过一行宽再折
import fs from 'node:fs';

const W = 1080, H = 1920;                                     // ASS 画布按竖版母版写，出小画面预览时 libass 自动等比缩放
const SIZE = 84;                                              // ASS 字号（libass 按字体的 win 行高定字号）：思源黑体 84 = 一个字 58 像素宽
const LEFT = 180, RIGHT = 900;                                // 一行容许的左右边界
const BOTTOM = 1520;                                          // 最下一行字的下沿
const LINE = 60;                                              // 行距
const INK_BELOW = 13;                                         // 字号 84 时字的下沿比 libass 的字框底高 13 像素（实测），定位时要扣掉
const OUTLINE = 6.5;                                          // 黑边粗细：和横版同比例（横版字号 80、黑边约 6.2）
const NO_HEAD = '，。、！？；：）》」』】”’…—,.!?;:)%';            // 不放行首的标点

// 读 TTF：返回 字 → 像素宽（按 SIZE 字号）；只认 cmap format 12（思源黑体有）
function loadFont(file) {
  const b = fs.readFileSync(file), tab = {};
  for (let i = 0; i < b.readUInt16BE(4); i++) { const o = 12 + 16 * i; tab[b.toString('latin1', o, o + 4)] = b.readUInt32BE(o + 8); }
  const upem = b.readUInt16BE(tab.head + 18), nh = b.readUInt16BE(tab.hhea + 34);
  const em = SIZE * upem / (b.readUInt16BE(tab['OS/2'] + 74) + b.readUInt16BE(tab['OS/2'] + 76));   // 一个 em 多少像素：字号 / (usWinAscent + usWinDescent)
  let g12 = null;
  for (let i = 0; i < b.readUInt16BE(tab.cmap + 2) && g12 === null; i++) {
    const off = tab.cmap + b.readUInt32BE(tab.cmap + 8 + 8 * i);
    if (b.readUInt16BE(off) === 12) g12 = off;
  }
  if (g12 === null) throw new Error(`字体里没有 format 12 的字符表：${file}`);
  const ng = b.readUInt32BE(g12 + 12);
  const glyph = (u) => {                                      // 字符 → 字形号（分组按编码从小到大排）；字体里没有的字返回 0
    for (let j = 0; j < ng; j++) {
      const p = g12 + 16 + 12 * j, s = b.readUInt32BE(p);
      if (u < s) return 0;
      if (u <= b.readUInt32BE(p + 4)) return b.readUInt32BE(p + 8) + u - s;
    }
    return 0;
  };
  const cache = new Map();
  return (ch) => {
    if (!cache.has(ch)) cache.set(ch, b.readUInt16BE(tab.hmtx + 4 * Math.min(glyph(ch.codePointAt(0)), nh - 1)) / upem * em);
    return cache.get(ch);
  };
}

// 按像素宽折行：英文单词、数字连着不拆（比一整行还长才拆），折行处的空格丢掉，标点不放行首（把上一行最后一个字一起带下来）
function wrap(text, wOf) {
  const max = RIGHT - LEFT;
  const wid = (ts) => ts.reduce((n, t) => n + [...t].reduce((m, ch) => m + wOf(ch), 0), 0);
  const toks = (text.match(/[\x21-\x7e]+|\s+|./gu) || []).flatMap(t => wid([t]) > max ? [...t] : [t]);
  const lines = [[]];
  for (const t of toks) {
    let cur = lines.at(-1);
    if (cur.length && wid([...cur, t]) > max) {
      if (/^\s+$/.test(t)) continue;
      const next = NO_HEAD.includes(t[0]) && cur.length > 1 ? [cur.pop()] : [];
      lines.push(next);
      cur = next;
    }
    cur.push(t);
  }
  return lines.map(l => l.join('').trim()).filter(Boolean);
}

const toSec = (x) => { const m = x.match(/(\d+):(\d+):(\d+)[,.](\d+)/); return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 10 ** m[4].length; };
const assTime = (x) => {                                      // 秒 → 0:00:00.00
  const cs = Math.round(x * 100), h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assText = (s) => s.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝');   // ASS 里 \ { } 是控制符，换成全角

function parseSrt(txt) {                                      // SRT → [{s, e, lines}]；一条里的几行分开留着（是用户手动换的行）
  const out = [];
  for (const blk of txt.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const ls = blk.split('\n'), k = ls.findIndex(l => l.includes('-->'));
    if (k < 0) continue;
    const [s, e] = ls[k].split('-->').map(toSec);
    const lines = ls.slice(k + 1).map(l => l.trim()).filter(Boolean);
    if (lines.length) out.push({ s, e, lines });
  }
  return out;
}

// SRT 文本 → ASS 文本；fontFile 是烧字幕用的同一个字体文件（量字宽用）
export function srtToPortraitAss(srt, fontFile) {
  const wOf = loadFont(fontFile);
  const mv = H - BOTTOM - INK_BELOW;                            // 最下一行的 MarginV（字框底离画面底）
  const head = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: S,Noto Sans SC,${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${OUTLINE},0,2,${LEFT},${W - RIGHT},${mv},1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const ev = [];
  for (const c of parseSrt(srt)) {
    const ls = c.lines.flatMap(l => wrap(l, wOf));            // 手动换行处照断，每行再按字宽折
    // 每行放不同的层：同一层里同时出现的字幕 libass 会自动推开防重叠，行距就不是 60 了
    ls.forEach((l, i) => ev.push(`Dialogue: ${i},${assTime(c.s)},${assTime(c.e)},S,,0,0,${mv + (ls.length - 1 - i) * LINE},,${assText(l)}`));
  }
  return [...head, ...ev].join('\n') + '\n';
}
