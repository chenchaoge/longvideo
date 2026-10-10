# -*- coding: utf-8 -*-
"""兜底用（加解密不行、用户导出了一整条配音时）：配音去空白、字幕跟着配音走（配音方式 A1；不限剪映：只要每句配音从它那条字幕的起点开始，什么来源的整条配音都能用）
每句配音：从这条字幕的起点，量到下一条起点前声音停下的地方；句子中间的停顿不算断句，变速不管，配音多长就按多长算
只删段与段之间的空白，每段配音原样不动；字幕时长改成和它那段配音一样长，首尾相接（配音短字幕就缩，长就拉，后面的跟着移）
这个量法已经做成过（1009_配音3），定下来不改"""
import re
import subprocess

import numpy as np

SILENT_DB = -60           # 响过这个（dBFS）才算有声音；空白里零星的极小杂点不算
QUIET_RUN = 0.02          # 声音停下：最后一处有声音之后，连续这么多秒完全没信号（朗读自带的轻微尾音一起保留，配音一点不剪）
RAW = {'s16': ('s16le', '<i2', 'pcm_s16le'), 's32': ('s32le', '<i4', 'pcm_s32le')}   # 音频的采样格式 → ffmpeg 原始格式、numpy 类型、写回的编码；其余一律按 32 位浮点
FLOAT = ('f32le', '<f4', 'pcm_f32le')


def probe(path):
    """读音频的采样率、声道数、采样格式、位深"""
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                        'stream=sample_rate,channels,sample_fmt,bits_per_raw_sample', '-of', 'default=nw=1', path],
                       capture_output=True, text=True)
    d = dict(s.split('=', 1) for s in r.stdout.split() if '=' in s)
    if 'sample_rate' not in d:
        raise SystemExit(f'读不出音频：{path}')
    return int(d['sample_rate']), int(d['channels']), d.get('sample_fmt', ''), d.get('bits_per_raw_sample', '')


def decode(path, ch, sr=None, raw=FLOAT):
    """ffmpeg 解码成 numpy 数组（采样数 × 声道）；给了 sr 就顺便转采样率"""
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-ac', str(ch)] + (['-ar', str(sr)] if sr else [])
    r = subprocess.run(cmd + ['-f', raw[0], '-'], capture_output=True)
    if r.returncode:
        raise SystemExit(f'解码失败：{path}\n{r.stderr.decode(errors="replace")[-300:]}')
    return np.frombuffer(r.stdout, dtype=raw[1]).reshape(-1, ch)


def load(path):
    """按原样读音频（采样率、声道、位深都不变），返回 dict：pcm、sr、ch、raw（写回用）、full（满幅值）"""
    sr, ch, sfmt, bits = probe(path)
    raw = RAW.get(sfmt.rstrip('p'), FLOAT)
    if raw[0] == 's32le' and bits == '24':
        raw = (raw[0], raw[1], 'pcm_s24le')                   # 24 位的按 32 位读、写回 24 位，数值不变
    full = 2 ** 15 if raw[0] == 's16le' else 2 ** 31 if raw[0] == 's32le' else 1.0
    return {'pcm': decode(path, ch, raw=raw), 'sr': sr, 'ch': ch, 'raw': raw, 'full': full}


def levels(pcm, full=1.0):
    """每个采样时刻各声道里最响的，按满幅算成 0～1"""
    return np.abs(pcm.astype(np.float32)).max(axis=1) / full


def sound_stop(level, a, b, sr):
    """在 [a, b) 采样里找声音停下的地方：最后一处响过 SILENT_DB 之后，走过轻微的尾音，到连续 QUIET_RUN 秒完全没信号为止；
    返回停下处的采样位置，这段里没有声音返回 None"""
    idx = np.flatnonzero(level[a:b] > 10 ** (SILENT_DB / 20)) if b > a else []
    if not len(idx):
        return None
    run = max(1, round(QUIET_RUN * sr))
    e = a + idx[-1] + 1
    while e < b:
        tail = np.flatnonzero(level[e:min(e + run, b)])
        if not len(tail):
            break
        e += tail[-1] + 1
    return e


def align(audio, starts):
    """整条配音：按字幕起点量每句配音，算出去空白后的配音和字幕时间
    starts：每条字幕的起点（秒，按先后）；返回 load() 的内容加上 problems（有就不能往下做）、
    segs（每句配音 [起点采样, 终点采样]）、cues（新字幕 [起秒, 止秒]）、gaps（删掉的每处空白秒数，含开头结尾）"""
    res = load(audio)
    sr = res['sr']
    level = levels(res['pcm'], res['full'])
    total = len(level)
    bounds = [min(round(s * sr), total) for s in starts] + [total]   # 每句从自己的起点量到下一句起点为止
    segs, mute = [], []
    for i in range(len(starts)):
        a = bounds[i]
        e = sound_stop(level, a, bounds[i + 1], sr)
        if e is None:
            mute.append(i + 1)
        segs.append([a, a if e is None else e])
    res['problems'] = []
    if mute:
        res['problems'].append(f'字幕 {len(starts)} 条，配音只有 {len(starts) - len(mute)} 段：第 {"、".join(map(str, mute))} 条字幕没有配音')
    if (level[:bounds[0]] > 10 ** (SILENT_DB / 20)).any():
        res['problems'].append(f'第 1 条字幕前面（0～{bounds[0] / sr:.2f} 秒）还有声音，配音比字幕多')
    if res['problems']:
        return res
    t, cues = 0, []
    for a, b in segs:
        cues.append((t / sr, (t + b - a) / sr))
        t += b - a
    gaps = [bounds[0] / sr] + [(segs[i + 1][0] - segs[i][1]) / sr for i in range(len(segs) - 1)] + [(total - segs[-1][1]) / sr]
    res.update(segs=segs, cues=cues, gaps=gaps)
    return res


def write_pcm(data, sr, raw, out):
    """numpy 数组（采样数 × 声道，类型和 raw 对应）写成 WAV"""
    r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', raw[0], '-ar', str(sr), '-ac', str(data.shape[1]), '-i', '-',
                        '-c:a', raw[2], out], input=np.ascontiguousarray(data).tobytes(), capture_output=True)
    if r.returncode:
        raise SystemExit(f'写配音失败：{out}\n{r.stderr.decode(errors="replace")[-300:]}')


def write_wav(res, out):
    """按 segs 把每段原样拼起来，写成和原音频同采样率、同声道、同位深的 WAV"""
    write_pcm(np.concatenate([res['pcm'][a:b] for a, b in res['segs']]), res['sr'], res['raw'], out)


def sec(h, m, s, ms):
    """SRT 时间的时、分、秒、毫秒 → 秒"""
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, '0')[:3]) / 1000


def read_srt(path):
    """按先后读 SRT 每条字幕：[(起秒, 止秒, 文字)]；没有文字的条不算"""
    b = open(path, 'rb').read()
    for enc in ('utf-8-sig', 'gb18030'):
        try:
            text = b.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise SystemExit(f'读不出字幕文件的编码：{path}')
    subs = []
    for blk in re.split(r'\n\s*\n', text.replace('\r', '').strip()):
        lines = blk.split('\n')
        i = next((j for j, s in enumerate(lines) if '-->' in s), None)
        if i is None:
            continue
        m = re.findall(r'(\d+):(\d+):(\d+)[,.](\d+)', lines[i])
        body = '\n'.join(lines[i + 1:]).strip()
        if len(m) == 2 and body:
            subs.append((sec(*m[0]), sec(*m[1]), body))
    return subs


def ts(x):
    """秒 → 00:00:00,000"""
    ms = round(x * 1000)
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'


def to_srt(texts, cues):
    """和剪映导出的一样用 CRLF"""
    return '\r\n'.join(f'{i}\r\n{ts(s)} --> {ts(e)}\r\n{t.replace(chr(10), chr(13) + chr(10))}\r\n'
                       for i, (t, (s, e)) in enumerate(zip(texts, cues), 1))
