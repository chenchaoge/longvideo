'use strict';
// ================= 动画引擎核心：常量 / 数学 / 时间轴元素系统 / 声音事件 =================
// 只提供底层能力，不带任何画面样式：背景、配色、入退场、镜头运动、转场、特效都由每条视频的场景脚本自己写
const cv = document.getElementById('cv');         // 画布尺寸由 render.mjs 按 project.json 的 orientation 写进 index.html：横版 1920×1080，竖版 1080×1920
const ctx = cv.getContext('2d');
const W = cv.width, H = cv.height, FPS = 30;
const PORTRAIT = H > W;                           // 竖版
const CX = W / 2, CY = PORTRAIT ? 805 : 470;      // 画面内容中心：横版底部留字幕区；竖版是主要内容区 x 140～940、y 250～1360 的中心
document.documentElement.style.setProperty('--ar', W / H);   // 预览页按画面比例缩放
let DUR = 0;                                      // 成片时长，启动时从项目配置读取（减去 cuts 剪掉的段）
let TL = null;                                    // 项目配置 project.json
const IMG = {};                                   // project.json 的 images，启动时加载好：IMG[键名] 是 Image
const F = {                                        // 只用开源免费商用字体（SIL OFL）：思源黑体、思源宋体（系统里要装 Google 的 Noto 版，启动时检查）
  zh: '"Noto Sans SC", sans-serif',
  serif: '"Noto Serif SC", serif',
};

// ---------- 数学 / 缓动 ----------
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const inv = (a, b, v) => clamp((v - a) / (b - a));
const TAU = Math.PI * 2;
const E = {
  lin: t => t,
  inQ: t => t * t,
  outQ: t => 1 - (1 - t) * (1 - t),
  ioQ: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  inC: t => t * t * t,
  outC: t => 1 - Math.pow(1 - t, 3),
  ioC: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  outE: t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t),
  inE: t => t <= 0 ? 0 : Math.pow(2, 10 * t - 10),
  ioE: t => t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  outB: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  inB: t => { const c1 = 1.70158; return (c1 + 1) * t * t * t - c1 * t * t; },
  outEl: t => t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1,
};
// 区间进度（带缓动）
const P = (t, t0, d, e = E.outC) => e(clamp((t - t0) / d));
// 关键帧插值：keys=[[t,v],...]，两帧之间按 ease 过渡
function kf(t, keys, ease = E.ioC) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      return lerp(v0, v1, ease(clamp((t - t0) / (t1 - t0))));
    }
  }
  return keys[keys.length - 1][1];
}

// 可复现随机数
function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const hash = (n) => { const r = rng(n * 7919 + 13); return r(); };   // 单值哈希随机

// 数字格式化
const fmt = (n) => Math.round(n).toLocaleString('en-US');

// ---------- 字幕时间 ----------
const CUES = [];                                   // 1 基索引：CUES[1] 为第一句
const c = (n) => CUES[n].s;                         // 第 n 句开始
const ce = (n) => CUES[n].e;                        // 第 n 句结束
function parseSRT(txt) {
  const blocks = txt.replace(/\r/g, '').trim().split(/\n\s*\n/);
  const toS = (s) => { const m = s.match(/(\d+):(\d+):(\d+)[,.](\d+)/); return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000; };
  for (const b of blocks) {
    const ls = b.split('\n'); const idx = +ls[0];
    const [a, z] = ls[1].split('-->');
    CUES[idx] = { i: idx, s: toS(a), e: toS(z), text: ls.slice(2).join(' ') };
  }
}

// ---------- 时间轴元素系统 ----------
const PREP = [];                                   // 场景构建前的准备函数
const BUILD = [];                                  // 各场景文件注册的构建函数
const SCENES = [];                                 // {t0,t1,els,cam}
const OVER = [];                                   // 顶层元素（不受场景镜头影响，画在所有场景之上）
const SFX = [];                                    // 音效事件 {t,name,gain,pan}
let CUR = null;

// 场景：t0～t1 一组元素；opts.cam(lt, t) 返回 {s, x, y, r} 给整组元素加镜头变换（camX/camY 为变换中心，默认 CX/CY）
function scene(t0, t1, opts, build) {
  if (typeof opts === 'function') { build = opts; opts = {}; }
  const sc = Object.assign({ t0, t1, els: [] }, opts);
  const prev = CUR; CUR = sc; build(sc); CUR = prev;
  sc.els.sort((a, b) => a.z - b.z);
  sc.start = Math.min(t0, ...sc.els.map(e => e.t0));
  sc.end = Math.max(t1, ...sc.els.map(e => e.t1));
  SCENES.push(sc);
  return sc;
}

// 元素：t0 ≤ t < t1 时画，到点就没；淡入淡出、位移等动画都在 draw 里按时间自己算
// o: t0 t1（默认到所在场景结束）x y z（同场景内的叠放次序）sc rot alpha over（放到顶层）sfx draw(g, a)
// a: t 全片时间  lt 元素内时间  dur 元素时长  p 元素内进度 0..1（线性）  e 元素本身
function el(o) {
  const e = { t1: CUR ? CUR.t1 : o.t0 + 3, x: 0, y: 0, z: 0, sc: 1, rot: 0, alpha: 1 };
  for (const k in o) if (o[k] !== undefined) e[k] = o[k];   // 忽略 undefined，保留默认值
  if (CUR && !o.over) CUR.els.push(e); else OVER.push(e);
  if (e.sfx) {
    const list = Array.isArray(e.sfx) ? e.sfx : [e.sfx];
    for (const s of list) {
      if (typeof s === 'string') sfx(s, e.t0);
      else sfx(s.n, e.t0 + (s.at || 0), s.g ?? 1, s.p ?? 0);
    }
  }
  return e;
}

// 音效事件：name 是本稿音效脚本（project.json 的 sfx_py）里定义的音效名
function sfx(name, t, gain = 1, pan = 0) { SFX.push({ name, t: +t.toFixed(4), gain, pan }); }
// 音频采样事件（直接用现成音频文件，如游戏原声、实机录像原声、录好的台词）：file 为相对用户工作目录的路径
// o: ss 源文件起点秒  dur 截取时长(null=到结尾)  g 音量  p 声像  fi/fo 淡入淡出秒  rate 变速(同时变调)  norm 先把这段的响度拉到 norm dBFS 再乘 g（响度差很大的录像原声用）
const SAMPLES = [];
function sample(t, file, o = {}) {
  SAMPLES.push({ t: +t.toFixed(4), file, ss: o.ss || 0, dur: o.dur ?? null, gain: o.g ?? 1, pan: o.p ?? 0, fi: o.fi ?? 0.005, fo: o.fo ?? 0.03, rate: o.rate ?? 1, norm: o.norm ?? null });
}
// 配乐闪避：t0~t1 期间配乐压到 level 倍（前后各 ramp 秒过渡）
const DUCKS = [];
function duckMusic(t0, t1, level = 0.4, ramp = 0.25) { DUCKS.push({ t0, t1, level, ramp }); }
// 登记用户素材图片的出现时间（成片质检会在它出现前后抽帧核对）；图片怎么画由场景脚本自己定
const IMG_SHOWS = [];
function markImage(key, t0, t1) { IMG_SHOWS.push({ key, t0, t1 }); }

function drawEl(g, e, t) {
  if (t < e.t0 || t >= e.t1 || e.alpha <= 0) return;
  const lt = t - e.t0, dur = e.t1 - e.t0;
  g.save();
  g.globalAlpha *= e.alpha;
  g.translate(e.x, e.y);
  if (e.rot) g.rotate(e.rot);
  if (e.sc !== 1) g.scale(e.sc, e.sc);
  e.draw(g, { t, lt, dur, p: dur > 0 ? clamp(lt / dur) : 1, e });
  g.restore();
}

function applyCam(g, cam, ox, oy) {
  g.translate(ox + (cam.x || 0), oy + (cam.y || 0));
  if (cam.r) g.rotate(cam.r);
  if (cam.s !== undefined && cam.s !== 1) g.scale(cam.s, cam.s);
  g.translate(-ox, -oy);
}

// ---------- 帧渲染：先清成黑底，再按顺序画各场景，最后画顶层元素 ----------
function renderAt(t) {
  const g = ctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none';
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  for (const sc of SCENES) {
    if (t < sc.start || t >= sc.end) continue;
    g.save();
    if (sc.cam) applyCam(g, sc.cam(t - sc.t0, t), sc.camX ?? CX, sc.camY ?? CY);
    for (const e of sc.els) drawEl(g, e, t);
    g.restore();
  }
  for (const e of OVER) drawEl(g, e, t);
}
