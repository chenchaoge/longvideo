// ================= 动画工具（菜单启动）：文稿转字幕 / 初始化项目 / 并行渲染 / 抽帧检查 / 导出音效表 / 出片 / 预览 / 成片质检 =================
// 在用户工作目录里运行（cd 过去再 node <本脚本>）：工作目录 = 一条视频，用户只准备 文稿（TXT版本）和素材；
// 要给用户看的（超长字幕清单、成片）放工作目录顶层，其余都放 工程文件/：各稿通用的（开场核对、进度记录、初版 SRT、剪映导出的配音和 SRT）放 工程文件/ 下，随稿变化的（动画大纲、project.json、AI 写的字幕、场景脚本/、中间文件/）放 工程文件/第N稿文件/
// 配乐、音效、混音另用 audio/make_audio.py
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { txtToCues, toSRT, width, WARN_LEN } from './srt.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.cwd();                                    // 用户工作目录（运行时所在目录）
const ENG_DIR = '工程文件';                                     // 工作目录里放不给用户看的文件的子目录
const ENG = path.join(WORK, ENG_DIR);
const SCENE_DIR = '场景脚本', BUILD_DIR = '中间文件';             // 每稿目录里由工具生成的两个子目录
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac'];
const DRAFT_TAG = '_初版';                                       // 文稿转字幕生成的初版 SRT 的文件名后缀
const LONG_FILE = `超过每行${WARN_LEN}个字的字幕.txt`;               // 超长清单的文件名（放工作目录顶层）
const END_MARK = '【结束】', ERR_MARK = '【出错】';                 // 程序最后一行打印其中一个，调用方只认这两个判断跑完没有
const CHECK_FILE = '开场核对.json';                              // 开场核对结果（在 工程文件/ 里），菜单 9 从这里取要转字幕的稿：voiceScript（要念的台词稿），没有就用 script（整篇文稿）
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FPS = 30;
const WORKERS = 2;                                            // 并行渲染进程数（内存紧张，取 2）
const SEG_FRAMES = 900;                                       // 每个分段帧数（30 秒）
const JPEG_Q = 0.95;
// 出片格式标准（详见 references/视频动画出片格式标准.md）：720P、30 帧、x264 slow + 动画优化 + CRF 23、AAC 256k
const CANVAS = { 横版: [1920, 1080], 竖版: [1080, 1920] };      // 母版画布（project.json 的 orientation）
const EXPORT = { 横版: [1280, 720], 竖版: null };               // 成片尺寸：横版缩到 720P，竖版不缩
const X264_STD = ['-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation', '-crf', '23', '-pix_fmt', 'yuv420p'];
const AUDIO_STD = ['-c:a', 'aac', '-b:a', '256k'];
const QA_SPOTS = 9;                                           // 质检时全片均匀抽帧张数
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.srt': 'text/plain; charset=utf-8', '.ttf': 'font/ttf', '.otf': 'font/otf' };

// ---------- 输入（兼容管道输入） ----------
const piped = !process.stdin.isTTY;
const pipedLines = piped ? fs.readFileSync(0, 'utf8').split(/\r?\n/) : null;
let rl = null;
function ask(q) {
  if (piped) { const v = (pipedLines.shift() ?? '').trim(); console.log(q + v); return Promise.resolve(v); }
  rl = rl || readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => res(a.trim())));
}

// ---------- 项目 ----------
let PJ = null;                                                // 当前项目 {name, dir 工作目录, cfg, build 中间文件目录}；project.json 里的路径都相对工作目录
async function choose(list, q) {
  list.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
  const k = Number(await ask(q));
  if (!list[k - 1]) throw new Error('编号无效');
  return list[k - 1];
}
// ---------- 分稿：工程文件/第一稿文件、第二稿文件…，放随稿变化的大纲、project.json、字幕、场景脚本、中间文件 ----------
const CN_DIGIT = '零一二三四五六七八九';
const cnNum = (n) => n < 10 ? CN_DIGIT[n] : `${n >= 20 ? CN_DIGIT[Math.floor(n / 10)] : ''}十${n % 10 ? CN_DIGIT[n % 10] : ''}`;   // 1～99 转中文数字
const draftOf = (n) => { const name = `第${cnNum(n)}稿文件`; return { n, name, dir: path.join(ENG, name) }; };
function drafts() {                                           // 工程文件/ 里已有的稿，按稿号从小到大
  const byName = new Map(Array.from({ length: 99 }, (_, i) => [draftOf(i + 1).name, i + 1]));
  if (!fs.existsSync(ENG)) return [];
  return fs.readdirSync(ENG).filter(n => byName.has(n) && fs.statSync(path.join(ENG, n)).isDirectory()).map(n => draftOf(byName.get(n))).sort((a, b) => a.n - b.n);
}
function loadProject() {                                      // 当前稿 = 有 project.json 的最大号稿
  const d = drafts().filter(x => fs.existsSync(path.join(x.dir, 'project.json'))).at(-1);
  if (!d) throw new Error(`当前目录（${WORK}）的 ${ENG_DIR}/ 里没有已初始化的稿：要在用户工作目录里运行，并先选 0 初始化项目`);
  PJ = { name: path.basename(WORK), dir: WORK, draft: d.dir, draftName: d.name, cfg: JSON.parse(fs.readFileSync(path.join(d.dir, 'project.json'), 'utf8')), build: path.join(d.dir, BUILD_DIR) };
  console.log(`当前稿：${ENG_DIR}/${d.name}`);
  if (!CANVAS[PJ.cfg.orientation]) throw new Error(`${ENG_DIR}/${d.name}/project.json 的 orientation 只能是 横版 或 竖版，现在是：${PJ.cfg.orientation}`);
  fs.mkdirSync(PJ.build, { recursive: true });
}
// 成片按序号出到工作目录顶层：<片名>_1.mp4、<片名>_2.mp4…，每次出片序号递增、不覆盖旧版；带字幕版同号加 _字幕
const outSeq = () => {                                        // 工作目录里本片已有的最大序号，没有为 0
  const pre = `${PJ.cfg.name}_`;
  const ns = fs.readdirSync(WORK)
    .filter(f => f.startsWith(pre) && f.endsWith('.mp4')).map(f => f.slice(pre.length, -4)).filter(s => /^\d+$/.test(s)).map(Number);
  return ns.length ? Math.max(...ns) : 0;
};
const outFile = (n) => path.join(WORK, `${PJ.cfg.name}_${n}.mp4`);           // 无字幕版（导入剪映用）
const subFile = (n) => path.join(WORK, `${PJ.cfg.name}_${n}_字幕.mp4`);      // 带字幕版（有字幕的项目才出）
// 烧字幕：思源黑体 Bold 白字黑边贴底（fonts/ 里的静态粗体，从系统思源黑体可变字体导出，SIL OFL；系统那个可变字体烧字幕只认得最细一档）
// 字号、描边、边距按 libass 默认 288 行高换算（字号随画面高度缩放）：横版 17 ≈ 720P 画面 42 像素；
// 竖版实测 9.6：一个字约 43 像素宽（和横版母版一样大），下沿在 y 1510，一行放不下自动折两行，左右在 140～940 之内
const SUB_FONT_DIR = path.join(ROOT, 'fonts');
const SUB_BASE = 'FontName=Noto Sans SC,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Shadow=0';
const SUB_STYLE = { 横版: `${SUB_BASE},FontSize=17,Outline=1.3,MarginV=16`, 竖版: `${SUB_BASE},FontSize=9.6,Outline=0.72,MarginV=60,MarginL=50,MarginR=50` };

// 文稿转字幕：要念的稿（开场核对记录的 voiceScript 台词稿；口播类没有，用整篇文稿 script）一行一条 → 有超长先只出顶层 超过每行30个字的字幕.txt（给用户看）；
// 没有超长或用户明确不改，才出 工程文件/<稿名>_初版.srt（时间是占位的，导入剪映配音后再对轴）
async function txtToSrt() {
  const ck = path.join(ENG, CHECK_FILE), ckRel = `${ENG_DIR}/${CHECK_FILE}`;
  if (!fs.existsSync(ck)) throw new Error(`没有 ${ckRel}：先完成开场核对`);
  const ckv = JSON.parse(fs.readFileSync(ck, 'utf8'));
  const txt = ckv.voiceScript || ckv.script;
  if (!txt) throw new Error(`${ckRel} 里没有文稿（无文稿分支不用菜单 9）`);
  if (!fs.existsSync(path.join(WORK, txt))) throw new Error(`${ckRel} 记录的稿 ${txt} 不在工作目录里`);
  console.log(`转字幕的稿：${txt}${ckv.voiceScript ? '（要念的台词稿）' : '（整篇文稿）'}`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(WORK, txt))); }
  catch { throw new Error(`${txt} 不是 UTF-8 编码，请用记事本「另存为」选 UTF-8 后再转`); }
  const cues = txtToCues(text);
  if (!cues.length) throw new Error(`${txt} 里没有文字`);
  const name = path.parse(txt).name;
  // 先查超长：超长字幕不拆，只列清单让用户自己改，用户明确不改才往下生成字幕；没有超长就不出清单，并删掉上一次留下的旧清单
  const long = cues.map((c, i) => ({ i: i + 1, w: width(c.text), text: c.text })).filter(c => c.w > WARN_LEN);
  const rep = path.join(WORK, LONG_FILE);
  if (long.length) {
    const lines = long.map(c => `第 ${c.i} 条（${c.w} 字）：${c.text}`);
    fs.writeFileSync(rep, [`超过 ${WARN_LEN} 字的有 ${long.length} 条（英文、数字按半个字算）。`, `建议修改文稿TXT文档，控制每一行字幕在 ${WARN_LEN} 字以内，这是为了避免字幕一次性出现太多。`, '', ...lines].join('\r\n') + '\r\n');
    console.log(`警告：超过 ${WARN_LEN} 字的有 ${long.length} 条，清单已写到 ${rep}`);   // 具体字幕只写进清单，不在屏幕上列
    if ((await ask('用户明确不修改文稿就输入 y 继续生成字幕，其他先退出（改完文稿再选 9）: ')) !== 'y') { console.log('已退出，没有生成字幕'); return; }
  } else {
    if (fs.existsSync(rep)) fs.unlinkSync(rep);
    console.log(`没有超过 ${WARN_LEN} 字的字幕`);
  }
  const out = path.join(ENG, name + DRAFT_TAG + '.srt'), outRel = `${ENG_DIR}/${path.basename(out)}`;
  if (fs.existsSync(out) && (await ask(`${outRel} 已存在，覆盖吗？（输入 y 覆盖，其他取消）: `)) !== 'y') { console.log('已取消'); return; }
  fs.mkdirSync(ENG, { recursive: true });
  fs.writeFileSync(out, toSRT(cues));
  console.log(`已生成：${out}\n共 ${cues.length} 条，占位总长 ${cues.at(-1).e.toFixed(1)} 秒（时间只是占位，剪映里按配音重调）`);
}

// 初始化项目：配音和 SRT 先找本稿目录（AI 按剧本拼的配音、写的字幕），再找 工程文件/（剪映导出的，各稿通用）；在工作目录里找图片（原地引用，不拷贝），算出时长，生成配置和空的场景文件
const SCENE_STUB = `'use strict';\nBUILD.push(() => {\n});\n`;
// 在某目录顶层找某类文件（keep 再筛一道）：只有一个直接用，多个让人选；没有返回 null
async function findOne(dir, exts, label, keep = () => true) {
  if (!fs.existsSync(dir)) return null;
  const fs0 = fs.readdirSync(dir).filter(f => exts.includes(path.extname(f).toLowerCase()) && keep(f) && fs.statSync(path.join(dir, f)).isFile());
  if (!fs0.length) return null;
  if (fs0.length === 1) return fs0[0];
  console.log(`找到多个${label}：`);
  return choose(fs0, `选择${label}编号: `);
}
// 菜单 0：最大号的稿还没有 project.json 就初始化它（没有稿就建第一稿）；已有 project.json 就复制成下一稿
async function initProject() {
  const last = drafts().at(-1);
  if (!last) return initDraft(draftOf(1));
  if (!fs.existsSync(path.join(last.dir, 'project.json'))) return initDraft(last);
  copyDraft(last, draftOf(last.n + 1));
}
// 复制上一稿成下一稿：大纲、project.json、字幕、场景脚本都带上，中间文件不带；project.json 里指向上一稿的路径改成新稿
function copyDraft(src, dst) {
  fs.cpSync(src.dir, dst.dir, { recursive: true, filter: f => f !== path.join(src.dir, BUILD_DIR) });
  const f = path.join(dst.dir, 'project.json');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll(`${ENG_DIR}/${src.name}/`, `${ENG_DIR}/${dst.name}/`));
  fs.mkdirSync(path.join(dst.dir, BUILD_DIR), { recursive: true });
  console.log(`已建 ${ENG_DIR}/${dst.name}（从 ${src.name} 复制，中间文件不带）`);
}
async function initDraft(d) {
  fs.mkdirSync(d.dir, { recursive: true });
  const ck = path.join(ENG, CHECK_FILE);                      // 横竖版取开场核对的结果
  if (!fs.existsSync(ck)) throw new Error(`没有 ${ENG_DIR}/${CHECK_FILE}：先完成开场核对`);
  const orientation = JSON.parse(fs.readFileSync(ck, 'utf8')).orientation;
  if (!CANVAS[orientation]) throw new Error(`${ENG_DIR}/${CHECK_FILE} 的 orientation 只能是 横版 或 竖版，现在是：${orientation}`);
  const notDraft = f => !path.parse(f).name.endsWith(DRAFT_TAG);   // 初版 SRT 不算
  const dVoice = await findOne(d.dir, AUDIO_EXT, '配音');          // 非口播类：AI 按剧本把台词摆好位置拼成的配音，在本稿里
  const voice = dVoice || await findOne(ENG, AUDIO_EXT, '配音');   // 口播类：剪映导出的配音，在工程文件/ 里
  const dSrt = await findOne(d.dir, ['.srt'], '字幕');             // AI 按剧本写在本稿里的字幕（无配音项目、非口播类）
  const srt = dSrt || (dVoice ? null : await findOne(ENG, ['.srt'], '字幕', notDraft));   // 口播类：剪映导出的字幕，在工程文件/ 里，各稿通用；非口播类只认本稿的
  const voiceFile = voice && path.join(dVoice ? d.dir : ENG, voice);
  let duration;
  if (voice) {
    const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', voiceFile], { encoding: 'utf8' });
    duration = Number(pr.stdout.trim());
    if (!(duration > 0)) throw new Error('读不出配音时长: ' + voice);
  } else {
    duration = Number(await ask('没有配音（无配音项目），输入全片时长秒: '));   // 宣传片等无配音项目
    if (!(duration > 0)) throw new Error('时长无效');
  }
  if (voice && !dVoice && !srt) throw new Error(`有剪映导出的配音，但 ${ENG_DIR}/ 里找不到剪映导出的字幕（.srt）`);   // 非口播类（本稿里拼的配音）可以不显示台词字幕
  const images = {};                                          // 工作目录顶层和一级子目录（工程文件/ 除外）里的图片，键名 = 文件名（不含扩展名）
  for (const sub of ['', ...fs.readdirSync(WORK).filter(n => n !== ENG_DIR && fs.statSync(path.join(WORK, n)).isDirectory())]) {
    for (const f of fs.readdirSync(path.join(WORK, sub))) {
      if (IMG_EXT.includes(path.extname(f).toLowerCase())) images[path.parse(f).name] = sub ? `${sub}/${f}` : f;
    }
  }
  const now = new Date();
  const pname = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}视频`;   // 默认片名：当天日期视频，如 0920视频
  const name = (await ask(`片名（成片文件名，回车=${pname}）: `)) || pname;
  const eng = (f) => `${ENG_DIR}/${f}`;                       // project.json 里的路径都相对工作目录
  const dr = (f) => `${ENG_DIR}/${d.name}/${f}`;
  const subs = srt && (dSrt ? dr(srt) : eng(srt));
  const cfg = {                                               // 配乐脚本 music_py、音效脚本 sfx_py 由 AI 为这条视频自己写，写好再填
    name, orientation, duration: +duration.toFixed(3), ...(voice ? { voice: dVoice ? dr(voice) : eng(voice) } : {}), ...(srt ? { subs } : {}), images,
    scripts: [dr(`${SCENE_DIR}/s1.js`)],
  };
  fs.mkdirSync(path.join(d.dir, SCENE_DIR), { recursive: true });
  fs.mkdirSync(path.join(d.dir, BUILD_DIR), { recursive: true });
  fs.writeFileSync(path.join(d.dir, 'project.json'), JSON.stringify(cfg, null, 2));
  const stub = path.join(d.dir, SCENE_DIR, 's1.js');
  if (!fs.existsSync(stub)) fs.writeFileSync(stub, SCENE_STUB);
  console.log(`已初始化：${ENG_DIR}/${d.name}\n${orientation}，字幕 ${subs || '无'}，配音 ${voice ? cfg.voice : '无'}，时长 ${cfg.duration} 秒，图片 ${Object.keys(images).length} 张`);
  console.log(`下一步：按动画大纲写场景（${dr(SCENE_DIR)}/），配乐脚本、音效脚本写好后填进 ${dr('project.json')} 的 music_py、sfx_py`);
}

// 引擎目录：默认是工具目录；旧项目在 project.json 的 engine 里指向自己存的旧版引擎快照（里面有 index.html 和 js/），照旧版画面渲染
const engineDir = () => PJ.cfg.engine ? path.join(PJ.dir, PJ.cfg.engine) : ROOT;

// ---------- 静态服务器：/work/ 指向用户工作目录，/draft/ 指向当前稿目录，页面和 js/ 指向引擎目录，其余指向工具目录 ----------
function startServer(port = 0) {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const isIndex = p === '/' || p === '/index.html';
    let base = ROOT, rel = isIndex ? 'index.html' : p;
    if (p.startsWith('/work/')) { base = PJ.dir; rel = p.slice(6); }
    else if (p.startsWith('/draft/')) { base = PJ.draft; rel = p.slice(7); }   // /draft/ 指向当前稿目录
    else if (isIndex || p.startsWith('/js/')) base = engineDir();
    const f = path.join(base, rel);
    if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (isIndex) {                                             // 画布尺寸按项目横竖版写进页面，引擎从画布读尺寸
      const [w, h] = CANVAS[PJ.cfg.orientation];
      res.end(fs.readFileSync(f, 'utf8').replace('width="1920" height="1080"', `width="${w}" height="${h}"`));
      return;
    }
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(res => srv.listen(port, '127.0.0.1', () => res(srv)));
}

async function openPage(port) {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--disable-gpu-vsync', '--force-device-scale-factor=1'] });
  const [w, h] = CANVAS[PJ.cfg.orientation];
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?render=1`);
  await page.waitForFunction(() => window.ENGINE_READY || window.BOOT_ERROR, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.BOOT_ERROR);
  if (err) throw new Error('页面启动失败: ' + err + '\n' + logs.join('\n'));
  return { browser, page, logs };
}

// ---------- 渲染一段帧到 mp4（母版：1080P 高画质，只做中间文件） ----------
async function encodeRange(page, f0, f1, file, tag) {
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-threads', '2', '-rc-lookahead', '20', '-r', String(FPS), file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let f = f0; f < f1; f++) {
    const b64 = await page.evaluate(([fr, q]) => window.frameJPEG(fr, q), [f, JPEG_Q]);
    if (!ff.stdin.write(Buffer.from(b64, 'base64'))) await once(ff.stdin, 'drain');
    if ((f - f0) % 300 === 0 && f > f0) {
      const sp = (f - f0) / ((Date.now() - t0) / 1000);
      console.log(`[${tag}] ${f - f0}/${f1 - f0} 帧  ${sp.toFixed(1)} 帧/秒`);
    }
  }
  ff.stdin.end();
  const [code] = await once(ff, 'close');
  if (code !== 0) throw new Error(`[${tag}] ffmpeg 编码失败，退出码 ${code}`);
}

// 渲染版本指纹：引擎、项目配置、场景脚本、字幕、图片、实机片段任一变了，旧分段作废重渲（防止续渲把旧版画面拼进来）
function renderStamp() {
  const h = crypto.createHash('sha1');
  const eat = (f) => { if (fs.existsSync(f)) h.update(f).update(fs.readFileSync(f)); };
  const jsIn = (d) => fs.existsSync(d) ? fs.readdirSync(d).filter(n => n.endsWith('.js')).sort().map(n => path.join(d, n)) : [];
  const subs = PJ.cfg.subs ? [path.join(PJ.dir, PJ.cfg.subs)] : [];   // 场景按字幕时间 c(i) 排，字幕改了画面也要重渲
  [path.join(engineDir(), 'index.html'), ...jsIn(path.join(engineDir(), 'js')), path.join(PJ.draft, 'project.json'), ...jsIn(path.join(PJ.draft, SCENE_DIR)), ...subs].forEach(eat);
  for (const p of Object.values(PJ.cfg.images || {})) {       // 图片只看大小和修改时间，不读内容
    const f = path.join(PJ.dir, p);
    if (fs.existsSync(f)) { const s = fs.statSync(f); h.update(`${p}|${s.size}|${s.mtimeMs}`); }
  }
  for (const k of Object.keys(PJ.cfg.clips || {})) eat(path.join(PJ.build, 'clips', k, 'done.json'));
  return h.digest('hex');
}

async function renderAll(t0s = 0, t1s = null) {
  const chunkDir = path.join(PJ.build, 'chunks');
  fs.mkdirSync(chunkDir, { recursive: true });
  const srv = await startServer();
  const port = srv.address().port;
  const probe = await openPage(port);
  const dur = await probe.page.evaluate(() => window.DURATION);
  const missing = await probe.page.evaluate(() => window.getMissing());
  await probe.browser.close();
  if (missing.length) console.log('缺失资源:', missing.join(', '));
  const fStart = Math.round(t0s * FPS), fEnd = t1s ? Math.round(t1s * FPS) : Math.ceil(dur * FPS);
  // 切成 30 秒一段的小分段，工作进程排队领取；每段完成即标记，中断后可续渲
  const segs = [];
  for (let a = fStart; a < fEnd; a += SEG_FRAMES) segs.push([a, Math.min(fEnd, a + SEG_FRAMES)]);
  const files = segs.map(([a, b]) => path.join(chunkDir, `c_${String(a).padStart(6, '0')}_${String(b).padStart(6, '0')}.mp4`));
  const tStart = Date.now();
  const stamp = renderStamp();
  const isDone = (f) => fs.existsSync(f + '.done') && fs.readFileSync(f + '.done', 'utf8') === stamp;   // 标记里的指纹对得上才算完成
  let next = 0, doneCnt = files.filter(isDone).length;
  const segMs = [];                                             // 本次渲完的每段用时，用来估剩余时间
  const worker = async (wi) => {
    let ctx = null;
    for (;;) {
      const k = next++;
      if (k >= segs.length) break;
      if (isDone(files[k])) continue;
      ctx = ctx || await openPage(port);
      const t0 = Date.now();
      await encodeRange(ctx.page, segs[k][0], segs[k][1], files[k], 'W' + wi);
      fs.writeFileSync(files[k] + '.done', stamp);
      doneCnt++;
      segMs.push(Date.now() - t0);
      const eta = segMs.reduce((s, v) => s + v, 0) / segMs.length * (segs.length - doneCnt) / WORKERS / 60000;   // 粗估：本次每段平均用时 × 剩余段数 ÷ 并行数
      console.log(`[W${wi}] 分段 ${k + 1} 完成，进度 ${doneCnt}/${segs.length}，已用 ${((Date.now() - tStart) / 60000).toFixed(1)} 分钟，预计还要约 ${Math.ceil(eta)} 分钟`);
    }
    if (ctx) {
      if (ctx.logs.length) console.log(`[W${wi}] 页面警告:\n` + [...new Set(ctx.logs)].slice(0, 20).join('\n'));
      await ctx.browser.close();
    }
  };
  console.log(`共 ${segs.length} 段，已完成 ${doneCnt} 段，${WORKERS} 路并行`);
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  srv.close();
  const list = path.join(chunkDir, 'list.txt');
  fs.writeFileSync(list, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  const outV = path.join(PJ.build, t1s ? `片段_${t0s}_${t1s}.mp4` : 'video_noaudio.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outV], { stdio: 'inherit' });
  console.log(`完成：${outV}  用时 ${((Date.now() - tStart) / 60000).toFixed(1)} 分钟`);
  return outV;
}

// ---------- 抽帧检查（直接从引擎出单帧 PNG，不用渲染整片） ----------
async function checkFrames(times) {
  const dir = path.join(PJ.build, 'check');
  fs.mkdirSync(dir, { recursive: true });
  const srv = await startServer();
  const { browser, page, logs } = await openPage(srv.address().port);
  const t0 = Date.now();
  for (const t of times) {
    const b64 = await page.evaluate(tt => window.framePNG(tt), t);
    const f = path.join(dir, `f_${t.toFixed(2).padStart(7, '0')}.png`);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    console.log(f);
  }
  console.log(`抽帧 ${times.length} 张，耗时 ${Date.now() - t0} ms`);
  const missing = await page.evaluate(() => window.getMissing());
  if (missing.length) console.log('缺失资源:', missing.join(', '));
  if (logs.length) console.log('页面警告:\n' + [...new Set(logs)].slice(0, 30).join('\n'));
  await browser.close(); srv.close();
}

// ---------- 导出音效事件表（给 make_audio.py 合成音效轨） ----------
async function exportSfx() {
  const srv = await startServer();
  const { browser, page } = await openPage(srv.address().port);
  const list = await page.evaluate(() => window.getSfx());
  const f = path.join(PJ.build, 'sfx_events.json');
  fs.writeFileSync(f, JSON.stringify(list, null, 0));
  const kinds = {};
  for (const s of list) kinds[s.name] = (kinds[s.name] || 0) + 1;
  console.log(`已导出 ${list.length} 个音效事件 → ${f}\n`, kinds);
  const sp = await page.evaluate(() => window.getSamples());    // 音频采样（游戏原声、实机原声）+ 配乐闪避
  fs.writeFileSync(path.join(PJ.build, 'samples.json'), JSON.stringify(sp, null, 0));
  console.log(`已导出 ${sp.samples.length} 个采样事件、${sp.ducks.length} 段配乐闪避 → samples.json`);
  await browser.close(); srv.close();
}

// ---------- 抽取实机片段帧（project.json 的 clips → 中间文件/clips/<键名>/f_00001.jpg…，30 帧/秒） ----------
function extractClips() {
  const clips = PJ.cfg.clips || {};
  const keys = Object.keys(clips);
  if (!keys.length) { console.log('project.json 里没有 clips'); return; }
  for (const k of keys) {
    const c = clips[k], dir = path.join(PJ.build, 'clips', k), sig = JSON.stringify(c);
    const mark = path.join(dir, 'done.json');
    if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === sig) { console.log(`[${k}] 已是最新，跳过`); continue; }
    fs.rmSync(dir, { recursive: true, force: true });           // 只清本工具生成的帧目录
    fs.mkdirSync(dir, { recursive: true });
    const vf = [c.crop ? `crop=${c.crop[2]}:${c.crop[3]}:${c.crop[0]}:${c.crop[1]}` : null, `fps=${FPS}`].filter(Boolean).join(',');   // crop 按 [x,y,w,h] 写
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(c.ss), '-i', path.join(PJ.dir, c.file), '-t', String(c.dur),
      '-vf', vf, '-q:v', '2', path.join(dir, 'f_%05d.jpg')], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`[${k}] 抽帧失败`);
    fs.writeFileSync(mark, sig);
    console.log(`[${k}] ${fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length} 帧`);
  }
}

// ---------- 出片（按出片格式标准：渲染母版 + 混音 → 横版缩到 720P、竖版不缩）：无字幕版（导入剪映用）；有字幕的项目再出一版烧好字幕的 ----------
function encodeFinal(v, a, out, subs = '') {
  const t0 = Date.now();
  const size = EXPORT[PJ.cfg.orientation];
  const vf = [size ? `scale=${size[0]}:${size[1]}:flags=lanczos` : '', subs].filter(Boolean).join(',');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-stats', '-stats_period', '15', '-y', '-i', v, '-i', a, '-map', '0:v', '-map', '1:a',
    ...(vf ? ['-vf', vf] : []), ...X264_STD, '-r', String(FPS), ...AUDIO_STD, '-shortest', '-movflags', '+faststart', out],
  { stdio: 'inherit', cwd: PJ.build });                         // 在中间文件目录里跑：字幕滤镜用相对路径，免转义
  if (r.status !== 0) throw new Error(`${path.basename(out)} 出片失败，退出码 ${r.status}`);
  console.log(`完成：${out}  用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
}
function exportFinal() {
  const v = path.join(PJ.build, 'video_noaudio.mp4'), a = path.join(PJ.build, 'mix.wav');
  for (const f of [v, a]) if (!fs.existsSync(f)) throw new Error('缺少 ' + f + '（先渲染全片、做完混音）');
  const n = outSeq() + 1;                                     // 新序号 = 已有最大序号 + 1，两版同号
  encodeFinal(v, a, outFile(n));
  if (!PJ.cfg.subs) return;
  fs.copyFileSync(path.join(PJ.dir, PJ.cfg.subs), path.join(PJ.build, 'burn.srt'));   // 拷成简单文件名，免得路径里的特殊字符要转义
  const fd = SUB_FONT_DIR.replace(/\\/g, '/').replace(/:/g, '\\:');   // 字体目录用绝对路径（skill 和工作目录可能不在同一个盘），盘符冒号要转义
  encodeFinal(v, a, subFile(n), `subtitles=burn.srt:fontsdir='${fd}':force_style='${SUB_STYLE[PJ.cfg.orientation]}'`);
}

// ---------- 成片质检：流信息 + 时长核对 + 全屏图片出现前后抽帧 + 均匀抽帧，拼成 3x3 总览图 ----------
async function qaFinal() {
  const srv = await startServer();
  const { browser, page } = await openPage(srv.address().port);
  const shows = await page.evaluate(() => window.getImageShows());
  const dur = await page.evaluate(() => window.DURATION);
  const clipSec = await page.evaluate(() => window.getClipSeconds());
  await browser.close(); srv.close();
  if (clipSec > 0) console.log(`实机画面在屏 ${clipSec.toFixed(1)} 秒，占全片 ${(clipSec / dur * 100).toFixed(1)}%`);
  if (!outSeq()) { console.log('没有找到成片，请先出片'); return; }
  const n = outSeq();                                         // 质检序号最大的那版（两版都核流信息和时长）
  for (const f of [outFile(n), subFile(n)].filter(f => fs.existsSync(f))) {
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height,r_frame_rate,sample_rate,channels', '-of', 'compact', f], { encoding: 'utf8' });
    const d = Number((p.stdout.match(/duration=([\d.]+)/) || [])[1]);
    const mb = Number((p.stdout.match(/size=(\d+)/) || [])[1]) / 1048576;
    console.log(`== ${path.basename(f)}  ${mb.toFixed(1)} MB  时长 ${d} 秒（工程 ${dur.toFixed(3)}，差 ${(d - dur).toFixed(3)}）\n${p.stdout.trim()}`);
  }
  const src = fs.existsSync(subFile(n)) ? subFile(n) : outFile(n);   // 抽帧用带字幕版（同时看字幕清不清楚）
  const pts = [];
  for (const s of shows) {                                    // 每张图：出现前、刚出现、快结束、结束后
    pts.push([s.t0 - 0.1, `${s.key} before`], [s.t0 + 0.1, `${s.key} in`], [s.t1 - 0.1, `${s.key} end`], [s.t1 + 0.1, `${s.key} after`]);
  }
  for (let k = 1; k <= QA_SPOTS; k++) pts.push([dur * k / (QA_SPOTS + 1), 'spot']);
  const dir = path.join(PJ.build, 'qa');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.png')) fs.unlinkSync(path.join(dir, f));
  pts.forEach(([t, tag], i) => {
    const label = `${t.toFixed(2)}s ${tag}`.replace(/[':\\]/g, ' ');   // drawtext 里去掉会被当成语法的字符
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1',
      '-vf', `scale=${PJ.cfg.orientation === '竖版' ? '360:640' : '640:360'},drawtext=fontfile='NotoSansSC-Bold.ttf':text='${label}':fontsize=26:fontcolor=yellow:box=1:boxcolor=black@0.6:x=10:y=10`,
      path.join(dir, `q_${String(i).padStart(3, '0')}.png`)], { stdio: 'inherit', cwd: SUB_FONT_DIR });   // 在字体目录里跑：drawtext 读不了带中文的字体路径
  });
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, 'q_%03d.png'), '-vf', 'tile=3x3:padding=4',
    path.join(dir, 'sheet_%02d.png')], { stdio: 'inherit' });
  console.log(`抽帧 ${pts.length} 张（来源 ${path.basename(src)}），总览图：${dir}\\sheet_*.png`);
}

async function main() {
  console.log(`==== 动画工具（工作目录：${WORK}）====
9. 文稿转字幕（要念的台词稿或整篇文稿；有超 30 字的先只在顶层出清单；没有或用户明确不改，才出 工程文件/ 初版 SRT，导入剪映配音、对轴用）
0. 初始化项目（配音 + SRT 放好后 → 生成配置和空场景文件；无配音项目直接初始化；已有稿就复制成下一稿）
1. 渲染全片（并行，中断后可续渲）
2. 渲染片段（输入起止秒）
3. 抽帧检查（输入时间点）
4. 导出音效事件表
5. 出片（横版 720P、竖版 1080×1920：无字幕版；有字幕的项目同时出 _字幕 版）
6. 启动预览服务器
7. 成片质检
8. 抽取实机片段帧（project.json 的 clips）
（配乐、音效、混音：在工作目录里运行 audio/make_audio.py）`);
  const ch = await ask('请选择: ');
  if (ch === '9') await txtToSrt();
  else if (ch === '0') { await initProject(); }
  else if ('12345678'.includes(ch) && ch) {
    loadProject();
    if (ch === '1') await renderAll();
    else if (ch === '2') { const [a, b] = (await ask('起止秒(如 0,30): ')).split(',').map(Number); await renderAll(a, b); }
    else if (ch === '3') { const ts = (await ask('时间点(场景脚本里的时间，逗号分隔): ')).split(',').map(Number).filter(v => !isNaN(v)); await checkFrames(ts); }
    else if (ch === '4') await exportSfx();
    else if (ch === '5') exportFinal();
    else if (ch === '6') {
      await startServer(8765);
      console.log(`预览地址: http://127.0.0.1:8765/  （项目：${PJ.name}）\n【预览已启动】会一直开着，看完马上关掉（Ctrl+C 或结束这个进程）`);
      return;
    }
    else if (ch === '7') await qaFinal();
    else if (ch === '8') extractClips();
  }
  if (rl) rl.close();
  console.log(END_MARK);
  process.exit(0);
}
main().catch(e => { console.error(e); console.error(`${ERR_MARK} ${e.message}`); process.exit(1); });
