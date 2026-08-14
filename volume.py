#!/usr/bin/env python3
"""dsh-plugin-notify 音量控制（pycaw / Windows CoreAudio）
用法：
  python volume.py get
  python volume.py set <0-100>
  python volume.py boost    （记住当前音量，调到最大）
  python volume.py restore  （恢复 boost 前的音量）
备份文件：~/.dsh/notify/volume.backup
"""
import json
import os
import sys

from pycaw.pycaw import AudioUtilities

BACKUP = os.path.join(os.environ.get('USERPROFILE', ''), '.dsh', 'notify', 'volume.backup')


def _vol():
    return AudioUtilities.GetSpeakers().EndpointVolume


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'get'
    vol = _vol()
    if action == 'get':
        print(json.dumps({'volume': round(vol.GetMasterVolumeLevelScalar() * 100)}))
    elif action == 'set':
        level = max(0, min(100, int(sys.argv[2] if len(sys.argv) > 2 else 100)))
        vol.SetMasterVolumeLevelScalar(level / 100, None)
        print(json.dumps({'volume': level}))
    elif action == 'boost':
        pct = round(vol.GetMasterVolumeLevelScalar() * 100)
        os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
        with open(BACKUP, 'w', encoding='ascii') as f:
            f.write(str(pct))
        vol.SetMasterVolumeLevelScalar(1.0, None)
        print(json.dumps({'volume': 100, 'saved': pct}))
    elif action == 'restore':
        if os.path.exists(BACKUP):
            with open(BACKUP, encoding='ascii') as f:
                pct = int(f.read().strip())
            vol.SetMasterVolumeLevelScalar(max(0, min(100, pct)) / 100, None)
            os.remove(BACKUP)
            print(json.dumps({'volume': pct}))
        else:
            print(json.dumps({'volume': None}))
    else:
        print(json.dumps({'error': 'unknown action'}))


if __name__ == '__main__':
    main()
