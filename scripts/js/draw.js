'use strict';
// ================= 绘图底层工具：字体 / 颜色换算 / 文字排版绘制 / 圆角路径 =================
// 不带任何样式预设：颜色、字重、描边、阴影、逐字动画都要调用时自己给

function setFont(g, size, weight = 500, fam = F.zh) { g.font = `${weight} ${size}px ${fam}`; }
// #rrggbb → rgba
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }

// ---------- 富文本标记：{..} 为第 1 种强调，[..] 为第 2 种强调（颜色由 txt 的 hl、hl2 指定） ----------
function parseRich(str) {
  const segs = []; let k = 0, buf = '';
  for (const ch of str) {
    if (ch === '{' || ch === '[') { if (buf) segs.push({ s: buf, k }); buf = ''; k = ch === '{' ? 1 : 2; }
    else if (ch === '}' || ch === ']') { if (buf) segs.push({ s: buf, k }); buf = ''; k = 0; }
    else buf += ch;
  }
  if (buf) segs.push({ s: buf, k });
  return segs;
}

// 排版：按 \n 分行，算出每个字的位置和宽度（结果缓存）
const _lay = new Map();
function layout(g, str, size, weight, fam, ls) {
  const key = `${str}|${size}|${weight}|${fam}|${ls}`;
  let L = _lay.get(key);
  if (L) return L;
  setFont(g, size, weight, fam);
  const lines = str.split('\n').map(line => {
    const chars = [], kinds = [];
    for (const s of parseRich(line)) for (const ch of s.s) { chars.push(ch); kinds.push(s.k); }
    const gl = []; let acc = '', prevW = 0;
    for (let i = 0; i < chars.length; i++) {
      acc += chars[i];
      const wAll = g.measureText(acc).width;          // 用前缀宽度保留字距
      gl.push({ ch: chars[i], x: prevW + i * ls, w: wAll - prevW, k: kinds[i] });
      prevW = wAll;
    }
    return { gl, w: prevW + Math.max(0, chars.length - 1) * ls };
  });
  L = { lines, w: Math.max(...lines.map(l => l.w)) };
  _lay.set(key, L);
  return L;
}
function textW(g, str, size, weight = 500, fam = F.zh, ls = 0) { return layout(g, str, size, weight, fam, ls).w; }

// 绘制文字（x,y 为基准点，align 定水平基准：center 中心 / left 左 / right 右；多行时整块垂直居中）
// o: size weight fam color hl hl2 align ls(字距) lh(行高) stroke strokeW shadow(颜色) shadowX shadowY glow(发光模糊半径)
//    each(i, n, ch) 逐字回调：i 第几个字（从 0 起），n 总字数；返回 {a, dx, dy, s, r, color} 调这个字的透明度、位移、缩放、旋转、颜色，返回 null 不画这个字
// 返回排版结果 {lines, w}
function txt(g, str, x, y, o = {}) {
  const size = o.size || 60, weight = o.weight ?? 500, fam = o.fam || F.zh;
  const L = layout(g, str, size, weight, fam, o.ls || 0);
  const lh = o.lh || size * 1.32, n = L.lines.length;
  const total = L.lines.reduce((s, l) => s + l.gl.length, 0);
  const baseA = g.globalAlpha;
  const color = o.color || '#fff';
  setFont(g, size, weight, fam);
  g.textBaseline = 'middle'; g.textAlign = 'left';
  let gi = 0;
  for (let li = 0; li < n; li++) {
    const ln = L.lines[li];
    const lx = o.align === 'left' ? x : o.align === 'right' ? x - ln.w : x - ln.w / 2;
    const ly = y + (li - (n - 1) / 2) * lh;
    for (const q of ln.gl) {
      const m = o.each ? o.each(gi, total, q.ch) : {};
      gi++;
      if (m === null) continue;
      const a = m.a ?? 1, s = m.s ?? 1, rot = m.r || 0;
      if (a <= 0) continue;
      const col = m.color || (q.k === 1 ? (o.hl || color) : q.k === 2 ? (o.hl2 || color) : color);
      const cx = lx + q.x + (m.dx || 0), cy = ly + (m.dy || 0);
      g.globalAlpha = baseA * a;
      const tr = s !== 1 || rot;
      if (tr) { g.save(); g.translate(cx + q.w / 2, cy); g.rotate(rot); g.scale(s, s); g.translate(-(cx + q.w / 2), -cy); }
      if (o.stroke) { g.lineWidth = o.strokeW || size * 0.12; g.strokeStyle = o.stroke; g.lineJoin = 'round'; g.strokeText(q.ch, cx, cy); }
      if (o.shadow) { g.fillStyle = o.shadow; g.fillText(q.ch, cx + (o.shadowX ?? size * 0.05), cy + (o.shadowY ?? size * 0.05)); }
      if (o.glow) { g.shadowColor = col; g.shadowBlur = o.glow; }
      g.fillStyle = col; g.fillText(q.ch, cx, cy);
      if (o.glow) g.shadowBlur = 0;
      if (tr) g.restore();
    }
  }
  g.globalAlpha = baseA;
  return L;
}

// 圆角矩形路径（只建路径，填充、描边、裁切自己做）
function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
