# -*- coding: utf-8 -*-
"""音频制作（菜单启动，在用户工作目录里运行）：配乐 / 音效轨 / 采样轨 / 混音 + 响度标准化，文件都放在当前稿的 工程文件/第N稿文件/中间文件/
不带任何现成的配乐风格和音效：配乐、音效用什么技术做由 AI 按这条视频定，本工具只负责把做好的声音摆好、混音，路径写在 project.json 里（相对工作目录）
- 配乐（二选一）：music_file 直接填做好的音频文件（用任何工具做的都行）；或 music_py 配乐脚本，提供 build(cfg, total) → 立体声数组 (n,2)（采样率 48000）或音频文件路径
- 音效（可并用，同名以 sfx_files 为准）：sfx_files = {音效名: 做好的音频文件}；或 sfx_py 音效脚本，提供 LIB = {音效名: 函数(rng) → 立体声数组或音频文件路径}，
  可选 LEVEL = {音效名: 基础音量}（默认 1）、VARIANT = {每次随机变化的音效名}
脚本里可以 from synth import …（振荡器、包络、滤波、混响等底层工具），也可以用任何 Python 库、调用外部工具
两种脚本里都能直接用 c(n)、ce(n)：第 n 句字幕的起止秒（n 从 1 开始，和场景脚本一样），配乐换段、重音、停顿都用它写，配音改了自动跟着挪；别把 c、ce 用作自己的变量名
混音：有配音 = 人声 + 配乐（自动给人声让位）+ 音效 + 采样；无配音 = 配乐 + 音效 + 采样，电平看 project.json 的 mix"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import traceback

import numpy as np
from scipy.io import wavfile
from scipy.ndimage import minimum_filter1d

from synth import SR, place, lowpass, highpass, bandpass
from samples import build_samples, decode, duck_env

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.getcwd()                                            # 用户工作目录（运行时所在目录），project.json 里的路径都相对它
ENG = os.path.join(WORK, '工程文件')                            # 与 render.mjs 的 ENG_DIR 一致
BUILD_DIR = '中间文件'                                         # 每稿目录里放中间文件的子目录（与 render.mjs 一致）
CN_DIGIT = '零一二三四五六七八九'
PJ = {}                                                       # 当前项目：dir 工作目录、cfg 配置、build 中间文件目录

MUSIC_DB = -14.0       # 配乐相对人声（说话段 RMS）的电平
DUCK = 0.55            # 说话时配乐再压低的比例（约 -7dB）
TARGET_LUFS = -14.0    # 成片响度
LIMIT_DB = -4.0        # 无配音项目混音的峰值限制线（留足真峰值余量，loudnorm 才会整体等比放大而不是动态压缩）
XFADE = 0.03           # project.json cuts 剪掉时间段后，拼接处的交叉淡化秒数
# 混音默认电平（dB）：无配音时配乐按 RMS 对齐到 -20dBFS 后再加 music；音效、采样按原始电平加增益
MIX_DEFAULT = {'music': 0.0, 'sfx': -8.0, 'samples': -6.0}
# 有配音时：music、sfx 是在按人声自动算好的电平上再加减；samples 同上按原始电平加增益
MIX_VOICE_DEFAULT = {'music': 0.0, 'sfx': 0.0, 'samples': -6.0}


def bpath(name):
    """当前项目中间文件目录下的文件路径"""
    return os.path.join(PJ['build'], name)


def cn_num(n):
    """1～99 转中文数字（与 render.mjs 的 cnNum 一致）"""
    if n < 10:
        return CN_DIGIT[n]
    return (CN_DIGIT[n // 10] if n >= 20 else '') + '十' + (CN_DIGIT[n % 10] if n % 10 else '')


def current_draft():
    """当前稿目录 = 有 project.json 的最大号稿（工程文件/第一稿文件、第二稿文件…），没有返回 None"""
    for n in range(99, 0, -1):
        d = os.path.join(ENG, f'第{cn_num(n)}稿文件')
        if os.path.exists(os.path.join(d, 'project.json')):
            return d
    return None


def load_project():
    d = current_draft()
    if not d:
        raise SystemExit(f'当前目录（{WORK}）的 工程文件/ 里没有已初始化的稿：要在用户工作目录里运行，并先用 render.mjs 选 0 初始化项目')
    print(f'当前稿：工程文件/{os.path.basename(d)}')
    PJ['dir'] = WORK
    PJ['cfg'] = json.load(open(os.path.join(d, 'project.json'), encoding='utf-8'))
    PJ['build'] = os.path.join(d, BUILD_DIR)
    os.makedirs(PJ['build'], exist_ok=True)


def ensure_voice():
    """配音转成 48kHz 双声道 wav（源文件更新过才重转）"""
    src = os.path.join(PJ['dir'], PJ['cfg']['voice'])
    dst = bpath('voice.wav')
    if not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-ar', str(SR), '-ac', '2', '-c:a', 'pcm_s16le', dst], check=True)
        print('配音已转 wav：', dst)
    return dst


def read_wav(path):
    sr, raw = wavfile.read(path)
    if sr != SR:
        raise ValueError(f'{path} 采样率 {sr}，需要 {SR}')
    x = raw.astype(np.float64)
    if raw.dtype == np.int16:
        x /= 32768.0
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    return x


def write_wav(path, x):
    wavfile.write(path, SR, (np.clip(x, -1, 1) * 32767).astype(np.int16))


def voice_activity(v):
    """人声活动度 0..1（20ms 窗 RMS，快起慢落）"""
    mono = v.mean(axis=1)
    hop = int(0.02 * SR)
    nf = len(mono) // hop
    rms = np.sqrt(np.mean(mono[: nf * hop].reshape(nf, hop) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    act = np.clip((db + 42) / 14, 0, 1)
    sm = np.zeros_like(act)
    s = 0.0
    for i, a in enumerate(act):
        s = s + (a - s) * (0.6 if a > s else 0.05)       # 起音快、释放慢
        sm[i] = s
    full = np.repeat(sm, hop)
    full = np.pad(full, (0, len(mono) - len(full)), mode='edge')         # 补齐到人声长度
    return full, rms, act


def load_cues():
    """project.json 的 subs → {句号: (起, 止)}，和场景脚本的 CUES 一样按每段第一行的序号；没有字幕返回空表"""
    rel = PJ['cfg'].get('subs')
    if not rel:
        return {}
    txt = open(os.path.join(PJ['dir'], rel), encoding='utf-8-sig').read().replace('\r', '')
    sec = [3600, 60, 1, 0.001]
    cues = {}
    for blk in re.split(r'\n\s*\n', txt.strip()):
        ls = blk.split('\n')
        m = re.findall(r'(\d+):(\d+):(\d+)[,.](\d+)', ls[1]) if len(ls) > 1 and ls[0].strip().isdigit() else []
        if len(m) == 2:
            cues[int(ls[0])] = tuple(sum(int(v) * k for v, k in zip(t, sec)) for t in m)
    return cues


def cue_time(n, end):
    """第 n 句字幕的起（end=False）或止（end=True）秒，给配乐、音效脚本当 c(n)、ce(n) 用"""
    if 'cues' not in PJ:
        PJ['cues'] = load_cues()
    if n not in PJ['cues']:
        raise SystemExit(f'字幕里没有第 {n} 句（共 {len(PJ["cues"])} 句；没字幕的项目 project.json 没有 subs）')
    return PJ['cues'][n][end]


def load_script(key, label):
    """载入本稿自己写的脚本（project.json 的 music_py / sfx_py），没填或文件不在就报错；脚本里可直接用 c(n)、ce(n)"""
    rel = PJ['cfg'].get(key)
    if not rel:
        raise SystemExit(f'project.json 没有 {key}（{label}）：这条视频的{label}要自己写，路径填进 {key}')
    p = os.path.join(PJ['dir'], rel)
    if not os.path.exists(p):
        raise SystemExit(f'{key} 指向的{label}不存在：{rel}')
    spec = importlib.util.spec_from_file_location(f'project_{key}', p)
    mod = importlib.util.module_from_spec(spec)
    mod.c = lambda n: cue_time(n, False)                      # 和场景脚本一样的写法：时间点跟着字幕走，不写死秒数
    mod.ce = lambda n: cue_time(n, True)
    sys.path.insert(0, HERE)                                  # 脚本里可直接 from synth import …
    spec.loader.exec_module(mod)
    return mod


def as_audio(x, label):
    """脚本交回的声音：立体声数组原样用；音频文件路径（相对工作目录，任何 ffmpeg 能读的格式）解码成 48kHz 立体声"""
    if isinstance(x, (str, os.PathLike)):
        p = os.path.join(PJ['dir'], x)
        if not os.path.exists(p):
            raise SystemExit(f'{label}交回的音频文件不存在：{x}')
        return decode(p)
    return x


def make_music():
    tl = PJ['cfg']
    if tl.get('music_file'):                                     # 配乐是做好的音频文件
        m = as_audio(tl['music_file'], 'project.json 的 music_file ')
    elif tl.get('music_py'):
        mod = load_script('music_py', '配乐脚本')
        print('生成配乐中…')
        m = as_audio(mod.build(tl, tl['duration']), '配乐脚本')
    else:
        raise SystemExit('project.json 里没有配乐：music_file 填做好的配乐音频文件，或 music_py 填配乐脚本')
    write_wav(bpath('music.wav'), m / max(1e-9, np.max(np.abs(m))) * 0.9)
    print('配乐完成：', bpath('music.wav'), f'{len(m) / SR:.2f} 秒')


def make_sfx():
    tl = PJ['cfg']
    if not os.path.exists(bpath('sfx_events.json')):
        raise SystemExit('缺少音效事件表，先在 render.mjs 里选 4 导出')
    events = json.load(open(bpath('sfx_events.json'), encoding='utf-8'))
    files = tl.get('sfx_files', {})                           # 做好的音效文件 {音效名: 路径}
    need = sorted({ev['name'] for ev in events} - set(files))  # 没有现成文件的音效，要靠音效脚本
    if need and not tl.get('sfx_py'):
        raise SystemExit(f'这些音效还没做：{"、".join(need)}（sfx_files 填做好的音效文件，或 sfx_py 填音效脚本）')
    mod = load_script('sfx_py', '音效脚本') if need else None
    lib = {**(mod.LIB if mod else {}), **{k: (lambda rng, f=f: f) for k, f in files.items()}}
    level, variant = getattr(mod, 'LEVEL', {}), getattr(mod, 'VARIANT', set())
    out = np.zeros((int((tl['duration'] + 3) * SR), 2))
    cache, missing = {}, set()
    for ev in events:
        name = ev['name']
        if name not in lib:
            missing.add(name)
            continue
        if name in variant:
            clip = as_audio(lib[name](np.random.default_rng(int(ev['t'] * 1000))), f'音效 {name} ')
        else:
            if name not in cache:
                cache[name] = as_audio(lib[name](np.random.default_rng(1)), f'音效 {name} ')
            clip = cache[name]
        p = float(ev.get('pan', 0))
        if p:
            clip = np.stack([clip[:, 0] * min(1, 1 - p), clip[:, 1] * min(1, 1 + p)], axis=1)
        place(out, clip, ev['t'], level.get(name, 1.0) * float(ev.get('gain', 1)))
    if missing:
        raise SystemExit(f'sfx_files 和音效脚本（sfx_py）的 LIB 里都没有这些音效：{"、".join(sorted(missing))}')
    out = out[: int(tl['duration'] * SR)]
    write_wav(bpath('sfx.wav'), out * 0.9 / max(1e-9, np.max(np.abs(out))))
    np.save(bpath('sfx_scale.npy'), np.array([0.9 / max(1e-9, np.max(np.abs(out)))]))
    print('音效轨完成：', bpath('sfx.wav'), f'{len(events)} 个事件')


def make_samples():
    """采样轨（保留原始电平，存 float wav）"""
    tl = PJ['cfg']
    f = bpath('samples.json')
    if not os.path.exists(f):
        raise SystemExit('缺少采样事件表，先在 render.mjs 里选 4 导出')
    sp = json.load(open(f, encoding='utf-8'))
    x = build_samples(PJ['dir'], sp['samples'], tl['duration'])
    wavfile.write(bpath('samples.wav'), SR, x.astype(np.float32))
    print('采样轨完成：', bpath('samples.wav'), f"{len(sp['samples'])} 个事件，峰值 {20 * np.log10(max(1e-9, np.max(np.abs(x)))):.1f}dB")


def measure_loudness(src):
    """ffmpeg loudnorm 第一遍：测响度（返回 input_i 等测量值）"""
    flt = f'loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json'
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', src, '-af', flt, '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', errors='ignore')
    return json.loads(r.stderr[r.stderr.rfind('{'): r.stderr.rfind('}') + 1])


def limit(x, ceil, look=0.005, rel=0.08):
    """峰值限制器：尖峰提前 look 秒压到 ceil 以下，rel 秒内慢慢放回（按 1ms 一块算增益再插值）"""
    blk = SR // 1000
    n = len(x) // blk + 1
    a = np.pad(np.max(np.abs(x), axis=1), (0, n * blk - len(x)))
    need = minimum_filter1d(np.minimum(1, ceil / np.maximum(a.reshape(n, blk).max(axis=1), 1e-9)), size=2 * int(look * 1000) + 1)
    g = np.empty(n)
    cur, k = 1.0, 1 - np.exp(-1 / (rel * 1000))
    for i in range(n):
        cur = need[i] if need[i] < cur else cur + (need[i] - cur) * k
        g[i] = cur
    return x * np.interp(np.arange(len(x)), np.arange(n) * blk + blk / 2, g)[:, None]


def loudnorm(src, dst):
    """ffmpeg 两遍响度标准化"""
    mv = measure_loudness(src)
    flt2 = (f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11:measured_I={mv['input_i']}:measured_TP={mv['input_tp']}:"
            f"measured_LRA={mv['input_lra']}:measured_thresh={mv['input_thresh']}:offset={mv['target_offset']}:linear=true")
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', flt2, '-ar', str(SR), dst], check=True)
    print(f"响度：原 {mv['input_i']} LUFS → 目标 {TARGET_LUFS} LUFS")


def fit(x, n):
    """补零或截断到 n 个采样"""
    return np.pad(x, ((0, max(0, n - len(x))), (0, 0)))[:n]


def apply_cuts(x, cuts):
    """剪掉 cuts 里的时间段（脚本时间，和画面跳过的段一致），拼接处等功率交叉淡化"""
    if not cuts:
        return x
    h = int(XFADE * SR / 2)
    k = np.linspace(0, np.pi / 2, 2 * h)[:, None]
    parts, pos = [], 0
    for a, b in sorted(cuts):
        ia, ib = int(round(a * SR)), int(round(b * SR))
        parts.append(x[pos:ia - h])
        parts.append(x[ia - h:ia + h] * np.cos(k) + x[ib - h:ib + h] * np.sin(k))
        pos = ib + h
    parts.append(x[pos:])
    return np.concatenate(parts)


def load_ducks():
    """场景里 duckMusic 登记的配乐闪避段（render.mjs 菜单 4 导出），没导出返回空"""
    f = bpath('samples.json')
    return json.load(open(f, encoding='utf-8'))['ducks'] if os.path.exists(f) else []


def make_mix_novoice():
    """无配音项目：配乐（RMS 对齐 + 闪避）+ 音效 + 采样"""
    tl = PJ['cfg']
    mx = dict(MIX_DEFAULT, **tl.get('mix', {}))
    n = int(tl['duration'] * SR)
    m = fit(read_wav(bpath('music.wav')), n)
    s = fit(read_wav(bpath('sfx.wav')) / float(np.load(bpath('sfx_scale.npy'))[0]), n) if os.path.exists(bpath('sfx.wav')) else np.zeros((n, 2))
    a = fit(read_wav(bpath('samples.wav')), n) if os.path.exists(bpath('samples.wav')) else np.zeros((n, 2))
    ducks = load_ducks()
    m_rms = float(np.sqrt(np.mean(m ** 2)))
    music = m * (10 ** ((-20 + mx['music']) / 20) / max(1e-9, m_rms)) * duck_env(ducks, n)[:, None]
    mix = music + s * 10 ** (mx['sfx'] / 20) + a * 10 ** (mx['samples'] / 20)
    cuts = tl.get('cuts', [])
    mix = apply_cuts(mix, cuts)
    if cuts:
        print(f'剪掉 {len(cuts)} 段，成片音频 {len(mix) / SR:.3f} 秒')
    pk = float(np.max(np.abs(mix)))
    if pk > 0.95:
        mix *= 0.95 / pk
    print(f"配乐 {mx['music']:+.0f}dB  音效 {mx['sfx']:+.0f}dB  采样 {mx['samples']:+.0f}dB  闪避 {len(ducks)} 段  混音峰值 {20 * np.log10(pk):.1f}dB")
    write_wav(bpath('mix_raw.wav'), mix)
    gain = TARGET_LUFS - float(measure_loudness(bpath('mix_raw.wav'))['input_i'])   # 先把响度推到目标，再用限制器压尖峰，
    mix = limit(mix * 10 ** (gain / 20), 10 ** (LIMIT_DB / 20))                     # 这样 loudnorm 能走线性模式，不做动态压缩
    print(f'限制器：整体 {gain:+.1f}dB，峰值压到 {LIMIT_DB}dB')
    write_wav(bpath('mix_raw.wav'), mix)
    loudnorm(bpath('mix_raw.wav'), bpath('mix.wav'))
    print('混音完成：', bpath('mix.wav'))


def make_mix():
    if not PJ['cfg'].get('voice'):
        make_mix_novoice()
        return
    mx = dict(MIX_VOICE_DEFAULT, **PJ['cfg'].get('mix', {}))
    v = read_wav(ensure_voice())
    m = read_wav(bpath('music.wav'))
    s = read_wav(bpath('sfx.wav')) / float(np.load(bpath('sfx_scale.npy'))[0])
    n = len(v)
    m = fit(m, n)
    s = fit(s, n)
    a = fit(read_wav(bpath('samples.wav')), n) if os.path.exists(bpath('samples.wav')) else np.zeros((n, 2))   # 采样（游戏原声、录好的台词等）按原始电平
    act, rms, act_raw = voice_activity(v)
    speak = act_raw > 0.6
    v_rms = float(np.sqrt(np.mean(rms[speak] ** 2)))
    hop = int(0.02 * SR)
    vm = np.abs(v.mean(axis=1))[: len(speak) * hop]
    v_peak = float(np.percentile(vm[np.repeat(speak, hop)], 99.5))
    m = lowpass(highpass(m, 35), 11000)                                  # 给人声让位：去超低频、压高频
    m = m - 0.35 * bandpass(m, 1000, 4000)                               # 人声清晰度频段下挖约 3dB
    m_rms = float(np.sqrt(np.mean(m ** 2)))
    mg = v_rms * 10 ** ((MUSIC_DB + mx['music']) / 20) / max(1e-9, m_rms)
    ducks = load_ducks()
    duck = (1 - DUCK * act) * duck_env(ducks, n)                         # 说话时自动让位，再叠上场景登记的闪避段
    music = m * mg * duck[:, None]
    sfx = s * v_peak * 0.9 * 10 ** (mx['sfx'] / 20)
    mix = v + music + sfx + a * 10 ** (mx['samples'] / 20)
    pk = np.max(np.abs(mix))
    if pk > 0.98:
        mix *= 0.98 / pk
    print(f'人声RMS {20 * np.log10(v_rms):.1f}dB  人声峰值 {20 * np.log10(v_peak):.1f}dB  配乐增益 {20 * np.log10(mg):.1f}dB  '
          f"配乐 {mx['music']:+.0f}dB  音效 {mx['sfx']:+.0f}dB  采样 {mx['samples']:+.0f}dB  闪避 {len(ducks)} 段  混音峰值 {20 * np.log10(pk):.1f}dB")
    write_wav(bpath('mix_raw.wav'), mix)
    loudnorm(bpath('mix_raw.wav'), bpath('mix.wav'))
    print('混音完成：', bpath('mix.wav'))


def main():
    print('==== 音频制作 ====\n1. 生成配乐\n2. 生成音效轨\n3. 混音（人声/配乐/音效/采样，响度标准化）\n4. 全部执行\n5. 生成采样轨（游戏原声、实机原声）')
    ch = input('请选择: ').strip()
    load_project()
    if ch in ('1', '4'):
        make_music()
    if ch in ('2', '4'):
        make_sfx()
    if ch in ('5', '4') and os.path.exists(bpath('samples.json')):
        make_samples()
    if ch in ('3', '4'):
        make_mix()


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
