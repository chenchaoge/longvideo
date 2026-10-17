// ================= 清理中间文件和临时文件（菜单启动）：1 统计可清理的文件（只看不删） / 2 清理 =================
// 在用户工作目录里运行（cd 过去再 node <本脚本>）：只管运行时所在的这一个工作目录（一条视频），不碰别的项目；有几个项目就到各自的工作目录各跑一次
// 只看三处：
// - 工程文件/第X稿文件/中间文件/：只删按名字认得出的工具生成文件（render.mjs、audio/make_audio.py 出片时生成的）
// - 工程文件/临时文件/：AI 做这条视频时放的一次性文件，里面的都删（文件夹本身留着）
// - 顶层的改动预览图 第X稿改动预览_<标题>.png（render.mjs 菜单 12 出的）
// 认不出的文件、链接（和含链接的文件夹）都不动；用脚本删、不让 AI 自己删，是怕删错、删多；顶层有成片（项目做完）才让删
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const WORK = process.cwd();                                    // 用户工作目录（运行时所在目录）= 本次只管的这一个项目
const ENG_DIR = '工程文件', BUILD_DIR = '中间文件';             // 与 render.mjs 一致
const ENG = path.join(WORK, ENG_DIR);
const DRAFT_RE = /^第[一二三四五六七八九十]+稿文件$/;           // 稿目录：第一稿文件、第二稿文件…（与 render.mjs 的 draftOf 一致）
const END_MARK = '【结束】', ERR_MARK = '【出错】';                 // 程序最后一行打印其中一个，调用方只认这两个判断跑完没有
const TOP_N = 10;                                             // 统计时列出最大的几个文件
// 认得出的工具生成文件（都在 中间文件/ 顶层），名字和 render.mjs、make_audio.py 里的一致
const KNOWN_DIRS = ['chunks', 'check', 'qa', 'clips'];         // render.mjs：分段视频、抽帧检查、质检图、实机片段帧（整个文件夹都是工具生成的）
const KNOWN_FILES = ['video_noaudio.mp4', 'burn.srt', 'burn.ass', 'sfx_events.json', 'samples.json',   // render.mjs：无声画面、烧字幕用的字幕、音效和采样事件表
  'voice.wav', 'music.wav', 'sfx.wav', 'samples.wav', 'mix_raw.wav', 'mix.wav', 'sfx_scale.npy'];   // make_audio.py：各条音轨、混音
const KNOWN_RE = [/^片段_[\d.]+_[\d.]+\.mp4$/];                // render.mjs 菜单 2 渲染的片段
const TEMP_DIR = '临时文件';                                    // 工程文件/临时文件/：AI 做这条视频时放的一次性文件（SKILL.md「目录约定」）
const CHANGE_RE = /^第[一二三四五六七八九十]+稿改动预览_.+\.png$/;   // 顶层的改动预览图（render.mjs 的 CHANGE_TAG）

// ---------- 输入（兼容管道输入） ----------
const piped = !process.stdin.isTTY;
const pipedLines = piped ? fs.readFileSync(0, 'utf8').split(/\r?\n/) : null;
let rl = null;
function ask(q) {
  if (piped) { const v = (pipedLines.shift() ?? '').trim(); console.log(q + v); return Promise.resolve(v); }
  rl = rl || readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => res(a.trim())));
}

const rel = (f) => path.relative(WORK, f).split(path.sep).join('/');
const fmt = (b) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`;
const sum = (xs) => xs.reduce((s, x) => s + x.size, 0);
function filesIn(p) {                                         // p 下的所有文件 [{f, size}]；链接只算它自己（不跟进去）
  const st = fs.lstatSync(p);
  if (st.isDirectory()) return fs.readdirSync(p).flatMap(n => filesIn(path.join(p, n)));
  return [{ f: p, size: st.isSymbolicLink() ? 0 : st.size }];
}
function hasLink(p) {                                         // p 自己或里面有没有链接
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return true;
  return st.isDirectory() && fs.readdirSync(p).some(n => hasLink(path.join(p, n)));
}

// 顶层的成片：<片名>_<序号>.mp4、<片名>_<序号>_字幕.mp4，片名取各稿 project.json 的 name
function finals(drafts) {
  const names = new Set();
  for (const d of drafts) {
    const f = path.join(ENG, d, 'project.json');
    if (fs.existsSync(f)) names.add(JSON.parse(fs.readFileSync(f, 'utf8')).name);
  }
  return fs.readdirSync(WORK).filter(f => [...names].some(n => n && f.startsWith(`${n}_`) && /^\d+(_字幕)?\.mp4$/.test(f.slice(n.length + 1)))
    && fs.statSync(path.join(WORK, f)).isFile());
}

// 盘点本项目：groups 按位置分组的可清理文件、targets 要删的文件或文件夹（各带里面的文件）、skipped 认不出不动的、finals 成片
function scan() {
  if (!fs.existsSync(ENG)) throw new Error(`当前目录（${WORK}）不是视频工作目录（没有 ${ENG_DIR}/）：要在要清理的那条视频的工作目录里运行`);
  const drafts = fs.readdirSync(ENG).filter(n => DRAFT_RE.test(n) && fs.lstatSync(path.join(ENG, n)).isDirectory());
  if (!drafts.length) throw new Error(`${ENG_DIR}/ 里没有稿目录（第一稿文件、第二稿文件…）`);
  const r = { groups: [], targets: [], skipped: [], finals: finals(drafts) };
  const add = (label, ts) => { r.groups.push({ label, files: ts.flatMap(t => t.files) }); r.targets.push(...ts); };
  for (const d of drafts) {                                   // 各稿的 中间文件/：只删认得出的
    const b = path.join(ENG, d, BUILD_DIR);
    if (!fs.existsSync(b)) continue;
    if (!fs.lstatSync(b).isDirectory()) { r.skipped.push(b); continue; }   // 中间文件 是链接或不是文件夹：不动
    const ts = [];
    for (const n of fs.readdirSync(b)) {
      const p = path.join(b, n), st = fs.lstatSync(p);
      const known = st.isDirectory() ? KNOWN_DIRS.includes(n) : st.isFile() && (KNOWN_FILES.includes(n) || KNOWN_RE.some(re => re.test(n)));
      if (known) ts.push({ p, files: filesIn(p) }); else r.skipped.push(p);
    }
    add(rel(b), ts);
  }
  const tmp = path.join(ENG, TEMP_DIR);                       // 临时文件/：里面的都删，链接和含链接的文件夹不动
  if (fs.existsSync(tmp)) {
    if (!fs.lstatSync(tmp).isDirectory()) r.skipped.push(tmp);
    else {
      const ts = [];
      for (const n of fs.readdirSync(tmp)) {
        const p = path.join(tmp, n);
        if (hasLink(p)) r.skipped.push(p); else ts.push({ p, files: filesIn(p) });
      }
      add(rel(tmp), ts);
    }
  }
  add('顶层的改动预览图', fs.readdirSync(WORK).filter(n => CHANGE_RE.test(n) && fs.lstatSync(path.join(WORK, n)).isFile())
    .map(n => ({ p: path.join(WORK, n), files: filesIn(path.join(WORK, n)) })));
  r.files = r.groups.flatMap(g => g.files);
  return r;
}

function report(r) {
  console.log(`项目：${WORK}`);
  console.log(r.finals.length ? `成片 ${r.finals.length} 个：${r.finals.join('、')}` : '顶层还没有成片（<片名>_<序号>.mp4）：项目没做完，不能清理');
  if (!r.files.length) console.log('没有可清理的文件');
  else {
    console.log('可清理的：');
    for (const g of r.groups) if (g.files.length) console.log(`  ${g.label}  ${fmt(sum(g.files))}（${g.files.length} 个文件）`);
    console.log(`最大的 ${Math.min(TOP_N, r.files.length)} 个文件：`);
    for (const x of [...r.files].sort((a, b) => b.size - a.size).slice(0, TOP_N)) console.log(`  ${fmt(x.size).padStart(9)}  ${rel(x.f)}`);
    console.log(`合计：${r.files.length} 个文件，${fmt(sum(r.files))}`);
  }
  if (r.skipped.length) { console.log('不会动的（认不出的文件、链接和含链接的文件夹）：'); r.skipped.forEach(p => console.log(`  ${rel(p)}`)); }
}

async function clean() {
  const r = scan();
  report(r);
  if (!r.finals.length) throw new Error('顶层还没有成片，项目没做完，不能清理');
  if (!r.files.length) return;
  if ((await ask(`确认删除以上 ${r.files.length} 个文件（${fmt(sum(r.files))}）吗？删了不进回收站（输入 y 删除，其他取消）: `)) !== 'y') { console.log('已取消，什么都没删'); return; }
  let n = 0, bytes = 0;
  const failed = [];
  for (const t of r.targets) {
    try { fs.rmSync(t.p, { recursive: true }); n += t.files.length; bytes += sum(t.files); } catch (e) { failed.push(`${rel(t.p)}（${e.code || e.message}）`); }
  }
  console.log(`已清理 ${n} 个文件，腾出 ${fmt(bytes)}`);
  if (failed.length) throw new Error(`有 ${failed.length} 项没删掉（可能正被占用，比如还在渲染或文件开着）：${failed.join('、')}`);
}

async function main() {
  console.log(`==== 清理中间文件和临时文件（工作目录：${WORK}）====
1. 统计可清理的文件（只看不删）
2. 清理（先统计，输入 y 才删；顶层没有成片不让删）`);
  const ch = await ask('请选择: ');
  if (ch === '1') report(scan());
  else if (ch === '2') await clean();
  else throw new Error('编号无效');
  if (rl) rl.close();
  console.log(END_MARK);
  process.exit(0);
}
main().catch(e => { console.error(e); console.error(`${ERR_MARK} ${e.message}`); process.exit(1); });
