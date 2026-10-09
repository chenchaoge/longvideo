# -*- coding: utf-8 -*-
"""通用合成工具：振荡器、包络、滤波、混响、声像等（配乐和音效共用）"""
import numpy as np
from scipy import signal

SR = 48000  # 采样率


def t_axis(dur):
    """时间轴（秒）"""
    return np.arange(int(round(dur * SR))) / SR


def midi_hz(m):
    """MIDI 音高转频率"""
    return 440.0 * 2 ** ((np.asarray(m, dtype=float) - 69) / 12)


def phase_of(freq, n):
    """频率（常数或逐点数组）积分成相位"""
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    return 2 * np.pi * np.cumsum(f) / SR


def sine(freq, dur):
    n = int(round(dur * SR))
    return np.sin(phase_of(freq, n))


def saw(freq, dur):
    """朴素锯齿波（后面会过低通）"""
    n = int(round(dur * SR))
    ph = phase_of(freq, n) / (2 * np.pi)
    return 2 * (ph - np.floor(ph + 0.5))


def square(freq, dur, duty=0.5):
    n = int(round(dur * SR))
    ph = (phase_of(freq, n) / (2 * np.pi)) % 1.0
    return np.where(ph < duty, 1.0, -1.0)


def tri(freq, dur):
    return 2 * np.abs(saw(freq, dur)) - 1


def noise(dur, seed=0):
    rs = np.random.default_rng(seed)
    return rs.uniform(-1, 1, int(round(dur * SR)))


def exp_env(dur, decay, attack=0.002):
    """指数衰减包络（带极短起音防爆音）"""
    t = t_axis(dur)
    e = np.exp(-t / decay)
    if attack > 0:
        e *= np.clip(t / attack, 0, 1)
    return e


def adsr(dur, a=0.01, d=0.1, s=0.7, r=0.2):
    """ADSR 包络，dur 为总时长（含释放）"""
    n = int(round(dur * SR))
    t = np.arange(n) / SR
    hold = max(dur - r, a + d)
    e = np.where(t < a, t / max(a, 1e-6),
                 np.where(t < a + d, 1 - (1 - s) * (t - a) / max(d, 1e-6), s))
    rel = np.clip((t - hold) / max(r, 1e-6), 0, 1)
    return e * (1 - rel)


def bell(dur, peak=0.5):
    """钟形包络：0→1→0，peak 为峰值位置比例"""
    t = t_axis(dur) / dur
    return np.where(t < peak, np.sin(t / peak * np.pi / 2) ** 2, np.cos((t - peak) / (1 - peak) * np.pi / 2) ** 2)


def _sos(kind, f, order=2):
    nyq = SR / 2
    if kind in ('bandpass', 'bandstop'):
        wn = [max(20, f[0]) / nyq, min(f[1], nyq * 0.95) / nyq]
    else:
        wn = min(max(f, 20), nyq * 0.95) / nyq
    return signal.butter(order, wn, btype=kind, output='sos')


def lowpass(x, f, order=2):
    return signal.sosfilt(_sos('lowpass', f, order), x, axis=0)


def highpass(x, f, order=2):
    return signal.sosfilt(_sos('highpass', f, order), x, axis=0)


def bandpass(x, lo, hi, order=2):
    return signal.sosfilt(_sos('bandpass', (lo, hi), order), x, axis=0)


def sweep_filter(x, f0, f1, q=4.0, kind='bp'):
    """时变状态变量滤波器（逐点，适合短音效）"""
    n = len(x)
    fc = np.geomspace(max(f0, 20), max(f1, 20), n)
    g = np.tan(np.pi * np.clip(fc, 20, SR * 0.45) / SR)
    k = 1.0 / q
    ic1 = ic2 = 0.0
    out = np.zeros(n)
    for i in range(n):
        gi = g[i]
        a1 = 1 / (1 + gi * (gi + k))
        v3 = x[i] - ic2
        v1 = a1 * ic1 + gi * a1 * v3
        v2 = ic2 + gi * v1
        ic1 = 2 * v1 - ic1
        ic2 = 2 * v2 - ic2
        out[i] = v1 if kind == 'bp' else v2 if kind == 'lp' else x[i] - k * v1 - v2
    return out


def pan(mono, p=0.0):
    """等功率声像，p∈[-1,1] → 立体声 (n,2)"""
    a = (p + 1) * np.pi / 4
    return np.stack([mono * np.cos(a), mono * np.sin(a)], axis=1)


def stereo(mono):
    return np.stack([mono, mono], axis=1)


_IR = {}


def reverb(x, decay=1.6, mix=0.25, seed=7, pre=0.012, tone=6000):
    """卷积混响：指数衰减的立体声噪声冲激响应"""
    key = (decay, seed, pre, tone)
    if key not in _IR:
        n = int(decay * 1.6 * SR)
        t = np.arange(n) / SR
        rs = np.random.default_rng(seed)
        ir = rs.standard_normal((n, 2)) * np.exp(-t / (decay / 6.9))[:, None]
        ir = lowpass(ir, tone)
        ir[: int(pre * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2, axis=0, keepdims=True))
        _IR[key] = ir
    ir = _IR[key]
    if x.ndim == 1:
        x = stereo(x)
    wet = np.stack([signal.fftconvolve(x[:, 0], ir[:, 0]), signal.fftconvolve(x[:, 1], ir[:, 1])], axis=1)
    out = np.zeros_like(wet)
    out[: len(x)] += x * (1 - mix)
    out += wet * mix
    return out


def normalize(x, peak=1.0):
    m = np.max(np.abs(x))
    return x * (peak / m) if m > 0 else x


def fade(x, fin=0.003, fout=0.01):
    """首尾淡入淡出，防爆音"""
    n = len(x)
    a, b = min(n, int(fin * SR)), min(n, int(fout * SR))
    env = np.ones(n)
    if a > 0:
        env[:a] = np.linspace(0, 1, a)
    if b > 0:
        env[n - b:] *= np.linspace(1, 0, b)
    return x * (env[:, None] if x.ndim == 2 else env)


def place(track, clip, t, gain=1.0):
    """把片段叠加到总轨 t 秒处"""
    i = int(round(t * SR))
    if i >= len(track) or i + len(clip) <= 0:
        return
    j0 = max(0, -i)
    i = max(0, i)
    n = min(len(clip) - j0, len(track) - i)
    track[i:i + n] += clip[j0:j0 + n] * gain


def soft_clip(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)
