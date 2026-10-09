// ================= 文稿转字幕：要念的稿（台词稿或整篇文稿，TXT，一行一条） → 初版 SRT（导入剪映做文本朗读、对轴用；时间只是占位，剪映里按配音重调） =================
// TXT 一行就是一条字幕（空行跳过）；超过 WARN_LEN 字的只提醒，由用户自己在文稿里改
export const WARN_LEN = 30;          // 超过几个字提醒（汉字算 1，英文数字算半个）
export const CHAR_SEC = 0.25;        // 占位时长：每个字几秒（剪映里会按配音重调）
export const MIN_SEC = 1.0;          // 每条字幕最短占位秒数

export const width = (s) => [...s].reduce((n, ch) => n + (/[\x20-\x7e]/.test(ch) ? 0.5 : 1), 0);   // 字数（英文数字算半个）

// 文稿 → 字幕条 [{text, s, e}]：一行一条，按字数排占位时长（首尾相接）
export function txtToCues(text, o = {}) {
  const cs = o.charSec ?? CHAR_SEC, minS = o.minSec ?? MIN_SEC;
  const cues = [];
  let t = 0;
  for (const raw of text.replace(/^﻿/, '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const d = Math.max(minS, width(line) * cs);
    cues.push({ text: line, s: t, e: t + d });
    t += d;
  }
  return cues;
}

const ts = (x) => {                                           // 秒 → 00:00:00,000
  const ms = Math.round(x * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
export const toSRT = (cues) => cues.map((c, i) => `${i + 1}\r\n${ts(c.s)} --> ${ts(c.e)}\r\n${c.text}\r\n`).join('\r\n');   // 和剪映导出的一样用 CRLF
