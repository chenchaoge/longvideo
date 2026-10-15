# -*- coding: utf-8 -*-
"""剪映草稿（菜单启动，在用户工作目录里运行）：生成配音草稿、对齐配音和字幕、成片放进草稿
剪映草稿有两种做法：
- 默认：能加解密（菜单 5 检查），Claude 直接读写草稿：菜单 6 文本朗读配音在草稿里直接对齐，菜单 7 成片放进草稿
- 兜底：加解密用不了，用户配合：菜单 3 用剪映导出的音频和字幕对齐，菜单 4 导回剪映
草稿建在剪映的草稿目录里，名字 <片名>_配音，重名自动加序号；备份的草稿名 <草稿名>_备份；这一步正常只有这两个草稿"""
import difflib
import json
import os
import re
import sys
import traceback

import pyJianYingDraft as draft

import jycrypto
import jydraft
import tts_align

sys.dont_write_bytecode = True
WORK = os.getcwd()                                            # 用户工作目录（运行时所在目录）
ENG = os.path.join(WORK, '工程文件')                            # 与 render.mjs 的 ENG_DIR 一致
CHECK_FILE = os.path.join(ENG, '开场核对.json')                 # 开场核对结果：要念的稿（voiceScript，没有就用文稿 script）、横竖版
DRAFT_TAG = '_初版'                                            # 初版 SRT 后缀（与 render.mjs 一致）
AUDIO_EXT = ('.wav', '.mp3', '.m4a', '.aac', '.flac')
OUT_VOICE = os.path.join(ENG, '配音.wav')                       # 菜单 3、6 的结果：去掉空白的连续配音
OUT_SUBS = os.path.join(ENG, '字幕.srt')                        # 菜单 3、6 的结果：按每段配音对齐的字幕
BACKUP_TAG = '_备份'                                           # 备份原配音草稿的名字后缀
VIDEO_RE = re.compile(r'(.+)_\d+\.mp4', re.I)                  # 无字幕成片：<片名>_<序号>.mp4（render.mjs 出片的命名）
START_TOL = 10000                                             # 字幕和配音开头相差这么多微秒以内，算同一句的
SIZE = {'横版': (1920, 1080), '竖版': (1080, 1920)}            # 草稿画布
US = jydraft.US


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
        raise SystemExit('开场核对记录里没有文稿，无文稿分支不用配音草稿')
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


def pick_voice_draft(root):
    """本视频的配音草稿（<片名>_配音 开头、不是备份的），按最近修改排，多个时让选"""
    base = os.path.basename(WORK) + '_配音'
    names = sorted((n for n in os.listdir(root) if n.startswith(base) and BACKUP_TAG not in n and os.path.isdir(os.path.join(root, n))),
                   key=lambda n: -os.path.getmtime(os.path.join(root, n)))
    if not names:
        raise SystemExit(f'剪映草稿目录里没有「{base}」开头的配音草稿')
    return choose(names, '配音草稿')


def ask_overwrite():
    for f in (OUT_VOICE, OUT_SUBS):
        if os.path.exists(f) and ask(f'{f} 已存在，覆盖吗？（输入 y 覆盖，其他取消）: ') != 'y':
            raise SystemExit('已取消，什么都没改')


def make_draft(srt, w, h, audio=None, root=None, name=None, cues=None):
    """新建配音草稿：导入字幕，有配音就放到音频轨（给了 cues [(开始, 时长) 微秒] 就按它切成一段一段的）；
    没给名字就用 <片名>_配音（重名加序号）；返回草稿名"""
    root = root or jydraft.draft_root()
    name = name or jydraft.free_name(root, os.path.basename(WORK) + '_配音')
    script = draft.DraftFolder(root).create_draft(name, w, h, fps=30)
    script.import_srt(srt, track_name='字幕')
    if audio:
        mat = draft.AudioMaterial(audio)
        script.append_track(draft.TrackSpec(draft.TrackType.audio, '配音'))
        for a, n in cues or [(0, mat.duration)]:
            n = min(n, mat.duration - a)
            if n > 0:
                script.add_segment(draft.AudioSegment(mat, draft.trange(a, n), source_timerange=draft.trange(a, n)), '配音')
    script.save()
    print(f'已生成剪映草稿：{name}\n位置：{os.path.join(root, name)}\n字幕：{srt}' + (f'\n配音：{audio}' if audio else ''))
    print('剪映开着的话，回到首页（或重开剪映）草稿列表才会出现')
    return name


def tts_fix():
    """菜单 3（兜底，加解密用不了时）：文本朗读生成的配音（一条字幕一段，每段从它那条字幕的起点开始），用户导出整条音频和字幕后，
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
    print(f'已生成：{OUT_VOICE}\n已生成：{OUT_SUBS}')


def import_back():
    """菜单 4（兜底）：菜单 3 对齐好的配音和字幕导回配音草稿：原草稿改名成 <草稿名>_备份（不删、不改里面的东西），
    原名字新建草稿导入，配音按每条字幕切成一段一段的"""
    w, h = load_check()[1:]
    for f in (OUT_VOICE, OUT_SUBS):
        if not os.path.exists(f):
            raise SystemExit(f'没有 {f}：先跑菜单 3 对齐')
    root = jydraft.draft_root()
    name = pick_voice_draft(root)
    backup = jydraft.free_name(root, name + BACKUP_TAG)
    try:
        os.rename(os.path.join(root, name), os.path.join(root, backup))
    except OSError as e:
        raise SystemExit(f'草稿「{name}」改不了名（{e}）：剪映里可能还开着它，请用户关掉这个草稿、回到剪映首页再重试')
    print(f'原草稿已备份：「{name}」→「{backup}」')
    cues = [(round(s * US), round(e * US) - round(s * US)) for s, e, _ in tts_align.read_srt(OUT_SUBS)]
    make_draft(OUT_SUBS, w, h, OUT_VOICE, root, name, cues)
    print(f'草稿「{name}」已换成对齐好的配音和字幕（配音 {len(cues)} 段）')


def check_crypto():
    """菜单 5：检查能不能直接读写剪映草稿：剪映的加解密自检，再解开最近的一个加密草稿看看"""
    c = jycrypto.JyCrypto()
    print(f'剪映：{c.dir}\n加解密自检通过')
    root = jydraft.draft_root()
    names = sorted((n for n in os.listdir(root) if os.path.isfile(os.path.join(root, n, jydraft.CONTENT))),
                   key=lambda n: -os.path.getmtime(os.path.join(root, n, jydraft.CONTENT)))
    for n in names:
        raw = open(os.path.join(root, n, jydraft.CONTENT), 'rb').read()
        if raw[:1] not in (b'{', b'['):
            json.loads(c.decrypt(raw))
            print(f'最近的加密草稿「{n}」解得开')
            break
    else:
        print('草稿目录里还没有加密过的草稿，只做了自检')
    print('结论：加解密可用，剪映草稿可以直接读写')


def mismatch(subs, voices):
    """字幕和配音段数对不上：说清哪几条字幕开头没有配音、哪些配音开头没有字幕"""
    ss, vs = [jydraft.tr(s)[0] for s in subs], [jydraft.tr(v)[0] for v in voices]
    lack = [i + 1 for i, a in enumerate(ss) if not any(abs(a - b) <= START_TOL for b in vs)]
    extra = [b for b in vs if not any(abs(a - b) <= START_TOL for a in ss)]
    msg = f'字幕 {len(subs)} 条，配音 {len(voices)} 段，对不上'
    if lack:
        msg += f'：第 {"、".join(map(str, lack))} 条字幕没有配音'
    if extra:
        msg += f'；{"、".join(f"{b / US:.2f}" for b in extra)} 秒处的配音没有对应的字幕'
    return msg + '\n草稿没改'


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


def changes(old, texts, cues, names):
    """和上次的 字幕.srt 比，逐条说清改了什么，分三种：字幕和配音都改了、只改了字幕（配音没重新生成）、只换了行；
    old 是 tts_align.read_srt 读的上次结果，没有就是 []；texts 草稿里每条字幕的文字，cues [(开始, 时长)] 微秒，names 每段配音的名字"""
    if not old:                                               # 第一次对齐：只报配音念的和字幕不一样的
        return [f'第 {j + 1} 条（多半是只改了字幕、配音没重新生成）'
                for j, (t, n) in enumerate(zip(texts, names)) if not says(t, n)]
    out, shift = [], False
    sm = difflib.SequenceMatcher(a=[flat(t) for *_, t in old], b=list(map(flat, texts)), autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal' or (tag == 'replace' and i2 - i1 == j2 - j1):   # 一条对一条地比
            for i, j in zip(range(i1, i2), range(j1, j2)):
                a, b, t = old[i][1] - old[i][0], cues[j][1] / US, texts[j]
                was = '' if i == j else f'（原第 {i + 1} 条）'
                moved = abs(a - b) > 0.0015                   # 上次的字幕时间只到毫秒，差 1 毫秒以内算没变
                long = f'，配音 {a:.3f} → {b:.3f} 秒' if moved else ''
                if flat(old[i][2]) != flat(t):                # 重新生成了配音：名字对得上新字幕，长度也变了
                    kind = '字幕和配音都改了' if says(t, names[j]) and moved else '只改了字幕，配音没重新生成（念的还是原来的）'
                    out.append(f'第 {j + 1} 条{was}：{kind}{long}')
                elif rows(old[i][2]) != rows(t):
                    out.append(f'第 {j + 1} 条{was}：只换了行{long}')
                elif moved:
                    out.append(f'第 {j + 1} 条{was}：字没改，配音长度变了{long}')
            continue
        shift = True
        out += [f'删掉了原来的第 {i + 1} 条：{" ".join(old[i][2].split())}' for i in range(i1, i2)]
        out += [f'新加了第 {j + 1} 条：{" ".join(texts[j].split())}' + ('' if says(texts[j], names[j]) else '（配音念的和字幕不一样）')
                for j in range(j1, j2)]
    if shift:
        out.append(f'加删了句子（字幕从 {len(old)} 条变成 {len(texts)} 条）：后面句子的序号变了')
    return out


def tts_in_draft():
    """菜单 6（默认，能加解密时）：文本朗读的配音直接在配音草稿里对齐。一条字幕对一段配音，按顺序一一对应；
    每段配音的长度直接从草稿里读（已算上倍速），配音段从 0 秒起首尾相接（删掉段与段之间的空白，每段只挪位置、不剪不改，还是一段一段的），
    字幕的起止改成和它那段配音一样；先备份草稿再改；同时出 工程文件/配音.wav（按草稿位置拼的副本）、字幕.srt（做动画用）；
    已有上次的 字幕.srt 就逐条列出这次改了什么（见 changes），只改字幕、配音没重新生成的照常对齐，不算对不上"""
    read_check()
    jydraft.ensure_closed()
    root = jydraft.draft_root()
    name = pick_voice_draft(root)
    d = jydraft.Draft(os.path.join(root, name))
    subs, voices = d.segments('text'), d.segments('audio')
    if not subs:
        raise SystemExit(f'草稿「{name}」里没有字幕')
    if len(subs) != len(voices):
        raise SystemExit(mismatch(subs, voices))
    t, cues = 0, []
    for v in voices:                                          # 每段配音的长度就是它在草稿里的长度，从 0 秒起首尾相接
        n = jydraft.tr(v)[1]
        cues.append((t, n))
        t += n
    old_end = max(sum(jydraft.tr(v)) for v in voices)
    changed = any(jydraft.tr(s) != c or jydraft.tr(v) != c for s, v, c in zip(subs, voices, cues))
    ask_overwrite()
    if changed:
        bname, replaced = jydraft.backup(root, name, BACKUP_TAG)
        print(f'原草稿已备份成「{bname}」' + ('（换掉了上次的备份）' if replaced else ''))
        for s, v, (a, n) in zip(subs, voices, cues):
            v['target_timerange'] = {'start': a, 'duration': n}   # 配音只挪位置，长度不变
            s['target_timerange'] = {'start': a, 'duration': n}
        d.save()
    os.makedirs(ENG, exist_ok=True)
    old = tts_align.read_srt(OUT_SUBS) if os.path.exists(OUT_SUBS) else []   # 上次对齐的结果，用来比这次改了什么
    texts = [d.text(s) for s in subs]
    diff = changes(old, texts, cues, [d.material(v).get('name', '') for v in voices])
    jydraft.mixdown(d, OUT_VOICE, *d.audio_format())
    with open(OUT_SUBS, 'w', encoding='utf-8', newline='') as f:
        f.write(tts_align.to_srt(texts, [(a / US, (a + n) / US) for a, n in cues]))
    print(f'字幕 {len(subs)} 条，配音 {len(voices)} 段，一一对上，配音还是一段一段的')
    print(f'删掉段与段之间的空白，配音从 {old_end / US:.1f} 秒变成 {t / US:.1f} 秒；草稿「{name}」已对齐' if changed
          else f'空白已经删过了，草稿「{name}」没改')
    if old:
        print('和上次的字幕比：' + (''.join(f'\n  {x}' for x in diff) if diff else '没有改动'))
        if abs(old[-1][1] - t / US) > 0.01:
            print(f'配音总长从 {old[-1][1]:.3f} 秒变成 {t / US:.3f} 秒')
    elif diff:
        print('第一次对齐，下面这些条的配音和字幕不一样：' + ''.join(f'\n  {x}' for x in diff))
    print(f'已生成：{OUT_VOICE}\n已生成：{OUT_SUBS}')


def video_in():
    """菜单 7（能加解密时）：工作目录顶层最新的无字幕成片放进配音草稿的视频轨、从 0 秒开始，配音轨静音；
    视频轨上放着这条视频的旧版成片就换掉"""
    read_check()
    jydraft.ensure_closed()
    vids = [f for f in top_files(('.mp4',)) if VIDEO_RE.fullmatch(f)]
    if not vids:
        raise SystemExit('工作目录顶层没有无字幕成片（<片名>_<序号>.mp4）')
    video = max(vids, key=lambda f: os.path.getmtime(os.path.join(WORK, f)))
    stem = VIDEO_RE.fullmatch(video).group(1)
    root = jydraft.draft_root()
    name = pick_voice_draft(root)
    d = jydraft.Draft(os.path.join(root, name))
    dur = jydraft.put_video(d, os.path.join(WORK, video), re.compile(rf'{re.escape(stem)}_\d+\.mp4', re.I))
    d.save()
    print(f'成片 {video}（{dur:.1f} 秒）已放进草稿「{name}」的视频轨、从 0 秒开始；音频轨已静音')


def check_install():
    """菜单 8：只看注册表，查电脑装没装剪映专业版（不碰草稿、不做加解密）；没装是正常结果，不算出错"""
    if jycrypto.uninstall_value('UninstallString') is None:
        print('没装剪映专业版（注册表里没有它的安装信息）')
        return
    ver = jycrypto.uninstall_value('DisplayVersion') or '不详'
    try:
        print(f'已装剪映专业版：{jycrypto.install_dir()}（版本 {ver}）')
    except jycrypto.CryptoError as e:
        print(f'已装剪映专业版（版本 {ver}），但 {e}')


def main():
    print('==== 剪映草稿 ====\n8. 查电脑装没装剪映专业版（只看注册表，不碰草稿）\n'
          '1. 生成配音草稿：导入初版 SRT，用户打开生成朗读或录音\n2. 生成配音草稿：导入初版 SRT + 工作目录里已有的配音文件\n'
          '3. （兜底）文本朗读配音去空白、字幕跟着配音对齐：用工作目录里剪映导出的音频和字幕（没导出字幕、用户确认没改过就用初版 SRT）\n'
          '4. （兜底）对齐结果导回剪映：原配音草稿备份成 <草稿名>_备份，原名字导入 工程文件/ 里对齐好的配音（一段一段的）和字幕\n'
          '5. 检查能不能直接读写剪映草稿（加解密）\n'
          '6. 文本朗读配音在草稿里直接对齐：先备份草稿，删掉段与段之间的空白、字幕跟着配音，出 工程文件/配音.wav、字幕.srt\n'
          '7. 成片放进剪映草稿：最新的无字幕成片放进配音草稿的视频轨、从 0 秒开始，配音轨静音')
    ch = ask('请选择: ')
    if ch in ('1', '2'):
        srt, w, h = load_check()
        make_draft(srt, w, h, pick_top(AUDIO_EXT, '配音文件') if ch == '2' else None)
    else:
        fn = {'3': tts_fix, '4': import_back, '5': check_crypto, '6': tts_in_draft, '7': video_in, '8': check_install}.get(ch)
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
    except jycrypto.CryptoError as e:
        print(f'【出错】加解密用不了：{e}')
        sys.exit(1)
    except Exception as e:
        traceback.print_exc()
        print(f'【出错】{e}')
        sys.exit(1)
    print('【结束】')


if __name__ == '__main__':
    run()
