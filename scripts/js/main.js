'use strict';
// ================= 启动：读项目配置 → 加载素材和场景脚本 → 构建场景 → 预览 / 渲染接口 =================
const MISSING = new Set();

function loadImg(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}

// 按顺序加载项目的场景脚本
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('脚本加载失败: ' + src));
    document.body.appendChild(s);
  });
}

// 系统装没装某字体：分别和两种兜底字体比量同一串字的宽度，都一样说明没装、被兜底字体顶替了
function hasFont(fam) {
  const s = '思源字体检测Ag';
  return ['monospace', 'serif'].some(fb => {
    ctx.font = `60px ${fb}`;
    const w0 = ctx.measureText(s).width;
    ctx.font = `60px "${fam}", ${fb}`;
    return ctx.measureText(s).width !== w0;
  });
}

const BASE = 'work/';                            // 用户工作目录（由 render.mjs 的服务器映射）；project.json 里的路径都相对它
const DRAFT = 'draft/';                            // 当前稿目录（由 render.mjs 的服务器映射到 工程文件/第N稿文件/）
const libUrl = (s) => new URL(/^https?:\/\//.test(s) ? s : BASE + s, location.href).href;   // 库：网址原样用，其余相对工作目录

// 第三方库（在场景脚本之前加载）：importmap {模块名: 路径或网址} 让库里的 import 'three' 这类写法找得到；
// libs 按顺序加载："路径或网址" 按普通脚本（库自己挂到全局，如 p5、gsap）；{src, as} 按 ES 模块，导出挂到 window[as]（如 THREE）
async function loadLibs() {
  if (TL.importmap) {
    const s = document.createElement('script');
    s.type = 'importmap';
    s.textContent = JSON.stringify({ imports: Object.fromEntries(Object.entries(TL.importmap).map(([k, v]) => [k, libUrl(v)])) });
    document.head.appendChild(s);
  }
  for (const l of TL.libs || []) {
    if (typeof l === 'string') await loadScript(libUrl(l));
    else window[l.as] = await import(libUrl(l.src));
  }
}
// 剪掉的时间段：project.json 的 cuts [[a,b],...]（脚本时间）。场景脚本照写原时间，成片跳过这些段；音频由 make_audio.py 在混音后按同样的段拼接
let CUTS = [];
function scriptTime(t) { for (const [a, b] of CUTS) if (t >= a - 1e-6) t += b - a; return t; }      // 成片时间 → 脚本时间
function outTime(ts) {                                                                                // 脚本时间 → 成片时间（落在剪掉的段里返回 null）
  let d = 0;
  for (const [a, b] of CUTS) { if (ts >= b) d += b - a; else if (ts > a) return null; }
  return ts - d;
}
async function boot() {
  const q = new URLSearchParams(location.search);
  window.addEventListener('error', (e) => { window.BOOT_ERROR = window.BOOT_ERROR || `${e.message} @ ${e.filename}:${e.lineno}`; });
  TL = await (await fetch(DRAFT + 'project.json')).json();
  CUTS = (TL.cuts || []).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  DUR = TL.duration - CUTS.reduce((s, [a, b]) => s + b - a, 0);
  if (TL.subs) parseSRT(await (await fetch(BASE + TL.subs)).text());   // 无字幕项目（如宣传片）可不配
  await Promise.all(Object.entries(TL.images || {}).map(async ([k, f]) => { IMG[k] = await loadImg(BASE + f); }));
  for (const [fam, f] of Object.entries(TL.fonts || {})) {            // 项目自带字体文件：{字体名: 相对路径}
    const ff = new FontFace(fam, `url("${BASE + f}")`);
    document.fonts.add(await ff.load());
  }
  for (const fl of TL.fontLoads || []) await document.fonts.load(fl, '字');   // 项目要用的系统字体（CSS font 写法）
  for (const wgt of [500, 600, 700, 800, 900]) await document.fonts.load(`${wgt} 60px "Noto Sans SC"`, '字');
  const lack = ['Noto Sans SC', 'Noto Serif SC'].filter(f => !hasFont(f));   // 没装时画布会悄悄换成别的字体，直接报错
  if (lack.length) throw new Error(`系统缺少字体 ${lack.join('、')}：思源黑体、思源宋体要装 Google 的 Noto 版（Adobe 版名叫 Source Han，认不到）`);
  await loadLibs();
  for (const s of TL.scripts || []) await loadScript(BASE + s);
  if (window.BOOT_ERROR) return;
  for (const f of SETUP) await f();
  for (const f of PREP) f();
  for (const b of BUILD) b();
  SFX.sort((a, b) => a.t - b.t);
  window.renderFrame = (f) => renderAt(scriptTime(f / FPS));
  // 先把这一帧要用的实机帧加载好再画（没有实机片段时立即返回）；f 是成片帧号
  window.frameJPEG = async (f, qq = 0.93) => { const t = scriptTime(f / FPS); await prepareFrame(t); renderAt(t); return cv.toDataURL('image/jpeg', qq).slice(23); };
  window.framePNG = async (t) => { await prepareFrame(t); renderAt(t); return cv.toDataURL('image/png').slice(22); };   // 抽帧检查：t 按脚本时间
  window.getSfx = () => SFX;                                                   // 音效、采样、闪避都按脚本时间导出
  window.getSamples = () => ({ samples: SAMPLES, ducks: DUCKS, cuts: CUTS });
  window.getClipSeconds = () => clipSeconds(CUTS);
  window.getMissing = () => [...MISSING];
  window.getImageShows = () => IMG_SHOWS.map(s => ({ key: s.key, t0: outTime(s.t0), t1: outTime(s.t1) })).filter(s => s.t0 !== null && s.t1 !== null);
  window.DURATION = DUR;
  window.ENGINE_READY = true;
  if (!q.has('render')) startPreview();
}

// ---------- 浏览器预览（带配音） ----------
function startPreview() {
  document.body.classList.add('preview');
  const au = new Audio(TL.voice ? BASE + TL.voice : DRAFT + '中间文件/mix.wav');      // 无配音项目预览用混音（做完混音才有声）
  const bar = document.getElementById('bar'), fill = document.getElementById('fill'), info = document.getElementById('info');
  let t = 0;
  const q = new URLSearchParams(location.search);
  if (q.has('t')) t = +q.get('t');
  au.currentTime = t;
  const seek = (v) => { t = clamp(v, 0, DUR); au.currentTime = t; };
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { au.paused ? au.play() : au.pause(); e.preventDefault(); }
    if (e.code === 'ArrowLeft') seek(t - 2);
    if (e.code === 'ArrowRight') seek(t + 2);
  });
  bar.addEventListener('click', (e) => { const r = bar.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * DUR); });
  const loop = () => {
    if (!au.paused) t = au.currentTime;
    prepareFrame(scriptTime(t));                    // 预览不等加载，画已到的帧（t 是成片时间，和混音对齐）
    renderAt(scriptTime(t));
    fill.style.width = (t / DUR * 100) + '%';
    const cue = CUES.find(cc => cc && t >= cc.s && t < cc.e);
    info.textContent = `${t.toFixed(2)}s  ${cue ? '#' + cue.i + ' ' + cue.text : ''}`;
    requestAnimationFrame(loop);
  };
  loop();
}

boot().catch(e => { console.error(e); window.BOOT_ERROR = String(e && e.stack || e); });
