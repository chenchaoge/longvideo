# -*- coding: utf-8 -*-
"""剪映草稿（菜单启动，在用户工作目录里运行）：生成剪映草稿，用户打开就能录音、对字幕，不用自己导入
草稿建在剪映的草稿目录里，名字 <片名>_配音，重名自动加序号，不覆盖已有草稿
剪映新版保存后的草稿是加密的，只能新建、读不回来：录好的配音、调好的字幕只能由用户在剪映里导出"""
import json
import os
import re
import string
import sys
import traceback
import winreg

import pyJianYingDraft as draft

sys.dont_write_bytecode = True
WORK = os.getcwd()                                            # 用户工作目录（运行时所在目录）
ENG = os.path.join(WORK, '工程文件')                            # 与 render.mjs 的 ENG_DIR 一致
CHECK_FILE = os.path.join(ENG, '开场核对.json')                 # 开场核对结果：要念的稿（voiceScript，没有就用文稿 script）、横竖版
DRAFT_TAG = '_初版'                                            # 初版 SRT 后缀（与 render.mjs 一致）
JY_DATA = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'JianyingPro', 'User Data')
SETTING = os.path.join(JY_DATA, 'Config', 'globalSetting')    # 剪映设置：在「全局设置 → 草稿位置」改过目录才有记录
DEFAULT_ROOT = os.path.join(JY_DATA, 'Projects', 'com.lveditor.draft')   # 剪映默认草稿目录
UNINSTALL_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\JianyingPro'   # 注册表里剪映的安装信息
DRAFT_MARK = {'draft_meta_info.json', 'draft_content.json'}   # 每个草稿文件夹里都有这两个，全盘找草稿目录就认这个
SKIP_DIRS = {'windows', '$recycle.bin', 'system volume information', 'node_modules'}   # 全盘找时跳过，另外 . 开头的（剪映回收站、云缓存等）也跳过
AUDIO_EXT = ('.wav', '.mp3', '.m4a', '.aac', '.flac')
SIZE = {'横版': (1920, 1080), '竖版': (1080, 1920)}             # 草稿画布


def ask(q):
    """读一行输入；管道喂完了返回空串"""
    try:
        return input(q).strip()
    except EOFError:
        return ''


def setting_root():
    """剪映设置里改过的草稿目录（如 currentCustomDraftPath=D:\\\\xx\\\\JianyingPro Drafts），没改过返回 None"""
    if not os.path.exists(SETTING):
        return None
    with open(SETTING, encoding='utf-8', errors='replace') as f:
        m = re.search(r'^\w*DraftPath=(.+)$', f.read(), re.M | re.I)
    return m.group(1).strip().replace('\\\\', '\\') if m else None


def install_drive():
    """剪映装在哪个盘（从注册表的卸载信息里取），取不到返回 None"""
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, UNINSTALL_KEY) as k:
                s = winreg.QueryValueEx(k, 'UninstallString')[0]
        except OSError:
            continue
        m = re.search(r'([A-Za-z]):\\', s)
        if m:
            return m.group(1).upper()
    return None


def search_root():
    """按草稿特征全盘找草稿目录：先找剪映装的盘，再找别的盘；一个盘里找到就停，有多个取最近用过的"""
    drives = [d for d in string.ascii_uppercase if os.path.exists(f'{d}:\\')]
    first = install_drive()
    if first in drives:
        drives.remove(first)
        drives.insert(0, first)
    for d in drives:
        print(f'在 {d} 盘找剪映草稿目录…')
        found = {}                                            # 草稿目录 → 里面草稿最近修改时间
        for dirpath, dirnames, filenames in os.walk(f'{d}:\\'):
            if DRAFT_MARK <= set(filenames):                  # dirpath 是一个草稿，它的上一级就是草稿目录
                root = os.path.dirname(dirpath)
                found[root] = max(found.get(root, 0), os.path.getmtime(os.path.join(dirpath, 'draft_meta_info.json')))
                dirnames[:] = []
                continue
            dirnames[:] = [n for n in dirnames if n.lower() not in SKIP_DIRS and not n.startswith('.')]
        if found:
            for r in found:
                print(f'  找到：{r}')
            return max(found, key=found.get)
    return None


def draft_root():
    """剪映草稿目录：先看剪映设置里改过的目录，再看默认目录，都没有就全盘按草稿特征找"""
    for how, root in (('剪映设置', setting_root()), ('默认目录', DEFAULT_ROOT)):
        if root and os.path.isdir(root):
            print(f'剪映草稿目录（{how}）：{root}')
            return root
    root = search_root()
    if not root:
        raise SystemExit('全盘都没找到剪映草稿目录：先打开剪映专业版新建一个草稿，再重试')
    print(f'剪映草稿目录（全盘查找）：{root}')
    return root


def load_check():
    """读开场核对结果，返回 (初版 SRT 路径, 画布宽, 画布高)"""
    if not os.path.exists(CHECK_FILE):
        raise SystemExit(f'当前目录（{WORK}）没有 工程文件/开场核对.json：要在用户工作目录里运行，并先完成开场核对')
    ck = json.load(open(CHECK_FILE, encoding='utf-8'))
    src = ck.get('voiceScript') or ck.get('script')              # 与 render.mjs 菜单 9 取稿的规则一致
    if not src:
        raise SystemExit('开场核对记录里没有文稿，无文稿分支不用配音草稿')
    srt = os.path.join(ENG, os.path.splitext(os.path.basename(src))[0] + DRAFT_TAG + '.srt')
    if not os.path.exists(srt):
        raise SystemExit(f'没有初版 SRT：{srt}，先用 render.mjs 选 9 生成')
    if ck.get('orientation') not in SIZE:
        raise SystemExit(f'开场核对记录里的横竖版（orientation）只能是 横版 或 竖版，现在是：{ck.get("orientation")}')
    return srt, *SIZE[ck['orientation']]


def pick_audio():
    """工作目录顶层的配音文件，多个时让选"""
    fs = sorted(f for f in os.listdir(WORK) if f.lower().endswith(AUDIO_EXT))
    if not fs:
        raise SystemExit(f'工作目录顶层没有配音文件（{"、".join(AUDIO_EXT)}）')
    if len(fs) == 1:
        return os.path.join(WORK, fs[0])
    for i, f in enumerate(fs, 1):
        print(f'  {i}. {f}')
    k = ask('选配音文件编号: ')
    if not k.isdigit() or not 1 <= int(k) <= len(fs):
        raise SystemExit('编号无效')
    return os.path.join(WORK, fs[int(k) - 1])


def free_name(root, base):
    """草稿名重名就加序号：<片名>_配音、<片名>_配音2…"""
    name, n = base, 1
    while os.path.exists(os.path.join(root, name)):
        n += 1
        name = f'{base}{n}'
    return name


def make_draft(with_audio):
    srt, w, h = load_check()
    audio = pick_audio() if with_audio else None
    root = draft_root()
    name = free_name(root, os.path.basename(WORK) + '_配音')
    script = draft.DraftFolder(root).create_draft(name, w, h, fps=30)
    script.import_srt(srt, track_name='字幕')
    if audio:
        mat = draft.AudioMaterial(audio)
        script.append_track(draft.TrackSpec(draft.TrackType.audio, '配音'))
        script.add_segment(draft.AudioSegment(mat, draft.trange(0, mat.duration)), '配音')
    script.save()
    print(f'已生成剪映草稿：{name}\n位置：{os.path.join(root, name)}\n字幕：{srt}' + (f'\n配音：{audio}' if audio else ''))
    print('剪映开着的话，回到首页（或重开剪映）草稿列表才会出现')


def main():
    print('==== 剪映草稿 ====\n1. 生成配音草稿：导入初版 SRT，用户打开录音\n2. 生成配音草稿：导入初版 SRT + 工作目录里已有的配音文件')
    ch = ask('请选择: ')
    if ch == '1':
        make_draft(False)
    elif ch == '2':
        make_draft(True)
    else:
        print('无效选择')


def run():
    """跑菜单，最后一行打印【结束】或【出错】（与 render.mjs 一致，调用方只认这两个判断跑完没有）"""
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0):
            print(f'【出错】{e.code}')
            sys.exit(1)
    except Exception as e:
        traceback.print_exc()
        print(f'【出错】{e}')
        sys.exit(1)
    print('【结束】')


if __name__ == '__main__':
    run()
