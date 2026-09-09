#!/usr/bin/env python3
"""dsh-weights-provenance.py — 给检索通道权重打"来源模型"标签（cl-086 换模清单第 2 项）。

为什么需要：`channel_weights.json` 是 EWMA 学出来的，**对本库、本 tokenization、以及当时
在跑的模型过拟合**。WikiSkill(arXiv 2608.27454) 的结论是"知识层可跨模型迁移、模型特定绕路须重估"——
权重属于后者。换模后如果继续沿用旧权重，等于把 A 模型的偏好喂给 B 模型，且没有任何记录可追溯。

本脚本把当前权重 + 当时的模型 id 追加到 `channel-weights-provenance.jsonl`（只追加，不改权重本身），
换模时对照该账本即可判断"这批权重是在哪个模型下学出来的"。

用法: python3 dsh-weights-provenance.py [--note "换模说明"]
"""
import json, os, sys, datetime, glob, subprocess

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
TZ = datetime.timezone(datetime.timedelta(hours=8))
NOW = datetime.datetime.now(TZ)


def current_model() -> str | None:
    """从最近的心跳/会话日志里取当前模型 id。"""
    hb = os.path.join(D, 'quiet-driver-heartbeat.jsonl')
    if os.path.exists(hb):
        for line in reversed(open(hb, encoding='utf8').read().splitlines()):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get('model'):
                return str(r['model'])
    # 回退: 会话日志里最后一个 request/header
    for path in glob.glob(os.path.expanduser('~/.dsh/sessions/*/session-*/session.jsonl.zstd')):
        try:
            raw = subprocess.run(['zstd', '-dc', path], capture_output=True, text=True, timeout=60).stdout
        except Exception:
            continue
        last = None
        for line in raw.splitlines():
            if '"request/header"' in line:
                try:
                    d = json.loads(line)
                    cfg = (d.get('data') or {}).get('header', {}).get('config')
                    if cfg and cfg.get('model'):
                        last = cfg['model']
                except Exception:
                    continue
        if last:
            return str(last)
    return None


def main() -> int:
    weights_path = os.path.join(D, 'channel_weights.json')
    if not os.path.exists(weights_path):
        print('[weights-provenance] channel_weights.json 不存在')
        return 1
    weights = json.load(open(weights_path, encoding='utf8'))
    model = current_model()
    note = ''
    if '--note' in sys.argv:
        note = sys.argv[sys.argv.index('--note') + 1]
    record = {
        'ts': NOW.isoformat(),
        'model': model,
        'weights': weights,
        'note': note or '例行打标',
    }
    out = os.path.join(D, 'channel-weights-provenance.jsonl')
    with open(out, 'a', encoding='utf8') as f:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')
    print(f"[weights-provenance] 已打标: model={model} lexical={weights.get('lexical')}")
    # 列出历史上出现过的模型(便于换模时判断权重跨了几个模型)
    models = []
    for line in open(out, encoding='utf8'):
        if line.strip():
            m = json.loads(line).get('model')
            if m and m not in models:
                models.append(m)
    print('[weights-provenance] 该权重文件至今在以下模型下被打过标: %s' % ', '.join(models))
    return 0


if __name__ == '__main__':
    sys.exit(main())
