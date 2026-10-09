'use strict';
// ================= 实机视频层：片段预抽成 JPEG 帧序列（render.mjs 菜单 8），渲染每帧前按需异步加载 =================
// project.json 里 clips: { 键名: { file 视频（相对用户工作目录，如 素材/录像.mp4）, ss 起点秒, dur 时长秒, crop [x,y,w,h] 可选 } }
// 场景里用 Clip(t0, 键名, o) 放到画面上；源时间默认从片段起点按 1 倍速走，o.map 可自定义（定格、变速、倒放）
const CLIP_FPS = 30;
const CLIP_USES = [];                              // {key, t0, t1, map}：哪段时间要用哪个片段的哪一帧
const CLIP_CACHE = new Map();                      // 'key/帧号' → {img, p}
const CLIP_CACHE_MAX = 360;

const clipDir = (key) => `${DRAFT}中间文件/clips/${key}/`;         // 当前稿的中间文件（与 render.mjs 的 BUILD_DIR 一致）
function clipIdx(key, st) {
  const c = TL.clips[key];
  return clamp(Math.round(st * CLIP_FPS), 0, Math.round(c.dur * CLIP_FPS) - 1);
}
function loadClipFrame(id) {
  let e = CLIP_CACHE.get(id);
  if (e) { CLIP_CACHE.delete(id); CLIP_CACHE.set(id, e); return e.p; }   // 挪到最新，近似 LRU
  const [key, idx] = id.split('/');
  const img = new Image();
  const p = new Promise((res) => {
    img.onload = () => img.decode().then(res, res);
    img.onerror = () => { MISSING.add('clip:' + id); res(); };
  });
  img.src = clipDir(key) + `f_${String(+idx + 1).padStart(5, '0')}.jpg`;
  e = { img, p };
  CLIP_CACHE.set(id, e);
  while (CLIP_CACHE.size > CLIP_CACHE_MAX) CLIP_CACHE.delete(CLIP_CACHE.keys().next().value);
  return p;
}
// 渲染 t 秒前调用：把这一帧要用的实机帧都加载好
function prepareFrame(t) {
  const need = [];
  for (const u of CLIP_USES) if (t >= u.t0 - 1e-3 && t <= u.t1 + 1e-3) need.push(loadClipFrame(`${u.key}/${clipIdx(u.key, u.map(t))}`));
  return Promise.all(need);
}
function clipImg(key, st) {
  const e = CLIP_CACHE.get(`${key}/${clipIdx(key, st)}`);
  return e && e.img.complete && e.img.naturalWidth ? e.img : null;
}

// 实机画面元素。o: map(t)→源时间  ss 源起点(秒, 相对片段)  speed  src [x,y,w,h] 源裁切(相对抽出的帧)
//   w h 目标尺寸  r 圆角  filter 调色(canvas filter 字符串，或 (a) => 字符串)  frame(g,a,w,h) 叠加绘制  count:false 不计入实机在屏时长  其余同 el()
function Clip(t0, key, o = {}) {
  const ss = o.ss || 0, sp = o.speed ?? 1;
  const map = o.map || ((t) => ss + (t - t0) * sp);
  const e = el(Object.assign({}, o, {
    t0, x: o.x ?? CX, y: o.y ?? H / 2,
    draw: (g, a) => {
      const im = clipImg(key, map(a.t));
      if (!im) return;
      const s = o.src || [0, 0, im.naturalWidth, im.naturalHeight];
      const w = o.w || s[2], h = o.h || s[3];
      g.save();
      if (o.r !== undefined) { rr(g, -w / 2, -h / 2, w, h, o.r); g.clip(); }
      if (o.filter) g.filter = typeof o.filter === 'function' ? o.filter(a) : o.filter;
      g.drawImage(im, s[0], s[1], s[2], s[3], -w / 2, -h / 2, w, h);
      g.filter = 'none';
      g.restore();
      if (o.frame) o.frame(g, a, w, h);
    },
  }));
  CLIP_USES.push({ key, t0, t1: e.t1, map, count: o.count !== false });
  return e;
}

// 实机画面在屏时长（各使用区间取并集，count:false 的不算；cuts 剪掉的段不算）
function clipSeconds(cuts = []) {
  const iv = CLIP_USES.filter(u => u.count).map(u => [u.t0, u.t1]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of iv) {
    const cur = merged[merged.length - 1];
    if (!cur || a > cur[1]) merged.push([a, b]); else cur[1] = Math.max(cur[1], b);
  }
  let sum = 0;
  for (const [a, b] of merged) {
    sum += b - a;
    for (const [c0, c1] of cuts) sum -= Math.max(0, Math.min(b, c1) - Math.max(a, c0));
  }
  return sum;
}
