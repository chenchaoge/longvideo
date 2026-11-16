# -*- coding: utf-8 -*-
"""剪映导出的配音和字幕（菜单启动，在用户工作目录里运行）：不碰剪映草稿，Windows、Mac 都能跑
- 菜单 1：文本朗读的整条配音去空白、字幕跟着配音对齐（Windows 的 A1 兜底，Mac 的 A1）
- 菜单 2：字幕和初版 SRT 逐条比，列出用户改了哪些字幕（收尾检查）
draft.py 的菜单 3、9 就是这里的菜单 1、2；工作目录、开场核对、挑文件、比字幕这些共用的函数也放这里，draft.py 从这里导入"""
import difflib
import json
import os
import re
import sys
import traceback

import tts_align

sys.dont_write_bytecode = True
WORK = os.getcwd()                                            # 用户工作目录（运行时所在目录）
ENG = os.path.join(WORK, '工程文件')                            # 与 render.mjs 的 ENG_DIR 一致
CHECK_FILE = os.path.join(ENG, '开场核对.json')                 # 开场核对结果：要念的稿（voiceScript，没有就用文稿 script）、横竖版
DRAFT_TAG = '_初版'                                            # 初版 SRT 后缀（与 render.mjs 一致）
AUDIO_EXT = ('.wav', '.mp3', '.m4a', '.aac', '.flac')
OUT_VOICE = os.path.join(ENG, '配音.wav')                       # 对齐的结果：去掉空白的连续配音
OUT_SUBS = os.path.join(ENG, '字幕.srt')                        # 对齐的结果：按每段配音对齐的字幕
SIZE = {'横版': (1920, 1080), '竖版': (1080, 1920)}            # 剪映草稿画布
WARN_LEN = 30                                                 # 字幕超过几个字提醒（汉字算 1，英文数字算半个；与 srt.mjs 一致）


def ask(q):
    """读一行输入；管道喂完了返回空串"""
    try:
        return input(q).strip()
    except EOFError:
        return ''


def read_check():
    """读开场核对.json"""
    if not os.path.exists(CHECK_FILE):
        raise SystemExit(f'当前目录（{WORK}）没有 工程文件/开场核对.json：要在用户工作目录里运行，并先完成开场核对')
    return json.load(open(CHECK_FILE, encoding='utf-8'))


def load_check():
    """读开场核对结果，返回 (初版 SRT 路径, 画布宽, 画布高)"""
    ck = read_check()
    src = ck.get('voiceScript') or ck.get('script')              # 与 render.mjs 菜单 9 取稿的规则一致
    if not src:
        raise SystemExit('开场核对记录里没有文稿，无文稿分支不用配音')
    srt = os.path.join(ENG, os.path.splitext(os.path.basename(src))[0] + DRAFT_TAG + '.srt')
    if not os.path.exists(srt):
        raise SystemExit(f'没有初版 SRT：{srt}，先用 render.mjs 选 9 生成')
    if ck.get('orientation') not in SIZE:
        raise SystemExit(f'开场核对记录里的横竖版（orientation）只能是 横版 或 竖版，现在是：{ck.get("orientation")}')
    return srt, *SIZE[ck['orientation']]


def choose(items, label):
    """只有一个直接用，多个时列出来让选"""
    if len(items) == 1:
        return items[0]
    for i, f in enumerate(items, 1):
        print(f'  {i}. {f}')
    k = ask(f'选{label}编号: ')
    if not k.isdigit() or not 1 <= int(k) <= len(items):
        raise SystemExit('编号无效')
    return items[int(k) - 1]


def top_files(exts):
    """工作目录顶层某类文件的文件名"""
    return sorted(f for f in os.listdir(WORK) if f.lower().endswith(exts) and os.path.isfile(os.path.join(WORK, f)))


def pick_top(exts, label):
    """工作目录顶层某类文件（配音、剪映导出的音频或字幕），多个时让选"""
    fs = top_files(exts)
    if not fs:
        raise SystemExit(f'工作目录顶层没有{label}（{"、".join(exts)}）')
    return os.path.join(WORK, choose(fs, label))


def ask_overwrite():
    for f in (OUT_VOICE, OUT_SUBS):
        if os.path.exists(f) and ask(f'{f} 已存在，覆盖吗？（输入 y 覆盖，其他取消）: ') != 'y':
            raise SystemExit('已取消，什么都没改')


def flat(s):
    """比文字用：只留字和数字（换行、空白、标点都不算，标点不影响念什么），不分大小写"""
    return re.sub(r'[\W_]+', '', s).lower()


def rows(s):
    """字幕文字按行拆开（去掉空行），比换行用"""
    return [flat(x) for x in s.split('\n') if flat(x)]


def says(text, name):
    """这段配音念的是不是这条字幕：文本朗读的配音名字就是生成时的字幕（太长只留开头、加 ...，这时只能比开头）"""
    head = flat(name)
    if name.rstrip().endswith(('...', '…')):
        return bool(head) and flat(text).startswith(head)
    return bool(head) and flat(text) == head


def wide(s):
    """字幕字数（与 srt.mjs 的 width 一致：英文数字算半个）；手动换的行并成一行算（横版字幕只放一行）"""
    return sum(0.5 if ' ' <= ch <= '~' else 1 for ch in ''.join(x.strip() for x in s.split('\n')))


def changes(old, texts, durs=None, names=None):
    """和之前的字幕比，逐条说清改了什么：字幕和配音都改了、只改了字幕（配音没重新生成）、只换了行、加删句子；
    old 是 tts_align.read_srt 读的之前的字幕（上次的 字幕.srt，或初版 SRT）；texts 这次每条字幕的文字；
    durs 这次每段配音的长度（秒）：给了才比配音长度（初版 SRT 的时间只是占位，不比）；
    names 每段配音的名字：给了才看配音念的是不是这条字幕（剪映导出的整条配音、自己录的配音没有，只比字）"""
    out, shift = [], False
    sm = difflib.SequenceMatcher(a=[flat(t) for *_, t in old], b=list(map(flat, texts)), autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal' or (tag == 'replace' and i2 - i1 == j2 - j1):   # 一条对一条地比
            for i, j in zip(range(i1, i2), range(j1, j2)):
                t, was = texts[j], '' if i == j else f'（原第 {i + 1} 条）'
                a = old[i][1] - old[i][0]
                b = durs[j] if durs else a
                moved = abs(a - b) > 0.0015                   # 上次的字幕时间只到毫秒，差 1 毫秒以内算没变
                long = f'，配音 {a:.3f} → {b:.3f} 秒' if moved else ''
                voiced = names is None or says(t, names[j])   # 配音念的是这条字幕（没有配音名字就不看）
                if flat(old[i][2]) != flat(t):
                    if names is None:
                        kind = '改了字'
                    elif voiced and (moved or not durs):      # 重新生成了配音：名字对得上新字幕（和上次比时长度也变了）
                        kind = '字幕和配音都改了'
                    else:
                        kind = '只改了字幕，配音没重新生成（念的还是原来的）'
                    out.append(f'第 {j + 1} 条{was}：{kind}{long}：{" ".join(old[i][2].split())} → {" ".join(t.split())}')
                elif rows(old[i][2]) != rows(t):
                    out.append(f'第 {j + 1} 条{was}：只换了行{long}')
                elif moved:
                    out.append(f'第 {j + 1} 条{was}：字没改，配音长度变了{long}')
                elif not durs and not voiced:                 # 和初版比才报：和上次比时这种早就报过
                    out.append(f'第 {j + 1} 条{was}：字没改，但配音念的和字幕不一样')
            continue
        shift = True
        out += [f'删掉了原来的第 {i + 1} 条：{" ".join(old[i][2].split())}' for i in range(i1, i2)]
        out += [f'新加了第 {j + 1} 条：{" ".join(texts[j].split())}'
                + ('' if names is None or says(texts[j], names[j]) else '（配音念的和字幕不一样）') for j in range(j1, j2)]
    if shift:
        out.append(f'加删了句子（字幕从 {len(old)} 条变成 {len(texts)} 条）：后面句子的序号变了')
    return out


def vs_first(first, texts, names=None):
    """收尾检查：和初版 SRT（first）比，逐条列出用户改了哪些字幕（只比字，见 changes）；
    改过、新加的字幕超过 WARN_LEN 个字的另外列出（初版里原样有的超长行第 2 步已经问过，不再报）"""
    init = tts_align.read_srt(first)
    diff = changes(init, texts, names=names)
    print('和初版 SRT 比（用户改了哪些字幕）：' + (''.join(f'\n  {x}' for x in diff) if diff else '没有改动'))
    same = {flat(t) for *_, t in init}
    over = [f'第 {j + 1} 条（{wide(t):g} 个字）' for j, t in enumerate(texts) if flat(t) not in same and wide(t) > WARN_LEN]
    if over:
        print(f'改过、新加的字幕超过 {WARN_LEN} 个字：' + '、'.join(over))


def tts_fix():
    """菜单 1：文本朗读生成的配音（一条字幕一段，每段从它那条字幕的起点开始），用户导出整条音频和字幕后，
    按字幕起点量出每句，去掉段与段之间的空白，字幕时长改成和它那段配音一样长"""
    first = load_check()[0]
    audio = pick_top(AUDIO_EXT, '剪映导出的音频')
    if top_files(('.srt',)):
        srt = pick_top(('.srt',), '剪映导出的字幕')
    elif ask('工作目录顶层没有剪映导出的字幕：用户确认在剪映里没改过字幕，就输入 y 用初版 SRT，其他退出: ') == 'y':
        srt = first
    else:
        raise SystemExit('没有剪映导出的字幕：先问用户在剪映里改没改过字幕的文字，改过就让用户导出字幕（SRT）到工作目录')
    subs = tts_align.read_srt(srt)
    if not subs:
        raise SystemExit(f'字幕文件里没有字幕：{srt}')
    print(f'剪映导出的音频：{audio}\n字幕：{srt}（{len(subs)} 条）\n按每条字幕的起点量配音…')
    res = tts_align.align(audio, [s for s, _, _ in subs])
    if res['problems']:
        raise SystemExit('\n'.join(res['problems']) + '\n没有生成配音和字幕')
    ask_overwrite()
    os.makedirs(ENG, exist_ok=True)
    tts_align.write_wav(res, OUT_VOICE)
    with open(OUT_SUBS, 'w', encoding='utf-8', newline='') as f:
        f.write(tts_align.to_srt([t for _, _, t in subs], res['cues']))
    gaps = [g for g in res['gaps'] if g >= 0.001]             # 不到 1 毫秒的是字幕时间取整到毫秒带来的，不算空白
    print(f'字幕 {len(subs)} 条，配音 {len(subs)} 段，一一对上')
    print(f'删掉空白 {len(gaps)} 处，共 {sum(gaps):.1f} 秒；配音从 {len(res["pcm"]) / res["sr"]:.1f} 秒变成 {res["cues"][-1][1]:.1f} 秒'
          if gaps else '空白已经删过了，配音原样')
    if srt != first:                                          # 用的是剪映导出的字幕：看用户改了哪些
        vs_first(first, [t for *_, t in subs])
    print(f'已生成：{OUT_VOICE}\n已生成：{OUT_SUBS}')


def a2_check():
    """菜单 2（收尾检查）：工程文件/ 里的字幕（剪映导出的，或对齐好的 字幕.srt）和初版 SRT 比，逐条列出用户改了哪些字幕"""
    first = load_check()[0]
    srts = sorted(f for f in os.listdir(ENG) if f.lower().endswith('.srt') and os.path.isfile(os.path.join(ENG, f))
                  and not os.path.splitext(f)[0].endswith(DRAFT_TAG))   # 初版 SRT 不算（与 render.mjs 的 notDraft 一致）
    if not srts:
        raise SystemExit('工程文件/ 里没有要比的字幕（.srt，初版 SRT 不算）')
    srt = os.path.join(ENG, choose(srts, '要比的字幕'))
    subs = tts_align.read_srt(srt)
    if not subs:
        raise SystemExit(f'字幕文件里没有字幕：{srt}')
    print(f'要比的字幕：{srt}（{len(subs)} 条）')
    vs_first(first, [t for *_, t in subs])


def main():
    print('==== 剪映导出的配音和字幕（不碰剪映草稿）====\n'
          '1. 文本朗读的整条配音去空白、字幕跟着配音对齐：用工作目录顶层剪映导出的音频和字幕（没导出字幕、用户确认没改过就用初版 SRT），'
          '出 工程文件/配音.wav、字幕.srt；用了导出的字幕就和初版 SRT 比\n'
          '2. 工程文件/ 里的字幕和初版 SRT 比，列出用户改了哪些字幕')
    fn = {'1': tts_fix, '2': a2_check}.get(ask('请选择: '))
    if fn:
        fn()
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
