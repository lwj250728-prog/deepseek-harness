#!/usr/bin/env python3
"""在用模型 vs 供应商实时目录的一致性检查（cl-105 / tp-069 / T86）。

cl-105 的根因：巡检的"真相源"是插件里的硬编码模型清单（`llm-deepseek` 的 MODELS
常量），不是供应商的实时目录，所以它结构上不可能发现到期——2026-09-10 实测：
心跳 `model-ok {model: deepseek-v4.1-flash-expires-on-0910}`，而直查
`api.deepseek.com/v1/models` 该模型已不在目录中。

本脚本把"实时目录 vs 在用模型"的差异变成落盘事实（不改变巡检行为）：
  · 读 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY
  · GET https://api.deepseek.com/v1/models
  · 与"在用模型"比对（优先取最近一条 model-ok 心跳里的模型，否则取 profile 默认）
  · 结果写 model-catalog.json（含目录快照、在用模型、是否缺失、检查时间）

用法：dsh-model-catalog-check.py [--quiet]
退出码：0 = 一致或无法判定；1 = 在用模型不在实时目录中（差异存在）。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import urllib.request

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
CRED = os.path.expanduser('~/.dsh/.credentials.yaml')
PROFILE = os.path.expanduser('~/.dsh/profiles/web/cordis.patch.yml')
HEARTBEAT = os.path.join(DIR, 'quiet-driver-heartbeat.jsonl')
OUT = os.path.join(DIR, 'model-catalog.json')
ENDPOINT = 'https://api.deepseek.com/v1/models'


def api_key() -> str | None:
    try:
        import yaml
        data = yaml.safe_load(open(CRED, encoding='utf8')) or {}
    except Exception:
        return None
    value = data.get('DEEPSEEK_API_KEY')
    return value if isinstance(value, str) and value else None


def profile_default_model() -> str | None:
    """The profile's configured model — the fallback target when a wake can't
    reuse the session model (cl-129: it turned out to be delisted too)."""
    if not os.path.exists(PROFILE):
        return None
    for line in open(PROFILE, encoding='utf8'):
        stripped = line.strip()
        if stripped.startswith('model:'):
            return stripped.split(':', 1)[1].strip()
    return None


def model_in_use() -> str | None:
    """Last model the patrol reported as available (the live carrier model)."""
    if os.path.exists(HEARTBEAT):
        last = None
        for line in open(HEARTBEAT, encoding='utf8'):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get('reason') in ('model-ok', 'model-check-unknown', 'model-unavailable'):
                model = (record.get('model') if isinstance(record.get('model'), str)
                         else (record.get('data') or {}).get('model'))
                if isinstance(model, str):
                    last = model
        if last:
            return last
    if os.path.exists(PROFILE):
        for line in open(PROFILE, encoding='utf8'):
            stripped = line.strip()
            if stripped.startswith('model:'):
                return stripped.split(':', 1)[1].strip()
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()

    in_use = model_in_use()
    default_model = profile_default_model()
    key = api_key()
    result: dict = {
        'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'checkedAtLocal': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'endpoint': ENDPOINT,
        'modelInUse': in_use,
        'profileDefault': default_model,
        'catalog': None,
        'missingFromCatalog': None,
        'verdict': 'unknown',
    }
    if key is None or in_use is None:
        result['verdict'] = 'unknown'
        result['reason'] = 'no api key' if key is None else 'no in-use model found'
    else:
        try:
            request = urllib.request.Request(ENDPOINT, headers={'Authorization': f'Bearer {key}'})
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.load(response)
            ids = [entry.get('id') for entry in payload.get('data', []) if isinstance(entry, dict)]
            result['catalog'] = ids
            result['missingFromCatalog'] = in_use not in ids
            result['defaultMissingFromCatalog'] = (default_model not in ids) if default_model else None
            # 回退目标也在目录里才算"换模路径可用"; 只查在用模型会漏掉"回退也下架"(cl-129)。
            if in_use not in ids and default_model is not None and default_model not in ids:
                result['verdict'] = 'in-use-and-default-missing'
            elif in_use not in ids:
                result['verdict'] = 'missing'
            else:
                result['verdict'] = 'present'
        except Exception as error:  # network/credential failure is "unknown", never a silent pass
            result['verdict'] = 'unknown'
            result['reason'] = f'{type(error).__name__}: {str(error)[:160]}'

    with open(OUT, 'w', encoding='utf8') as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    if not args.quiet:
        print('在用模型 %s | profile 默认 %s | 实时目录 %s | 判定 %s'
              % (result['modelInUse'], result.get('profileDefault'), result['catalog'], result['verdict']))
        if result['verdict'] == 'missing':
            print('差异: 在用模型已不在供应商目录中(巡检因真相源是硬编码清单而报 model-ok)——见 cl-105',
                  file=sys.stderr)
    return 1 if str(result['verdict']).endswith('missing') else 0


if __name__ == '__main__':
    raise SystemExit(main())
