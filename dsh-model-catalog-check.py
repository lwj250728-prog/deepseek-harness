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
import subprocess
import sys
import urllib.request

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
CRED = os.path.expanduser('~/.dsh/.credentials.yaml')
PROFILE = os.path.expanduser('~/.dsh/profiles/web/cordis.patch.yml')
HEARTBEAT = os.path.join(DIR, 'quiet-driver-heartbeat.jsonl')
OUT = os.path.join(DIR, 'model-catalog.json')
ENDPOINT = 'https://api.deepseek.com/v1/models'
MAIN_SESSION = 'session-63251d85-ef77-4299-939d-9a6fe9b5bec6'


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


SETTINGS = os.path.expanduser('~/.dsh/settings.yaml')


def configured_model() -> str | None:
    """配置现值: settings.yaml 的 agent-default-model.model(效果证据的一半)。

    2026-09-10 22:0x 实证(cl-161): 原 model_in_use() 只读**心跳历史**最后一条 model-* 记录,
    于是配置已改成 `deepseek-flash`(供应商广告清单内的 id)、响应侧也在返回该 id 时,
    判定仍拿旧心跳报 `deepseek-v4-flash` → 得出"缺失/降级"的**过时结论**(巡检与响应侧互相打脸)。
    判据应锚在"现在配的是什么 + 服务端现在返回什么", 历史心跳只作兜底。
    """
    try:
        import yaml
        data = yaml.safe_load(open(SETTINGS, encoding='utf8')) or {}
    except Exception:
        return None
    node = data.get('agent-default-model') if isinstance(data, dict) else None
    if isinstance(node, dict) and isinstance(node.get('model'), str):
        return node['model']
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


def response_evidence(minutes: int = 30) -> dict:
    """响应侧证据: 服务端实际返回的模型名 + 最近一次成功回合时间。

    2026-09-10 21:5x 的分歧: 插件目录说"在用 deepseek-v4-flash 在册"(它比的是**本地清单**),
    供应商实时目录却查无此 id ⇒ 我原来的判定只有"missing"一个词, 于是把"**未登广告但正在服务**"
    与"**真不可用**"混为一谈(cl-126 家族)。本函数提供分开两者所需的证据:
      · latest: 会话日志里最后一条带 model 字段的记录(响应侧, 效果证据)
      · serving: latest 的模型名 == 在用模型, 且其时间在 minutes 分钟内
    流式读取, 只保留计数与最近若干条 —— 不把解压结果整份读进内存(cl-155)。
    """
    import glob
    import re
    pattern = os.path.join(os.path.expanduser('~/.dsh/sessions'), '*', '*', 'session.jsonl.zstd')
    paths = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    main = [p for p in paths if MAIN_SESSION in p]
    if main:
        paths = main + [p for p in paths if p not in main]
    if not paths:
        return {'error': 'no session log'}
    model_re = re.compile(r'"model":"(deepseek[^"]*)"')
    time_re = re.compile(r'"time":(\d{13})')
    counts: dict[str, int] = {}
    latest = None
    proc = subprocess.Popen(['zstd', '-dc', paths[0]], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        for raw in proc.stdout:
            line = raw.decode('utf8', 'replace')
            if '"model":"deepseek' not in line:
                continue
            match = model_re.search(line)
            if not match:
                continue
            counts[match.group(1)] = counts.get(match.group(1), 0) + 1
            stamp = time_re.search(line)
            latest = {'model': match.group(1), 'time': int(stamp.group(1)) if stamp else None}
    finally:
        try:
            proc.stdout.close()
        finally:
            proc.wait(timeout=60)
    age_min = None
    if latest and latest.get('time'):
        age_min = (datetime.datetime.now().timestamp() * 1000 - latest['time']) / 60000.0
    return {'latest': latest, 'ageMinutes': round(age_min, 1) if age_min is not None else None,
            'counts': counts}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()

    in_use = configured_model() or model_in_use()
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
            # 关键区分(cl-160): "不在广告目录" != "不可用"。供应商 /v1/models 只是**广告清单**,
            # 未登广告但实际能服务的 id 依然能跑(实测: deepseek-v4-flash 未登广告, 响应侧正常返回该名)。
            # 因此先取响应侧证据, 再决定 verdict —— 只有"既未登广告、又拿不到在用证据"才算缺失。
            try:
                evidence = response_evidence()
            except Exception as _err:
                evidence = {'error': '%s: %s' % (type(_err).__name__, str(_err)[:120])}
            result['responseLatest'] = (evidence.get('latest') or {}).get('model')
            result['responseAgeMinutes'] = evidence.get('ageMinutes')
            default_missing = (default_model not in ids) if default_model else False
            serving = (result['responseLatest'] == in_use
                       and evidence.get('ageMinutes') is not None
                       and evidence['ageMinutes'] <= 30)
            result['servingEvidence'] = bool(serving)
            if in_use not in ids and serving:
                result['verdict'] = 'in-use-unadvertised-and-serving'
                result['reason'] = ('在用模型未登广告目录, 但响应侧在 %.0f 分钟前仍在返回该模型 '
                                    '⇒ 判定为"未登广告但可用", 不按缺失处理' % evidence['ageMinutes'])
            elif in_use not in ids and default_missing:
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
        if 'missing' in str(result['verdict']):
            print('差异: 在用模型已不在供应商目录中(巡检因真相源是硬编码清单而报 model-ok)——见 cl-105',
                  file=sys.stderr)
    return 1 if str(result['verdict']).endswith('missing') else 0


if __name__ == '__main__':
    raise SystemExit(main())
