// ================= 动画工具（菜单启动）：文本转 UTF-8 / 文稿转字幕 / 配音字幕预览 / 初始化项目 / 并行渲染 / 抽帧检查 / 改动预览图 / 导出音效表 / 出片 / 预览 / 成片质检 / 出封面 =================
// 在用户工作目录里运行（cd 过去再 node <本脚本>）：工作目录 = 一条视频，用户只准备 文稿（任何格式）和素材；
// 要给用户看的（超长字幕清单、配音字幕预览、改动预览图、成片、封面）放工作目录顶层，其余都放 工程文件/：各稿通用的（开场核对、进度记录、初版 SRT、剪映导出的配音和 SRT）放 工程文件/ 下，随稿变化的（动画大纲、project.json、AI 写的字幕、场景脚本/、中间文件/）放 工程文件/第N稿文件/
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
import { srtToPortraitAss } from './portrait_subs.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.cwd();                                    // 用户工作目录（运行时所在目录）
const ENG_DIR = '工程文件';                                     // 工作目录里放不给用户看的文件的子目录
const ENG = path.join(WORK, ENG_DIR);
const SCENE_DIR = '场景脚本', BUILD_DIR = '中间文件';             // 每稿目录里由工具生成的两个子目录
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac'];
const DRAFT_TAG = '_初版';                                       // 文稿转字幕生成的初版 SRT 的文件名后缀
const notDraft = f => !path.parse(f).name.endsWith(DRAFT_TAG);   // 找对齐好的字幕时，初版 SRT 不算
const LONG_FILE = `超过每行${WARN_LEN}个字的字幕.txt`;               // 超长清单的文件名（放工作目录顶层）
const END_MARK = '【结束】', ERR_MARK = '【出错】';                 // 程序最后一行打印其中一个，调用方只认这两个判断跑完没有
const CHECK_FILE = '开场核对.json';                              // 开场核对结果（在 工程文件/ 里），菜单 9 从这里取要转字幕的稿：voiceScript（要念的文字稿），没有就用 script（整篇文稿，只认 TXT）
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FPS = 30;
const WORKERS = 2;                                            // 并行渲染进程数（内存紧张，取 2）
const SEG_FRAMES = 900;                                       // 每个分段帧数（30 秒）
const JPEG_Q = 0.95;
// 出片格式标准（详见 references/视频动画出片格式标准.md）：横版 6 分钟以内 1080P、超过 720P，竖版 1080×1920；30 帧、x264 slow + 动画优化 + CRF 23、AAC 256k
const CANVAS = { 横版: [1920, 1080], 竖版: [1080, 1920] };      // 母版画布（project.json 的 orientation）
const SMALL_AFTER = 360;                                      // 横版成片超过这么多秒就缩到 720P（控制体积，免得平台二次压缩）；不超过的不缩，出 1080P
const SMALL_SIZE = [1280, 720];
const X264_STD = ['-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation', '-crf', '23', '-pix_fmt', 'yuv420p'];
const AUDIO_STD = ['-c:a', 'aac', '-b:a', '256k'];
const PREVIEW_FILE = '配音字幕预览.mp4';                          // 第 4 步对齐后给用户看的预览（放顶层）；只有配音没经过剪映的 B 才出，A1、A2 让用户在剪映草稿里看
const PREVIEW_SIZE = { 横版: [1280, 720], 竖版: [720, 1280] };    // 预览只看字幕和配音对不对得上，小画面出得快；字幕随画面等比缩放，样子和成片一样
const PREVIEW_X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p'];
const CHANGE_TAG = '改动预览';                                  // 按用户意见改了画面后给用户看的预览图：顶层 <第X稿>改动预览_<标题>.png（第 9 步清理会删，名字要和 clean.mjs 一致）
const CHANGE_COLS = { 横版: 2, 竖版: 4 };                        // 改动预览图每行几张（每张按画布一半大小）
const COVER_SIZES = { '16比9': [1920, 1080], '4比3': [1440, 1080], '3比4': [1080, 1440] };   // 封面比例和像素（第 7 步，见 references/做封面.md）
const COVER_DIR = '封面', COVER_JS = '封面.js';                 // 封面脚本：当前稿目录/封面/封面.js（菜单 0 复制下一稿时跟着带过去）
const COVER_MAX = 2 * 1024 * 1024;                            // 封面上限 2MB（YouTube 的限制，三个平台都按它）
const COVER_Q = [0.92, 0.87, 0.82, 0.77, 0.72];               // 封面 JPG 质量，超过上限就往下降一档
const QA_SPOTS = 9;                                           // 质检时全片均匀抽帧张数
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.srt': 'text/plain; charset=utf-8', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' };

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
// 字号、描边、边距按 libass 默认 288 行高换算（字号随画面高度缩放）：横版 21.33 ≈ 720P 画面 53 像素、1080P 画面 80 像素（实测一个字约 55 像素宽，
// 30 个字一行 1654 像素；白字上沿 y 931、下沿 y 982，含描边 y 924～989；字的下沿离底 97 由 MarginV=23 定（按剪映草稿里的字幕位置定的，参数只有整数档，98 取不到）；
// 一行容许宽 1710 像素由 MarginL=MarginR=21 定（左右各空 105），31 个字一行放得下、32 个字折两行）；
// 竖版不走这套：先用 portrait_subs.mjs 转成 ASS（自己折行、每行单独定位，行距才能做到 60），样式写在 ASS 里
const SUB_FONT_DIR = path.join(ROOT, 'fonts');
const SUB_FONT = path.join(SUB_FONT_DIR, 'NotoSansSC-Bold.ttf');   // 竖版折行量字宽用，和烧字幕是同一个字体
const SUB_STYLE = 'FontName=Noto Sans SC,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Shadow=0,FontSize=21.33,Outline=1.65,MarginV=23,MarginL=21,MarginR=21';   // 横版

// ---------- 文本编码：用户给的文本不一定是 UTF-8（记事本存的 ANSI 即 GBK、UTF-16），先转成 UTF-8 再用，原件备份 ----------
const TEXT_EXT = ['.txt', '.md', '.srt', '.csv'];
const BACKUP_DIR = '原编码备份';                                 // 转换前的原件放 工程文件/原编码备份/（保持原来的相对路径）
let ANSI = null;
function ansiEncoding() {                                     // 系统 ANSI 编码（记事本「ANSI」存的就是它）：简体中文 Windows 是 936，即 GBK
  if (ANSI) return ANSI;
  const r = spawnSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], { encoding: 'utf8' });
  const cp = ((r.stdout || '').match(/ACP\s+REG_SZ\s+(\d+)/) || [])[1];
  if (!cp) throw new Error('读不出系统的 ANSI 编码（注册表 Nls\\CodePage 的 ACP）');
  const label = { 936: 'gb18030', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr' }[cp] || `windows-${cp}`;
  ANSI = { label, name: { 936: 'GBK', 950: 'Big5', 932: 'Shift-JIS', 949: 'EUC-KR' }[cp] || `ANSI ${cp}` };
  return ANSI;
}
function decodeText(buf, rel) {                               // → {text, enc}；enc 为 null 表示本来就是 UTF-8（带不带 BOM 都算，BOM 自动去掉）
  if (buf[0] === 0xFF && buf[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), enc: 'UTF-16' };
  if (buf[0] === 0xFE && buf[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), enc: 'UTF-16' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), enc: null }; } catch { /* 不是 UTF-8，按系统 ANSI 编码解 */ }
  const a = ansiEncoding();
  try { return { text: new TextDecoder(a.label, { fatal: true }).decode(buf), enc: a.name }; }
  catch { throw new Error(`${rel} 认不出编码（不是 UTF-8、UTF-16，也不是系统的 ${a.name}）`); }
}
function toUtf8(rel) {                                        // 不是 UTF-8 就原地转成 UTF-8（先备份原件），返回原来的编码；本来就是 UTF-8 返回 null
  const f = path.join(WORK, rel);
  const { text, enc } = decodeText(fs.readFileSync(f), rel);
  if (!enc) return null;
  const bak = path.join(ENG, BACKUP_DIR, rel);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);           // 已有备份不覆盖，留最早的原件
  fs.writeFileSync(f, text);
  console.log(`已转成 UTF-8：${rel}（原来是 ${enc}，原件备份在 ${ENG_DIR}/${BACKUP_DIR}/）`);
  return enc;
}
// 菜单 10：工作目录顶层和一级子目录（工程文件/ 除外）里的文本文件，不是 UTF-8 的都转成 UTF-8
function textsToUtf8() {
  let n = 0;
  for (const sub of ['', ...fs.readdirSync(WORK).filter(d => d !== ENG_DIR && fs.statSync(path.join(WORK, d)).isDirectory())]) {
    for (const f of fs.readdirSync(path.join(WORK, sub))) {
      const rel = sub ? `${sub}/${f}` : f;
      if (TEXT_EXT.includes(path.extname(f).toLowerCase()) && fs.statSync(path.join(WORK, rel)).isFile() && toUtf8(rel)) n++;
    }
  }
  console.log(n ? `共转换 ${n} 个文件` : '文本文件都已是 UTF-8，不用转换');
}

// 文稿转字幕：要念的稿（开场核对记录的 voiceScript 文字稿：非口播类的台词稿，或口播类文稿不是 TXT 时 AI 提取的文字版；没有就用整篇文稿 script，只认 TXT）一行一条 → 有超长先只出顶层 超过每行30个字的字幕.txt（给用户看）；
// 没有超长或用户明确不改，才出 工程文件/<稿名>_初版.srt（时间是占位的，导入剪映配音后再对轴）
async function txtToSrt() {
  const ck = path.join(ENG, CHECK_FILE), ckRel = `${ENG_DIR}/${CHECK_FILE}`;
  if (!fs.existsSync(ck)) throw new Error(`没有 ${ckRel}：先完成开场核对`);
  const ckv = JSON.parse(fs.readFileSync(ck, 'utf8'));
  const txt = ckv.voiceScript || ckv.script;
  if (!txt) throw new Error(`${ckRel} 里没有文稿（无文稿分支不用菜单 9）`);
  if (!fs.existsSync(path.join(WORK, txt))) throw new Error(`${ckRel} 记录的稿 ${txt} 不在工作目录里`);
  if (!ckv.voiceScript && path.extname(txt).toLowerCase() !== '.txt') throw new Error(`文稿 ${txt} 不是 TXT：先把全文提取成 ${ENG_DIR}/${path.parse(txt).name}_文字版.txt（UTF-8，一段一行），填进 ${ckRel} 的 voiceScript 再转`);
  console.log(`转字幕的稿：${txt}${ckv.voiceScript ? '（要念的文字稿）' : '（整篇文稿）'}`);
  toUtf8(txt);                                                // 用户改稿后可能又存成了别的编码
  const cues = txtToCues(decodeText(fs.readFileSync(path.join(WORK, txt)), txt).text);
  if (!cues.length) throw new Error(`${txt} 里没有文字`);
  const name = path.parse(txt).name;
  // 先查超长：超长字幕不拆，只列清单让用户自己改，用户明确不改才往下生成字幕；没有超长就不出清单，并删掉上一次留下的旧清单
  const long = cues.map((c, i) => ({ i: i + 1, w: width(c.text), text: c.text })).filter(c => c.w > WARN_LEN);
  const rep = path.join(WORK, LONG_FILE);
  if (long.length) {
    const lines = long.map(c => `第 ${c.i} 条（${c.w} 字）：${c.text}`);
    fs.writeFileSync(rep, [`超过 ${WARN_LEN} 字的有 ${long.length} 条（英文、数字按半个字算）。`, `建议修改文稿，控制每一行字幕在 ${WARN_LEN} 字以内，这是为了避免字幕一次性出现太多。`, '', ...lines].join('\r\n') + '\r\n');
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
function checkOrientation() {                                 // 开场核对记录的横竖版
  const ck = path.join(ENG, CHECK_FILE);
  if (!fs.existsSync(ck)) throw new Error(`没有 ${ENG_DIR}/${CHECK_FILE}：先完成开场核对`);
  const o = JSON.parse(fs.readFileSync(ck, 'utf8')).orientation;
  if (!CANVAS[o]) throw new Error(`${ENG_DIR}/${CHECK_FILE} 的 orientation 只能是 横版 或 竖版，现在是：${o}`);
  return o;
}
async function initDraft(d) {
  fs.mkdirSync(d.dir, { recursive: true });
  const orientation = checkOrientation();
  const dVoice = await findOne(d.dir, AUDIO_EXT, '配音');          // 非口播类：AI 按剧本把台词摆好位置拼成的配音，在本稿里
  const voice = dVoice || await findOne(ENG, AUDIO_EXT, '配音');   // 口播类：工程文件/ 里的配音（A1、B 对齐好的，A2 剪映导出的）
  const dSrt = await findOne(d.dir, ['.srt'], '字幕');             // AI 按剧本写在本稿里的字幕（无配音项目、非口播类）
  const srt = dSrt || (dVoice ? null : await findOne(ENG, ['.srt'], '字幕', notDraft));   // 口播类：工程文件/ 里的字幕（A1、B 对齐好的，A2 剪映导出的），各稿通用；非口播类只认本稿的
  const voiceFile = voice && path.join(dVoice ? d.dir : ENG, voice);
  let duration;
  if (voice) {
    duration = mediaDur(voiceFile);
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
  const cfg = {                                               // 配乐（music_file 或 music_py）、音效（sfx_files 或 sfx_py）由 AI 为这条视频自己做，做好再填
    name, orientation, duration: +duration.toFixed(3), ...(voice ? { voice: dVoice ? dr(voice) : eng(voice) } : {}), ...(srt ? { subs } : {}), images,
    scripts: [dr(`${SCENE_DIR}/s1.js`)],
  };
  fs.mkdirSync(path.join(d.dir, SCENE_DIR), { recursive: true });
  fs.mkdirSync(path.join(d.dir, BUILD_DIR), { recursive: true });
  fs.writeFileSync(path.join(d.dir, 'project.json'), JSON.stringify(cfg, null, 2));
  const stub = path.join(d.dir, SCENE_DIR, 's1.js');
  if (!fs.existsSync(stub)) fs.writeFileSync(stub, SCENE_STUB);
  console.log(`已初始化：${ENG_DIR}/${d.name}\n${orientation}，字幕 ${subs || '无'}，配音 ${voice ? cfg.voice : '无'}，时长 ${cfg.duration} 秒，图片 ${Object.keys(images).length} 张`);
  console.log(`下一步：按动画大纲写场景（${dr(SCENE_DIR)}/），配乐、音效做好后填进 ${dr('project.json')}（配乐 music_file 或 music_py，音效 sfx_files 或 sfx_py）`);
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

// 渲染版本指纹：引擎、项目配置、场景脚本、字幕、图片、第三方库、场景自己读的文件、实机片段任一变了，旧分段作废重渲（防止续渲把旧版画面拼进来）
function renderStamp() {
  const h = crypto.createHash('sha1');
  const eat = (f) => { if (fs.existsSync(f)) h.update(f).update(fs.readFileSync(f)); };
  const jsIn = (d) => fs.existsSync(d) ? fs.readdirSync(d).filter(n => n.endsWith('.js')).sort().map(n => path.join(d, n)) : [];
  const subs = PJ.cfg.subs ? [path.join(PJ.dir, PJ.cfg.subs)] : [];   // 场景按字幕时间 c(i) 排，字幕改了画面也要重渲
  const scripts = (PJ.cfg.scripts || []).map(s => path.join(PJ.dir, s));   // 场景脚本也可能放在 场景脚本/ 以外
  [path.join(engineDir(), 'index.html'), ...jsIn(path.join(engineDir(), 'js')), path.join(PJ.draft, 'project.json'), ...jsIn(path.join(PJ.draft, SCENE_DIR)), ...subs, ...scripts].forEach(eat);
  const filesIn = (f) => !fs.existsSync(f) ? [] : fs.statSync(f).isDirectory() ? fs.readdirSync(f).sort().flatMap(n => filesIn(path.join(f, n))) : [f];
  const libs = [...(PJ.cfg.libs || []).map(l => typeof l === 'string' ? l : l.src), ...Object.values(PJ.cfg.importmap || {})];
  for (const p of [...Object.values(PJ.cfg.images || {}), ...libs, ...(PJ.cfg.assets || [])]) {   // 图片、库、assets（文件或文件夹）只看大小和修改时间，不读内容
    if (/^https?:\/\//.test(p)) { h.update(p); continue; }    // 网上的库只认网址
    for (const f of filesIn(path.join(PJ.dir, p))) { const s = fs.statSync(f); h.update(`${f}|${s.size}|${s.mtimeMs}`); }
  }
  for (const k of Object.keys(PJ.cfg.clips || {})) eat(path.join(PJ.build, 'clips', k, 'done.json'));
  return h.digest('hex');
}

async function renderAll(t0s = 0, t1s = null) {
  if (PJ.cfg.voice) {                                         // 配音改过（重新生成某句、加减句子）duration 没跟着改：结尾会被截掉或多出一截
    const vd = mediaDur(path.join(PJ.dir, PJ.cfg.voice));
    if (Math.abs(vd - PJ.cfg.duration) > 1 / FPS) throw new Error(`配音长 ${vd.toFixed(3)} 秒，project.json 的 duration 是 ${PJ.cfg.duration} 秒，对不上：口播类把 duration 改成 ${vd.toFixed(3)}（视频和配音一样长）；非口播类重新拼本稿的配音，拼到和全片一样长（时长不变）`);
  }
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

// ---------- 改动预览图（菜单 12）：按用户意见改了画面后，把改动处的几帧拼成一张图放顶层，每帧上面写时间和说明，给用户看改对没有 ----------
async function changePreview() {
  const title = (await ask('标题（改了哪里，放进文件名，如 第59句）: ')).replace(/[\\/:*?"<>|\s]+/g, '');
  if (!title) throw new Error('要输入标题');
  console.log('逐行输入时间点：秒数 + 空格 + 这一帧的说明（场景脚本里的时间），空行结束');
  const pts = [];
  for (let line; (line = await ask('时间点: '));) {
    const m = line.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
    if (!m) throw new Error(`这行格式不对：${line}（要写成 秒数 空格 说明，如 148.2 看到第三段就停住）`);
    pts.push({ t: Number(m[1]), cap: m[2] });
  }
  if (!pts.length) throw new Error('没有输入时间点');
  const out = path.join(WORK, `${PJ.draftName.replace(/文件$/, '')}${CHANGE_TAG}_${title}.png`);
  const had = fs.existsSync(out);
  const srv = await startServer();
  const { browser, page, logs } = await openPage(srv.address().port);
  const b64 = await page.evaluate(async ({ pts, cols }) => {
    const cv = document.getElementById('cv'), CAP = 64;       // CAP：每帧上面写说明的那条的高度
    const fw = Math.round(cv.width / 2), fh = Math.round(cv.height / 2), n = Math.min(cols, pts.length);
    const sheet = document.createElement('canvas');
    sheet.width = fw * n; sheet.height = (fh + CAP) * Math.ceil(pts.length / n);
    const g = sheet.getContext('2d');
    g.fillStyle = '#151515'; g.fillRect(0, 0, sheet.width, sheet.height);
    await document.fonts.load('bold 30px "Noto Sans SC"');
    for (const [i, p] of pts.entries()) {
      await window.framePNG(p.t);                              // 这一帧画到画布上（返回的 PNG 不用）
      const x = (i % n) * fw, y = Math.floor(i / n) * (fh + CAP);
      g.drawImage(cv, x, y + CAP, fw, fh);
      const ds = Math.round(p.t * 10);                         // 按 0.1 秒取整再拆分秒，免得 59.96 写成 0:60.0
      const label = `${Math.floor(ds / 600)}:${((ds % 600) / 10).toFixed(1).padStart(4, '0')} ${p.cap}`.trim();
      let size = 30;
      do g.font = `bold ${size}px "Noto Sans SC"`; while (g.measureText(label).width > fw - 24 && --size > 14);   // 说明太长就缩小字号
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, x + fw / 2, y + CAP / 2);
      g.strokeStyle = '#000'; g.lineWidth = 4; g.strokeRect(x, y, fw, fh + CAP);   // 格子之间的分隔线
    }
    return sheet.toDataURL('image/png').slice(22);
  }, { pts, cols: CHANGE_COLS[PJ.cfg.orientation] });
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`改动预览图（${pts.length} 帧）：${out}${had ? '（换掉了同名的旧图）' : ''}`);
  const missing = await page.evaluate(() => window.getMissing());
  if (missing.length) console.log('缺失资源:', missing.join(', '));
  if (logs.length) console.log('页面警告:\n' + [...new Set(logs)].slice(0, 30).join('\n'));
  await browser.close(); srv.close();
}

// ---------- 封面（第 7 步）：当前稿的 封面/封面.js 按输入的比例各画一张，出到顶层 <片名>_封面_<比例>.jpg ----------
// 封面脚本在动画页面里、所有场景脚本之后加载，提供 drawCover(g, w, h, size)：画布已换成这个比例的尺寸（w×h），场景脚本里的函数、图片都能用
// 不放进 project.json、场景脚本/：改封面不会让已渲好的画面作废
async function exportCovers() {
  const names = Object.keys(COVER_SIZES).join('、');
  const sizes = (await ask(`封面比例（逗号分隔，可选 ${names}）: `)).split(/[,，、\s]+/).filter(Boolean);
  if (!sizes.length) throw new Error(`要输入封面比例，如 4比3,3比4（可选 ${names}）`);
  const bad = sizes.filter(s => !COVER_SIZES[s]);
  if (bad.length) throw new Error(`认不出的比例：${bad.join('、')}（只能是 ${names}）`);
  const sp = path.join(PJ.draft, COVER_DIR, COVER_JS);
  if (!fs.existsSync(sp)) throw new Error(`封面脚本不存在：${sp}`);
  const srv = await startServer();
  const { browser, page, logs } = await openPage(srv.address().port);
  await page.evaluate(() => window.framePNG(0));               // 先走一帧，图片、字体都备好
  await page.addScriptTag({ content: fs.readFileSync(sp, 'utf8') });
  if (!await page.evaluate(() => typeof drawCover === 'function'))   // 脚本加载出错（如和场景脚本重名）也会走到这里，带上页面报错
    throw new Error(`封面脚本没加载成功，或里面没有 drawCover(g, w, h, size) 函数：${sp}${logs.length ? '\n页面报错:\n' + [...new Set(logs)].join('\n') : ''}`);
  for (const size of sizes) {
    const [w, h] = COVER_SIZES[size];
    await page.evaluate(async ({ w, h, size }) => {
      const cv = document.getElementById('cv');
      cv.width = w; cv.height = h;                               // 换成封面尺寸（画布状态跟着重置）
      const g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
      await drawCover(g, w, h, size);
    }, { w, h, size }).catch(e => { throw new Error(`画 ${size} 封面出错：${e.message}`); });
    let buf = null, q = 0;
    for (q of COVER_Q) {
      const b64 = await page.evaluate((qq) => document.getElementById('cv').toDataURL('image/jpeg', qq).slice(23), q);
      buf = Buffer.from(b64, 'base64');
      if (buf.length <= COVER_MAX) break;
    }
    const out = path.join(WORK, `${PJ.cfg.name}_封面_${size}.jpg`);
    const had = fs.existsSync(out);
    fs.writeFileSync(out, buf);
    const over = buf.length > COVER_MAX ? `，降到最低质量还是超过 ${COVER_MAX / 1048576}MB，画面细碎的纹理要减少` : '';
    console.log(`封面 ${size}（${w}×${h}）：${out}  ${(buf.length / 1048576).toFixed(2)}MB，质量 ${q}${had ? '（换掉了同名的旧图）' : ''}${over}`);
  }
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

// ---------- 出片（按出片格式标准：渲染母版 + 混音 → 横版超过 6 分钟缩到 720P，其余不缩）：无字幕版（导入剪映用）；有字幕的项目再出一版烧好字幕的 ----------
function mediaDur(f) {                                        // ffprobe 读媒体时长（秒），读不出返回 NaN
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' });
  return Number((r.stdout || '').trim());
}
function encodeFinal(v, a, out, size, subs = '') {            // size：缩放到的 [宽, 高]，null 不缩
  const t0 = Date.now();
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
  const dur = mediaDur(v);
  if (!(dur > 0)) throw new Error('读不出母版时长: ' + v);
  const size = PJ.cfg.orientation === '横版' && dur > SMALL_AFTER ? SMALL_SIZE : null;   // 竖版、6 分钟以内的横版都不缩
  console.log(`全片 ${dur.toFixed(1)} 秒，成片 ${(size || CANVAS[PJ.cfg.orientation]).join('×')}`);
  const n = outSeq() + 1;                                     // 新序号 = 已有最大序号 + 1，两版同号
  encodeFinal(v, a, outFile(n), size);
  if (!PJ.cfg.subs) return;
  const burn = burnFile(path.join(PJ.dir, PJ.cfg.subs), PJ.build, 'burn', PJ.cfg.orientation);
  encodeFinal(v, a, subFile(n), size, subFilter(burn, PJ.cfg.orientation));
}
// 烧字幕用的文件：横版把 SRT 的每条并成一行存成 <base>.srt，竖版转成 <base>.ass；都放 dir 里、用简单文件名，免得路径里的特殊字符要转义；返回文件名
function burnFile(srt, dir, base, orientation) {
  const txt = fs.readFileSync(srt, 'utf8');
  if (orientation === '竖版') {
    fs.writeFileSync(path.join(dir, `${base}.ass`), srtToPortraitAss(txt, SUB_FONT));
    return `${base}.ass`;
  }
  fs.writeFileSync(path.join(dir, `${base}.srt`), landscapeSrt(txt));
  return `${base}.srt`;
}
// 横版字幕只放一行：一行放得下 30 个字、不会拆词，字幕区（底部留空 160）也只够一行；字幕里手动换的行并成一行（两边都是英文数字时中间补空格）
function landscapeSrt(txt) {
  return txt.replace(/^﻿/, '').replace(/\r/g, '').split(/\n\s*\n/).map(blk => {
    const ls = blk.split('\n'), k = ls.findIndex(l => l.includes('-->'));
    if (k < 0) return blk;
    const text = ls.slice(k + 1).map(l => l.trim()).filter(Boolean)
      .reduce((a, l) => a + (/[\x21-\x7e]$/.test(a) && /^[\x21-\x7e]/.test(l) ? ' ' : '') + l, '');
    return [...ls.slice(0, k + 1), text].join('\n');
  }).join('\n\n') + '\n';
}
function subFilter(file, orientation) {                       // 烧字幕滤镜：file 是 ffmpeg 运行目录里的简单文件名
  const fd = SUB_FONT_DIR.replace(/\\/g, '/').replace(/:/g, '\\:');   // 字体目录用绝对路径（skill 和工作目录可能不在同一个盘），盘符冒号要转义
  return orientation === '竖版' ? `subtitles=${file}:fontsdir='${fd}'` : `subtitles=${file}:fontsdir='${fd}':force_style='${SUB_STYLE}'`;
}

// ---------- 配音字幕预览（菜单 11）：第 4 步对齐后（只有 B），深灰底 + 烧好的字幕 + 配音合成一个视频放顶层，给用户看字幕和配音对不对得上 ----------
// 配音、字幕取 工程文件/ 里的（A1、B 对齐好的，A2 剪映导出的），和菜单 0 初始化口播类时找的一样
async function previewVoice() {
  const orientation = checkOrientation();
  const voice = await findOne(ENG, AUDIO_EXT, '配音'), srt = await findOne(ENG, ['.srt'], '字幕', notDraft);
  if (!voice || !srt) throw new Error(`${ENG_DIR}/ 里要有对齐好的配音和字幕（.srt，初版不算）：A1 先跑 draft.py 菜单 3，A2、B 要用户把剪映导出的放进来`);
  const dur = mediaDur(path.join(ENG, voice));
  if (!(dur > 0)) throw new Error('读不出配音时长: ' + voice);
  const out = path.join(WORK, PREVIEW_FILE);
  if (fs.existsSync(out) && (await ask(`${PREVIEW_FILE} 已存在，覆盖吗？（输入 y 覆盖，其他取消）: `)) !== 'y') { console.log('已取消'); return; }
  const n = fs.readFileSync(path.join(ENG, srt), 'utf8').split('-->').length - 1;
  console.log(`配音：${ENG_DIR}/${voice}（${dur.toFixed(1)} 秒）\n字幕：${ENG_DIR}/${srt}（${n} 条）\n开始合成预览…`);
  const tmp = burnFile(path.join(ENG, srt), ENG, 'preview_burn', orientation);   // 用完删掉
  const [w, h] = PREVIEW_SIZE[orientation];
  const r = spawnSync('ffmpeg', ['-v', 'error', '-stats', '-stats_period', '15', '-y', '-f', 'lavfi', '-i', `color=c=0x202020:s=${w}x${h}:r=${FPS}:d=${dur}`,
    '-i', voice, '-map', '0:v', '-map', '1:a', '-vf', subFilter(tmp, orientation), ...PREVIEW_X264, ...AUDIO_STD, '-shortest', '-movflags', '+faststart', out],
  { stdio: 'inherit', cwd: ENG });
  fs.unlinkSync(path.join(ENG, tmp));
  if (r.status !== 0) throw new Error(`${PREVIEW_FILE} 合成失败，退出码 ${r.status}`);
  console.log(`已生成：${out}`);
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
  const keep = pts.filter(([t]) => t >= 0 && t < dur - 0.5 / FPS);   // 片头之前、最后一帧之后抽不到帧，这些点跳过
  const dir = path.join(PJ.build, 'qa');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.png')) fs.unlinkSync(path.join(dir, f));
  let got = 0;                                                // 按实际抽到的图连续编号：编号一断，拼总览图就停在断的地方，后面的图都拼不进去
  for (const [t, tag] of keep) {
    const label = `${t.toFixed(2)}s ${tag}`.replace(/[':\\]/g, ' ');   // drawtext 里去掉会被当成语法的字符
    const out = path.join(dir, `q_${String(got).padStart(3, '0')}.png`);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1',
      '-vf', `scale=${PJ.cfg.orientation === '竖版' ? '360:640' : '640:360'},drawtext=fontfile='NotoSansSC-Bold.ttf':text='${label}':fontsize=26:fontcolor=yellow:box=1:boxcolor=black@0.6:x=10:y=10`,
      out], { stdio: 'inherit', cwd: SUB_FONT_DIR });         // 在字体目录里跑：drawtext 读不了带中文的字体路径
    if (fs.existsSync(out)) got++;
  }
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, 'q_%03d.png'), '-vf', 'tile=3x3:padding=4',
    path.join(dir, 'sheet_%02d.png')], { stdio: 'inherit' });
  const skip = pts.length - got;
  console.log(`抽帧 ${got} 张（来源 ${path.basename(src)}）${skip ? `，${skip} 个点在片头之前、片尾之后或没抽到，已跳过` : ''}，总览图：${dir}\\sheet_*.png`);
}

async function main() {
  console.log(`==== 动画工具（工作目录：${WORK}）====
10. 文本转 UTF-8（第 1 步先跑：工作目录里用户给的 txt、md、srt、csv 不是 UTF-8 的都转成 UTF-8，原件备份到 工程文件/${BACKUP_DIR}/）
9. 文稿转字幕（要念的文字稿或整篇 TXT 文稿；有超 30 字的先只在顶层出清单；没有或用户明确不改，才出 工程文件/ 初版 SRT，导入剪映配音、对轴用）
11. 配音字幕预览（只有 B 现成配音：对齐后用 工程文件/ 里对齐好的配音和字幕，在顶层出 ${PREVIEW_FILE} 给用户看；A1、A2 在剪映草稿里看）
0. 初始化项目（配音 + SRT 放好后 → 生成配置和空场景文件；无配音项目直接初始化；已有稿就复制成下一稿）
1. 渲染全片（并行，中断后可续渲）
2. 渲染片段（输入起止秒）
3. 抽帧检查（输入时间点）
12. 改动预览图（按用户意见改了画面后：输入标题和改动处的时间点，拼成一张图放顶层 第X稿${CHANGE_TAG}_<标题>.png 给用户看）
4. 导出音效事件表
5. 出片（横版 6 分钟以内 1080P、超过 720P，竖版 1080×1920：无字幕版；有字幕的项目同时出 _字幕 版）
6. 启动预览服务器
7. 成片质检
8. 抽取实机片段帧（project.json 的 clips）
13. 出封面（输入比例：当前稿 ${COVER_DIR}/${COVER_JS} 每个比例画一张，出到顶层 <片名>_封面_<比例>.jpg）
（配乐、音效、混音：在工作目录里运行 audio/make_audio.py）`);
  const ch = await ask('请选择: ');
  if (ch === '10') textsToUtf8();
  else if (ch === '9') await txtToSrt();
  else if (ch === '11') await previewVoice();
  else if (ch === '0') { await initProject(); }
  else if (['1', '2', '3', '4', '5', '6', '7', '8', '12', '13'].includes(ch)) {
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
    else if (ch === '12') await changePreview();
    else if (ch === '13') await exportCovers();
  }
  if (rl) rl.close();
  console.log(END_MARK);
  process.exit(0);
}
main().catch(e => { console.error(e); console.error(`${ERR_MARK} ${e.message}`); process.exit(1); });
