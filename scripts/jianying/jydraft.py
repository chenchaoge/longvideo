# -*- coding: utf-8 -*-
"""剪映草稿通用操作：找草稿目录、看剪映开没开、读写草稿（新版剪映的草稿是加密的，自动用 jycrypto 加解密，明文草稿照明文读写）、
备份草稿、取字幕和音频片段、按草稿里的摆法把音频做成一条 WAV、把视频放进草稿
读、改草稿前剪映必须完全退出：剪映开着时草稿在它内存里，退出时整个写回磁盘，这时读到的可能不是最新的，改了也会被它盖掉"""
import json
import math
import os
import re
import shutil
import string
import subprocess
import uuid

import numpy as np
import pyJianYingDraft as draft

import jycrypto
import tts_align

US = 1000000                                                  # 剪映的时间单位是微秒
JY_DATA = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'JianyingPro', 'User Data')
SETTING = os.path.join(JY_DATA, 'Config', 'globalSetting')    # 剪映设置：在「全局设置 → 草稿位置」改过目录才有记录
DEFAULT_ROOT = os.path.join(JY_DATA, 'Projects', 'com.lveditor.draft')   # 剪映默认草稿目录
CONTENT, META = 'draft_content.json', 'draft_meta_info.json'  # 每个草稿文件夹里都有这两个：时间线、草稿信息
SKIP_DIRS = {'windows', '$recycle.bin', 'system volume information', 'node_modules'}   # 全盘找时跳过，另外 . 开头的（剪映回收站、云缓存等）也跳过
MIRRORS = (CONTENT, CONTENT + '.bak', 'template-2.tmp')       # 剪映 11.5 同一份时间线存好几处（草稿根目录、Timelines/<时间线 id>/ 各一套），内容一样的一起写
PLACEHOLDER = re.compile(r'##_draftpath_placeholder_[0-9A-Fa-f-]+_##')   # 素材路径里代表「本草稿文件夹」的占位符
JY_EXE = 'jianyingpro.exe'                                    # 剪映主程序的进程名


# ---------- 草稿目录 ----------

def setting_root():
    """剪映设置里改过的草稿目录（如 currentCustomDraftPath=D:\\\\xx\\\\JianyingPro Drafts），没改过返回 None"""
    if not os.path.exists(SETTING):
        return None
    with open(SETTING, encoding='utf-8', errors='replace') as f:
        m = re.search(r'^\w*DraftPath=(.+)$', f.read(), re.M | re.I)
    return m.group(1).strip().replace('\\\\', '\\') if m else None


def install_drive():
    """剪映装在哪个盘（从注册表的卸载信息里取），取不到返回 None"""
    m = re.search(r'([A-Za-z]):\\', jycrypto.uninstall_value('UninstallString') or '')
    return m.group(1).upper() if m else None


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
            if {CONTENT, META} <= set(filenames):             # dirpath 是一个草稿，它的上一级就是草稿目录
                root = os.path.dirname(dirpath)
                found[root] = max(found.get(root, 0), os.path.getmtime(os.path.join(dirpath, META)))
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


def free_name(root, base):
    """草稿名重名就加序号：base、base2、base3…"""
    name, n = base, 1
    while os.path.exists(os.path.join(root, name)):
        n += 1
        name = f'{base}{n}'
    return name


def jy_running():
    """剪映主程序还开着没有"""
    out = subprocess.run(['tasklist', '/fo', 'csv', '/nh'], capture_output=True, text=True, errors='replace').stdout
    return any(line.split(',')[0].strip('"').lower() == JY_EXE for line in out.splitlines())


def ensure_closed():
    """剪映开着就停下，不读也不改草稿"""
    if jy_running():
        raise SystemExit('剪映还开着：请用户完全退出剪映（关掉剪映窗口，不只是回到首页）再重试；剪映开着时草稿在它内存里，改了会被盖掉')


# ---------- 读写草稿 ----------

def tr(seg):
    """片段在时间线上的 (开始, 时长)，微秒；剪映省略值为 0 的字段"""
    t = seg.get('target_timerange') or {}
    return t.get('start', 0), t.get('duration', 0)


class Draft:
    """一个剪映草稿：content 时间线、meta 草稿信息（都是 dict）；加密的自动解，存回时按原样加密"""

    def __init__(self, path, crypto=None):
        self.path, self.name = path, os.path.basename(path)
        self._crypto = crypto
        self.content, self.encrypted = self._read(os.path.join(path, CONTENT))
        self.meta, self.meta_encrypted = self._read(os.path.join(path, META))
        self.mirrors = [p for p in self._copies() if self._read(p)[0] == self.content]
        self._index = None

    @property
    def crypto(self):
        """用到才加载剪映的 dll（明文草稿用不着）"""
        if self._crypto is None:
            self._crypto = jycrypto.JyCrypto()
        return self._crypto

    def _read(self, p):
        raw = open(p, 'rb').read()
        enc = raw[:1] not in (b'{', b'[')
        return json.loads((self.crypto.decrypt(raw) if enc else raw).decode('utf-8')), enc

    def _write(self, p, obj, enc):
        data = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if enc:
            sealed = self.crypto.encrypt(data)
            if self.crypto.decrypt(sealed) != data:
                raise jycrypto.CryptoError(f'加密后解不回原样，{p} 没写')
            data = sealed
        with open(p, 'wb') as f:
            f.write(data)

    def _copies(self):
        """时间线的几处存档：草稿根目录和 Timelines/<时间线 id>/ 里的 draft_content.json、.bak、template-2.tmp"""
        dirs = [self.path, os.path.join(self.path, 'Timelines', str(self.content.get('id', '')))]
        return [os.path.join(d, f) for d in dirs for f in MIRRORS if os.path.isfile(os.path.join(d, f))]

    def save_meta(self):
        self._write(os.path.join(self.path, META), self.meta, self.meta_encrypted)

    def save(self):
        """存回：草稿总长按最后一段算，时间线写进每一处存档，meta 同步总长；写完重读核对"""
        end = max((sum(tr(s)) for t in self.content['tracks'] for s in t.get('segments', [])), default=0)
        self.content['duration'] = end
        self.meta['tm_duration'] = end
        for p in self.mirrors:
            self._write(p, self.content, self.encrypted)
        self.save_meta()
        back = Draft(self.path, self._crypto)
        if back.content != self.content or back.meta != self.meta:
            raise SystemExit(f'草稿「{self.name}」写回后重读对不上')
        self.mirrors = back.mirrors

    # ---------- 片段和素材 ----------

    def segments(self, kind, muted=True):
        """某类轨道（text、audio、video）上的全部片段，按开始时间排；muted=False 时不要静音轨上的"""
        return sorted((s for t in self.content['tracks'] if t.get('type') == kind and (muted or not t.get('attribute', 0) & 1)
                       for s in t.get('segments', [])), key=lambda s: tr(s)[0])

    def _mat(self, mid):
        if self._index is None:                                # 素材 id → (素材类别, 素材)
            self._index = {m['id']: (k, m) for k, lst in self.content['materials'].items() if isinstance(lst, list)
                           for m in lst if isinstance(m, dict) and 'id' in m}
        return self._index.get(mid, (None, {}))

    def material(self, seg):
        return self._mat(seg.get('material_id'))[1]

    def extras(self, seg, kind):
        """片段挂的某类附加素材（如 speeds、loudnesses）"""
        return [m for k, m in map(self._mat, seg.get('extra_material_refs', [])) if k == kind]

    def text(self, seg):
        """字幕片段的文字"""
        c = self.material(seg).get('content', '')
        try:
            return json.loads(c).get('text', '')
        except (ValueError, AttributeError):
            return c

    def media_path(self, mat):
        """素材文件的实际路径（占位符换成本草稿文件夹）"""
        return PLACEHOLDER.sub(lambda m: self.path.replace('\\', '/'), mat.get('path', ''))

    def audio_format(self):
        """第一段音频文件的 (采样率, 声道)，把整条音频做出来时都按这个"""
        segs = self.segments('audio', muted=False)
        if not segs:
            raise SystemExit(f'草稿「{self.name}」里没有音频')
        return tts_align.probe(self.media_path(self.material(segs[0])))[:2]


def backup(root, name, tag='_备份'):
    """草稿复制一份 <草稿名><tag>，已经有了就不再备份（备份留的是第一次改之前的样子）；
    副本的草稿名、路径、id 改成它自己的，剪映里当成另一个草稿；返回 (备份名, 这次备份了没有)"""
    bname = name + tag
    dst = os.path.join(root, bname)
    if os.path.exists(dst):
        return bname, False
    shutil.copytree(os.path.join(root, name), dst)
    b = Draft(dst)
    b.meta.update(draft_name=bname, draft_fold_path=dst.replace('\\', '/'), draft_id=str(uuid.uuid4()).upper())
    b.save_meta()
    return bname, True


# ---------- 音频 ----------

def tempo_filter(speed):
    """变速不变调；atempo 一级只能 0.5～100 倍，慢于 0.5 倍拆成几级"""
    f = []
    while speed < 0.5:
        f.append('atempo=0.5')
        speed /= 0.5
    return f + [f'atempo={speed:.6f}']


def gain(d, seg):
    """片段的音量 × 响度统一（开着时按剪映量好的平均响度调到目标响度）"""
    g = float(seg.get('volume', 1.0))
    for m in d.extras(seg, 'loudnesses'):
        p = m.get('loudness_param') or {}
        if m.get('enable') and 'avg_loudness' in p and 'target_loudness' in m:
            g *= 10 ** ((m['target_loudness'] - p['avg_loudness']) / 20)
    return g


def clip_audio(d, seg, sr, ch):
    """音频片段在时间线上的声音（float32，采样数 × 声道，长度 = 它在时间线上的时长）：取素材里用到的那段，乘上音量和响度统一，
    按倍速变速（不变调）；剪映的人声美化、降噪不做（实测剪映导出的音色和原文件一样）"""
    speed = float(seg.get('speed') or 1.0)
    src = seg.get('source_timerange') or {}
    s0, sd = src.get('start', 0), src.get('duration') or round(tr(seg)[1] * speed)
    path = d.media_path(d.material(seg))
    af = ['-af', ','.join(tempo_filter(speed))] if abs(speed - 1) > 1e-6 else []
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{s0 / US:.6f}', '-t', f'{sd / US:.6f}', '-i', path,
                        '-ac', str(ch), '-ar', str(sr)] + af + ['-f', 'f32le', '-'], capture_output=True)
    if r.returncode:
        raise SystemExit(f'解码失败：{path}\n{r.stderr.decode(errors="replace")[-300:]}')
    x = np.frombuffer(r.stdout, '<f4').reshape(-1, ch)
    n = round(tr(seg)[1] * sr / US)
    x = np.concatenate([x[:n], np.zeros((max(0, n - len(x)), ch), np.float32)])
    return x * np.float32(gain(d, seg))


def mixdown(d, out, sr, ch):
    """草稿里没静音的音频片段按时间线摆好、叠在一起，写成一条 32 位浮点 WAV；叠起来超过满幅就整条降音量；返回时长（秒）"""
    segs = d.segments('audio', muted=False)
    total = max(round(sum(tr(s)) * sr / US) for s in segs)
    mix = np.zeros((total, ch), np.float32)
    for s in segs:
        a = round(tr(s)[0] * sr / US)
        x = clip_audio(d, s, sr, ch)[:total - a]
        mix[a:a + len(x)] += x
    peak = float(np.abs(mix).max())
    if peak > 1:
        mix /= peak
        print(f'配音最响处超过满幅，整条降低 {20 * math.log10(peak):.1f} dB（只改整体音量）')
    tts_align.write_pcm(mix, sr, tts_align.FLOAT, out)
    return total / sr


# ---------- 视频 ----------

def put_video(d, video, old=None):
    """视频放进草稿的视频轨、从 0 秒开始，所有音频轨静音；old：旧视频文件名的规则（正则），视频轨上放着的全符合就换掉；
    放哪条轨：先找放着旧视频的轨，再找空的视频轨，都没有就新建一条放最底层；返回视频时长（秒）"""
    canvas = d.content.get('canvas_config') or {}
    sf = draft.ScriptFile(canvas.get('width', 1920), canvas.get('height', 1080), round(d.content.get('fps', 30)), True)
    ref = sf.append_track(draft.TrackSpec(draft.TrackType.video))
    mat = draft.VideoMaterial(video)
    sf.add_segment(draft.VideoSegment(mat, draft.trange(0, mat.duration)), ref)
    new = json.loads(sf.dumps())                              # 用 pyJianYingDraft 做出新视频的片段和素材，搬进草稿
    vtrack = next(t for t in new['tracks'] if t['type'] == 'video')
    vids = [t for t in d.content['tracks'] if t.get('type') == 'video']
    track = next((t for t in vids if old and t.get('segments') and all(
        old.search(os.path.basename(d.media_path(d.material(s)))) for s in t['segments'])), None)
    track = track or next((t for t in vids if not t.get('segments')), None)
    for k, lst in new['materials'].items():
        if isinstance(lst, list) and lst:
            d.content['materials'].setdefault(k, []).extend(lst)
    d._index = None
    if track:
        track['segments'] = vtrack['segments']
    else:
        d.content['tracks'].insert(0, vtrack)
    for t in d.content['tracks']:
        if t.get('type') == 'audio':
            t['attribute'] = t.get('attribute', 0) | 1          # 静音
    return mat.duration / US
