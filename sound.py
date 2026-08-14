#!/usr/bin/env python3
"""dsh-plugin-notify 音效合成器：标准库生成通知音效（wav）到 ~/.dsh/notify/sounds/
用法：python sound.py [--force]
音效：
  explode  = 炸裂（低频冲击 + 噪声爆裂 + 滑音）——默认
  success  = 胜利琶音（C-E-G-C）
  alarm    = 警报（方波断续）
  notify   = 清脆双音
"""
import argparse
import math
import os
import random
import struct
import sys
import wave

RATE = 44100


def _write_wav(path, samples):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        frames = b''.join(
            struct.pack('<h', max(-32767, min(32767, int(s * 32767))))
            for s in samples
        )
        w.writeframes(frames)


def _tone(freq, dur, vol=1.0, attack=0.005, decay=0.05):
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        env = 1.0
        if t < attack:
            env = t / attack
        if t > dur - decay:
            env = max(0.0, (dur - t) / decay)
        out.append(vol * env * math.sin(2 * math.pi * freq * t))
    return out


def _noise(dur, vol=1.0, attack=0.002, decay=0.1):
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        env = 1.0
        if t < attack:
            env = t / attack
        if t > dur - decay:
            env = max(0.0, (dur - t) / decay)
        out.append(vol * env * random.uniform(-1, 1))
    return out


def _slide(f0, f1, dur, vol=1.0, decay=0.3):
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        freq = f0 + (f1 - f0) * (t / dur)
        env = 1.0
        if t > dur - decay:
            env = max(0.0, (dur - t) / decay)
        # 累积相位避免频率跳变
        phase = 2 * math.pi * (f0 * t + (f1 - f0) * t * t / (2 * dur))
        out.append(vol * env * math.sin(phase))
    return out


def _mix(*tracks):
    n = max(len(t) for t in tracks)
    out = [0.0] * n
    for t in tracks:
        for i, v in enumerate(t):
            out[i] += v
    peak = max(1.0, max(abs(v) for v in out))
    return [v / peak * 0.95 for v in out]


def _silence(dur):
    return [0.0] * int(RATE * dur)


def make_explode():
    """炸裂：低频冲击 + 噪声爆裂 + 滑音收尾（约 0.9s）"""
    impact = _slide(120, 40, 0.35, vol=1.0, decay=0.3)          # 低频冲击下滑
    burst = _noise(0.22, vol=0.9, decay=0.18)                    # 噪声爆裂
    tail = _slide(300, 900, 0.35, vol=0.4, decay=0.3)            # 高频滑音点缀
    # _mix 自动按最长轨对齐（短轨尾部视为静音），无需手动补齐
    return _mix(impact, burst, tail)


def make_success():
    """胜利琶音：C5-E5-G5-C6（约 0.8s）"""
    notes = [(523.25, 0.14), (659.25, 0.14), (783.99, 0.14), (1046.5, 0.3)]
    out = []
    for freq, dur in notes:
        out += _tone(freq, dur, vol=0.8, decay=dur * 0.5)
    return out


def make_alarm():
    """警报：880Hz 方波断续三次（约 1.1s）"""
    out = []
    for _ in range(3):
        n = int(RATE * 0.16)
        out += [0.6 if int(i / RATE * 880) % 2 == 0 else -0.6 for i in range(n)]
        out += _silence(0.12)
    return out


def make_notify():
    """清脆双音：E6 → A6（约 0.4s）"""
    return _tone(1318.5, 0.16, vol=0.7, decay=0.08) + _tone(1760.0, 0.24, vol=0.7, decay=0.15)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true', help='重新生成所有音效')
    args = parser.parse_args()

    home = os.environ.get('USERPROFILE') or os.path.expanduser('~')
    sounds_dir = os.path.join(home, '.dsh', 'notify', 'sounds')
    makers = {
        'explode': make_explode,
        'success': make_success,
        'alarm': make_alarm,
        'notify': make_notify,
    }
    for name, maker in makers.items():
        path = os.path.join(sounds_dir, name + '.wav')
        if args.force or not os.path.exists(path):
            _write_wav(path, maker())
            print(f'生成 {name}.wav')
        else:
            print(f'已存在 {name}.wav')
    print(f'音效目录: {sounds_dir}')


if __name__ == '__main__':
    main()
