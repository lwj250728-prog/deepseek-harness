#!/usr/bin/env python3
"""隐式采纳检测（tp-089 / T105；goal-adoption-rate 第 4 步）。

问题：引用契约要求模型在正文里写出 expId 才算"采纳"，而**隐性采纳**（按经验的做法
去做、但没写 id）一律记成未采纳 => 采纳率被系统性低估，且"注入是否有用"的结论会被
这个口径带偏（今天已经因为量错对象连续栽了三次）。

做法（不依赖自报）：把注入经验的 action 文本切成判别性标记（CJK 二元组 + 拉丁词），
与**该回合的工具调用参数**求交；交集 >= 2 个标记即判为"行为上采纳了这条经验"。
输出两栏：显式采纳率（自报 expId）与 显式+隐式采纳率。

诚实标注：这是**代理判据**，会把"恰好提到相同词"也算进来（假阳性）。所以它只作为
下界指示，不替换显式口径；两者并列报出，差异本身就是信息。

用法：dsh-implicit-adoption.py [--hours 24] [--quiet]
退出码：0 = 出数；1 = 缺数据。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
SESSIONS = os.path.expanduser('~/.dsh/sessions')
MAIN = 'session-63251d85-ef77-4299-939d-9a6fe9b5bec6'
OUT = os.path.join(DIR, 'implicit-adoption.json')
MIN_OVERLAP = 2
# 判别性差的通用词不参与交集(否则"调用/文件/检查"这类词会造成大量假阳性)
STOP = {'调用', '文件', '检查', '记录', '结果', '内容', '输出', '经验', '目标', '需要',
        '可以', '进行', '确认', '写入', '读取', '执行', '数据', '状态'}


def session_log(session_id: str) -> str | None:
    for workspace in os.listdir(SESSIONS):
        candidate = os.path.join(SESSIONS, workspace, session_id, 'session.jsonl.zstd')
        if os.path.exists(candidate):
            return candidate
    return None


def turn_tool_args(log_path: str) -> tuple[dict[int, str], list[tuple[int, int]]]:
    """(turn -> tool-call arguments, [(turn_start_ms, turn_no)] sorted).

    隐式采纳必须在**注入之后的那几个回合**里找行为证据。首版拿整个会话的工具参数求交,
    结果 95.9%(必然重叠——1160 个回合的工具调用覆盖了整条管线词汇), 是典型的量错对象。
    """
    by_turn: dict[int, list[str]] = {}
    starts: dict[int, int] = {}
    for line in stream_lines(log_path):
        if '"tool/call"' not in line and '"turn/start"' not in line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        data = event.get('data') or {}
        turn = data.get('turn')
        if event.get('type') == 'tool/call':
            args = data.get('arguments')
            if isinstance(turn, int) and isinstance(args, str):
                by_turn.setdefault(turn, []).append(args)
        elif event.get('type') == 'turn/start':
            stamp = event.get('time')
            if isinstance(turn, int) and isinstance(stamp, int):
                starts.setdefault(turn, stamp)
    ordered = sorted((stamp, turn) for turn, stamp in starts.items())
    return {turn: ' '.join(parts) for turn, parts in by_turn.items()}, ordered


def markers(text: str) -> set[str]:
    """Discriminative markers: CJK bigrams + latin words >= 4 chars."""
    tokens = set()
    cjk = re.sub(r'[^\u4e00-\u9fff]', ' ', text)
    for run in cjk.split():
        for index in range(len(run) - 1):
            bigram = run[index:index + 2]
            if bigram not in STOP:
                tokens.add(bigram)
    for word in re.findall(r'[A-Za-z_][A-Za-z0-9_-]{3,}', text):
        tokens.add(word.lower())
    return tokens




def stream_lines(path: str):
    """逐行产出解压后的日志行 —— 不把整份解压结果读进内存。

    2026-09-10 21:03 事故: 会话日志 58MB → 解压 163MB, 原实现用
    subprocess.run(capture_output=True) 一次读进内存, 单脚本峰值 **~1.04 GB**;
    叠加 node 服务自身 1.4-1.7 GB(机器 3.6 GB), dsh-web 被内核 oom-kill。
    观测工具不得把被观测对象打死 ⇒ 一律流式(cl-155)。
    """
    proc = subprocess.Popen(['zstd', '-dc', path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        for raw_line in proc.stdout:
            yield raw_line.decode('utf8', 'replace')
    finally:
        try:
            proc.stdout.close()
        finally:
            proc.wait(timeout=60)

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--hours', type=float, default=24.0)
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()

    log_path = session_log(MAIN)
    if log_path is None:
        print('缺会话日志: 无法取工具调用', file=sys.stderr)
        return 1
    args_by_turn, turn_starts = turn_tool_args(log_path)
    # 判别性过滤(cl-098 同族): 在整个会话的工具参数里高频出现的标记没有判别力——
    # 本会话是自指工程回路, "测试套件/落盘账本/重启服务"这类词几乎每轮都出现,
    # 不做 DF 过滤会导致 76%~96% 的荒谬"隐式采纳率"(首版实测)。
    turn_marker_sets = [markers(text) for text in args_by_turn.values()]
    df: dict[str, int] = {}
    for token_set in turn_marker_sets:
        for token in token_set:
            df[token] = df.get(token, 0) + 1
    total_turns = max(1, len(turn_marker_sets))
    common = {token for token, count in df.items() if count / total_turns > 0.2}

    import bisect
    start_ms = [s for s, _ in turn_starts]
    turn_nos = [t for _, t in turn_starts]

    def window_args(at_ms: int, span: int = 3) -> str:
        """注入之后 span 个回合的工具参数(而非整会话)。"""
        index = bisect.bisect_right(start_ms, at_ms) - 1
        if index < 0:
            return ''
        parts = []
        for turn in turn_nos[index:index + span]:
            text = args_by_turn.get(turn)
            if text:
                parts.append(text)
        return ' '.join(parts)

    experiences: dict[str, dict] = {}
    for line in open(os.path.join(DIR, 'experiences.jsonl'), encoding='utf8'):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        experiences[record.get('expId')] = record

    injections: dict[str, dict] = {}
    for line in open(os.path.join(DIR, 'injections.jsonl'), encoding='utf8'):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if isinstance(record.get('injectionId'), str):
            injections[record['injectionId']] = record

    # 回合边界: 用审计里的 sessionTurns 无法定位回合号, 故用"注入时刻之后最近的 tool/call 回合"
    # —— 简化取舍: 取该经验注入后 30 分钟内的所有工具参数作为"后续行为窗口"。
    cutoff = (datetime.datetime.now().timestamp() - args.hours * 3600) * 1000
    settled = [r for r in injections.values()
               if str(r.get('sessionId')) == MAIN and r.get('cited') in (True, False)
               and (r.get('createdAt') or 0) > cutoff]
    explicit = [r for r in settled if r.get('cited') is True]
    implicit = []
    for record in settled:
        if record.get('cited') is True:
            continue
        for exp_id in record.get('expIds') or []:
            exp = experiences.get(exp_id)
            if exp is None:
                continue
            want = markers(record_markers(exp, exp_id, experiences)) - common
            hit = want & (markers(window_args(record.get('createdAt') or 0)) - common)
            if len(hit) >= MIN_OVERLAP:
                implicit.append({'injectionId': record['injectionId'], 'expId': exp_id,
                                 'overlap': sorted(hit)[:8]})
                break

    payload = {
        'generatedAt': datetime.datetime.now().isoformat(),
        'windowHours': args.hours,
        'settled': len(settled),
        'explicitCited': len(explicit),
        'explicitRate': round(len(explicit) / len(settled), 4) if settled else None,
        'implicitAdopted': len(implicit),
        'explicitPlusImplicitRate': round((len(explicit) + len(implicit)) / len(settled), 4) if settled else None,
        'minOverlap': MIN_OVERLAP,
        'implicitSamples': implicit[:10],
        'commonMarkersFiltered': len(common),
        'dfThreshold': 0.2,
        'caveat': ('代理判据: 注入后 3 个回合的工具参数与经验动作的判别性标记(df<=20%)交集 >=2 即算隐式采纳。'
                   '实测 74.8%~95.9% —— 本会话是自指工程回路, 经验动作词与其它回合的工具调用天然重叠, '
                   '**假阳性极高**, 加 df 过滤也压不下来 => 该代理无信息量, 只采显式口径(采纳率是下界, '
                   '真实上界未知且当前不可测)。'),
    }
    # 饱和判定: 若"隐式"比例高到不像话(>25%), 这个代理判据就没有信息量——本会话实测
    # 76%~96%(自指工程回路里几乎所有经验的动作词都与其他回合的工具调用重叠)。
    # 明确标记 saturated, 禁止把它当采纳率用。
    proxy_rate = ((len(explicit) + len(implicit)) / len(settled)) if settled else 0.0
    payload['proxySaturated'] = proxy_rate > 0.25
    payload['verdict'] = ('proxy-saturated-unusable' if payload['proxySaturated'] else 'usable-with-caveat')
    payload['useExplicitRateOnly'] = True

    with open(OUT, 'w', encoding='utf8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    if not args.quiet:
        print('窗口 %.0fh: 已结算 %d 条' % (args.hours, len(settled)))
        if payload['proxySaturated']:
            print('  判定: **代理饱和, 不可用**(显式+隐式 %.1f%% 明显是假阳性) => 只采用显式口径'
                  % (proxy_rate * 100))
        print('  显式采纳 %d (%.1f%%) | 隐式(代理) %d => 显式+隐式 %.1f%%'
              % (len(explicit), (payload['explicitRate'] or 0) * 100, len(implicit),
                 (payload['explicitPlusImplicitRate'] or 0) * 100))
    return 0


def record_markers(exp: dict, exp_id: str, experiences: dict[str, dict]) -> str:
    """The text whose markers stand for "acting on this experience"."""
    sar = exp.get('sar') or {}
    return ' '.join([str(sar.get('action') or ''), ' '.join(exp.get('actionKeywords') or [])])


if __name__ == '__main__':
    raise SystemExit(main())
