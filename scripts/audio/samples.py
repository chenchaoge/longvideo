# -*- coding: utf-8 -*-
"""采样轨：把动画里登记的音频采样事件（游戏原声、实机录像原声等现成音频）按时间摆到一条轨上"""
import os
import subprocess

import numpy as np

from synth import SR, place

_DEC = {}                                                     # (文件, 变速) → 解码后的立体声


def decode(path, rate=1.0):
    """用 ffmpeg 解码成 48kHz 立体声 float；rate≠1 时连音调一起变（像磁带快放/慢放）"""
    key = (path, rate)
    if key not in _DEC:
        af = ['-af', f'asetrate={int(SR * rate)},aresample={SR}'] if rate != 1 else []
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, *af, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'],
                             capture_output=True, check=True).stdout
        _DEC[key] = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)
    return _DEC[key]


def active_rms(x):
    """有声部分的 RMS（去掉静音帧，避免把带空白的片段拉得过响）"""
    hop = int(0.05 * SR)
    n = max(1, len(x) // hop)
    pw = np.mean(x[: n * hop].reshape(n, -1) ** 2, axis=1) + 1e-12
    return float(np.sqrt(np.mean(pw[pw > pw.max() * 1e-3])))


def build_samples(project_dir, events, total):
    """events: [{t, file, ss, dur, gain, pan, fi, fo, rate}] → 立体声轨"""
    out = np.zeros((int((total + 3) * SR), 2))
    missing = set()
    for ev in events:
        p = os.path.join(project_dir, ev['file'])
        if not os.path.exists(p):
            missing.add(ev['file'])
            continue
        x = decode(p, float(ev.get('rate', 1)))
        i0 = int(float(ev.get('ss', 0)) * SR)
        i1 = len(x) if ev.get('dur') is None else min(len(x), i0 + int(float(ev['dur']) * SR))
        clip = x[i0:i1].copy()
        if not len(clip):
            continue
        if ev.get('norm') is not None:                        # 响度拉齐：按有声部分（比最响处低 30dB 以内的 50ms 帧）算 RMS
            clip *= 10 ** (float(ev['norm']) / 20) / active_rms(clip)
        fi, fo = int(float(ev.get('fi', 0.005)) * SR), int(float(ev.get('fo', 0.03)) * SR)
        if fi > 0:
            clip[: min(fi, len(clip))] *= np.linspace(0, 1, min(fi, len(clip)))[:, None]
        if fo > 0:
            clip[-min(fo, len(clip)):] *= np.linspace(1, 0, min(fo, len(clip)))[:, None]
        pn = float(ev.get('pan', 0))
        if pn:
            clip = np.stack([clip[:, 0] * min(1, 1 - pn), clip[:, 1] * min(1, 1 + pn)], axis=1)
        place(out, clip, float(ev['t']), float(ev.get('gain', 1)))
    if missing:
        print('【缺少采样文件】', sorted(missing))
    return out[: int(total * SR)]


def duck_env(ducks, n):
    """配乐闪避包络：每段 [t0,t1] 压到 level，前后 ramp 秒线性过渡；多段取最小"""
    env = np.ones(n)
    tt = np.arange(n) / SR
    for d in ducks:
        r = max(1e-3, float(d.get('ramp', 0.25)))
        a = np.clip(np.minimum((tt - (d['t0'] - r)) / r, ((d['t1'] + r) - tt) / r), 0, 1)
        env = np.minimum(env, 1 - (1 - float(d['level'])) * a)
    return env
