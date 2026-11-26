"""开工检查（不用输入，在哪个目录跑都行）：查这台电脑能不能做视频，缺什么指到 references/装软件.md 对应的那一节
查 7 项：系统、Python、Python 库、Node.js 和渲染用的库、ffmpeg 和 ffprobe（要能烧字幕、写字）、渲染用的浏览器、思源字体；Mac 再查 OpenChatCut 装没装
不查的：Windows 剪映（第 1 步用 draft.py 菜单 8 另外查）、AI 连没连上 OpenChatCut（第 1 步 AI 自己查）
倒数第二行是「都通过了」或「有几项要处理」，最后一行是【结束】或【出错】（和其他工具一致，调用方只认它判断跑完没有）
"""
import importlib.metadata as md
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent                        # skill 的 scripts/
GUIDE = 'references/装软件.md'                                 # 装法只写在这份文档里，这里只指过去
SYSTEMS = {'Windows': 'Windows', 'Darwin': 'Mac'}             # platform.system() → browsers.json 的键
MIN_PYTHON = (3, 11)                                          # scipy 1.16 要 3.11 起；Mac 自带的 python3 是 3.9，不够
MIN_NODE = 18                                                 # playwright-core 要 Node 18 起
FFMPEG_FILTERS = ('subtitles', 'drawtext')                    # 烧字幕要 libass，质检图上写字要 freetype
FONTS = {'Noto Sans SC': 'notosanssc', 'Noto Serif SC': 'notoserifsc'}   # 字体名 → 字体文件名（去掉空格、横线，小写）的开头
REQ_RE = re.compile(r'^([A-Za-z0-9_.-]+)\s*(>=|~=|==)\s*([\d.]+)')   # requirements.txt 的一行：库名、比较符、版本
OPENCHATCUT_APPS = ('/Applications/OpenChatCut.app', '~/Applications/OpenChatCut.app')   # Mac 的编辑软件装在哪
END_MARK, ERR_MARK = '【结束】', '【出错】'


def report(ok, text, todo):
    """打印一项结果；没通过的记进 todo"""
    print(f"[{'通过' if ok else '要处理'}] {text}")
    if not ok:
        todo.append(text)


def ver_tuple(s):
    return tuple(int(x) for x in re.findall(r'\d+', s)[:3])


def ver_ok(have, op, want):
    """版本 have 满不满足 op want（>=、~=、==）"""
    h, w = ver_tuple(have), ver_tuple(want)
    if op == '==':
        return h[:len(w)] == w
    if op == '~=':                                            # ~=0.3.0 就是 0.3.x 里不低于 0.3.0 的
        return h >= w and h[:len(w) - 1] == w[:len(w) - 1]
    return h >= w


def check_system(todo):
    name = SYSTEMS.get(platform.system())
    report(bool(name), f"系统：{name or platform.system()}" + ('' if name else '（只支持 Windows 和 Mac）'), todo)
    return name


def check_python(todo):
    v = sys.version_info[:3]
    ok = v >= MIN_PYTHON
    need = '' if ok else f"：要 {MIN_PYTHON[0]}.{MIN_PYTHON[1]} 或更新，照 {GUIDE}「Python」装"
    report(ok, f"Python {'.'.join(map(str, v))}（{sys.executable}）{need}", todo)


def check_libs(todo):
    """requirements.txt 里的库都装了、版本够"""
    bad = []
    for line in (ROOT / 'requirements.txt').read_text(encoding='utf-8').splitlines():
        m = REQ_RE.match(line.strip())
        if not m:
            continue
        name, op, want = m.groups()
        if name == 'pyJianYingDraft' and platform.system() != 'Windows':
            continue  # Mac 不运行 Windows 剪映草稿脚本
        try:
            have = md.version(name)
        except md.PackageNotFoundError:
            bad.append(f'{name}（没装）')
            continue
        if not ver_ok(have, op, want):
            bad.append(f'{name}（装的是 {have}，要 {op}{want}）')
    report(not bad, 'Python 库' + (f"：{'、'.join(bad)}，照 {GUIDE}「装好软件后」装" if bad else '都装了'), todo)


def check_node(todo):
    node = shutil.which('node')
    if not node:
        report(False, f'Node.js 没装：照 {GUIDE}「Node.js」装', todo)
        return
    out = subprocess.run([node, '--version'], capture_output=True, text=True).stdout.strip()   # 如 v22.11.0
    m = re.match(r'v?(\d+)', out)
    ok = bool(m) and int(m.group(1)) >= MIN_NODE
    report(ok, f'Node.js {out}' + ('' if ok else f'：要 {MIN_NODE} 或更新，照 {GUIDE}「Node.js」装'), todo)
    lib = (ROOT / 'node_modules' / 'playwright-core').is_dir()
    report(lib, '渲染用的库 playwright-core ' + ('装了' if lib else f'没装：照 {GUIDE}「装好软件后」装'), todo)


def check_ffmpeg(todo):
    missing = [n for n in ('ffmpeg', 'ffprobe') if not shutil.which(n)]
    if missing:
        report(False, f"{'、'.join(missing)} 没装或不在 PATH 里：照 {GUIDE}「ffmpeg」装", todo)
        return
    out = subprocess.run(['ffmpeg', '-hide_banner', '-filters'], capture_output=True, text=True,
                         encoding='utf-8', errors='replace').stdout
    lack = [f for f in FFMPEG_FILTERS if not re.search(rf'\s{f}\s', out)]
    report(not lack, f"ffmpeg（{shutil.which('ffmpeg')}）"
           + (f"缺 {'、'.join(lack)} 功能（烧不了字幕或写不了字）：照 {GUIDE}「ffmpeg」换一个完整版" if lack else ''), todo)


def check_browser(system, todo):
    """browsers.json 里本系统的位置，有一个存在就行（render.mjs 按同样的顺序挑）"""
    paths = json.loads((ROOT / 'browsers.json').read_text(encoding='utf-8')).get(system, [])
    found = next((p for p in map(os.path.expanduser, paths) if Path(p).exists()), None)
    report(bool(found), f'渲染用的浏览器：{found}' if found else f'渲染用的浏览器没找到：照 {GUIDE}「浏览器」装', todo)


def font_dirs(system):
    if system == 'Windows':
        return [Path(os.environ['WINDIR']) / 'Fonts', Path(os.environ['LOCALAPPDATA']) / 'Microsoft' / 'Windows' / 'Fonts']
    return [Path('/Library/Fonts'), Path.home() / 'Library' / 'Fonts', Path('/System/Library/Fonts'),
            Path('/System/Library/Fonts/Supplemental')]


def check_fonts(system, todo):
    """按字体文件名查 Google 版思源黑体、思源宋体（Adobe 版叫 Source Han，文件名不一样，画面认不到）"""
    names = [re.sub(r'[\s_-]', '', f.name).lower() for d in font_dirs(system) if d.is_dir() for f in d.iterdir()]
    lack = [font for font, key in FONTS.items() if not any(n.startswith(key) for n in names)]
    report(not lack, '字体 ' + '、'.join(FONTS) + (f"：缺 {'、'.join(lack)}，照 {GUIDE}「字体」装" if lack else ' 都装了'), todo)


def check_openchatcut(todo):
    """Mac 的编辑软件 OpenChatCut 装在「应用程序」里没有"""
    found = next((p for p in map(os.path.expanduser, OPENCHATCUT_APPS) if Path(p).exists()), None)
    report(bool(found), f'OpenChatCut：{found}' if found else f'OpenChatCut 没装：照 {GUIDE}「OpenChatCut」装', todo)


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')   # Windows 默认按 GBK 输出，AI 平台按 UTF-8 读会乱码
    print('==== 开工检查 ====')
    todo = []
    system = check_system(todo)
    check_python(todo)
    check_libs(todo)
    check_node(todo)
    check_ffmpeg(todo)
    if system:
        check_browser(system, todo)
        check_fonts(system, todo)
    if system == 'Mac':
        check_openchatcut(todo)
    print('都通过了' if not todo else f'有 {len(todo)} 项要处理')
    print(END_MARK)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        traceback.print_exc()
        print(f'{ERR_MARK}{e}')
