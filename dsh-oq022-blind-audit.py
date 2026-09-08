#!/usr/bin/env python3
"""oq-022 试点: 诱导表 effectiveness 盲审验证脚本(独立于 quiet-driver, 不碰源码)
2026-09-08 11:5x。目标: 验证"异模型判定真新 vs 自评"是否有效——oq-022 设计(L4异模型审计)的最小实证。

背景: exploration-inducements.jsonl 全部 14 条 effectiveness=0.5 纹丝不动(q01 hit=22),
代码层确认 pickInducement 只更新 lastUsed/hitCount, effectiveness 无回写——自评反馈环未接线(独立评审缺陷1)。
本脚本: 抽诱导表条目 + 其历史命中产出(帧日志), 给异模型(SiliconFlow)盲审"相对已知, 这是重述还是真新"。
用途: ①验证异模型判定可行 ②为 effectiveness 提供外部判定源(替代自评)。

用法: python3 dsh-oq022-blind-audit.py [--sample N]
"""
import json, os, re, sys, urllib.request, glob

CREDS = os.path.expanduser("~/.dsh/.credentials.yaml")
LEDGER = os.path.expanduser("~/.dsh/cognitive-pipeline/exploration-inducements.jsonl")
FRAMES = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-frames.jsonl")
SAMPLE = int(sys.argv[sys.argv.index("--sample") + 1]) if "--sample" in sys.argv else 3

def get_key():
    m = re.search(r'SILICONFLOW_API_KEY:\s*["\']?([A-Za-z0-9_\-]+)', open(CREDS).read())
    return m.group(1) if m else None

def audit(text, known):
    """调异模型盲审: 相对 known 上下文, text 是重述还是真新。"""
    req = urllib.request.Request(
        "https://api.siliconflow.cn/v1/chat/completions",
        data=json.dumps({
            "model": "deepseek-ai/DeepSeek-V3",
            "messages": [
                {"role": "system", "content": "你是审计员。判断待审文本相对'已知背景'是重述(已有内容换说法)还是真新(新信息/新判断/新连接)。只输出: 真新 或 重述 或 无法判定, 附一句理由。"},
                {"role": "user", "content": f"已知背景: {known[:500]}\n\n待审文本: {text[:500]}"}
            ],
            "max_tokens": 80
        }).encode(),
        headers={"Authorization": f"Bearer {get_key()}", "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=40) as r:
        d = json.loads(r.read())
        return d["choices"][0]["message"]["content"].strip()

def main():
    if get_key() is None:
        print("✗ 无 SILICONFLOW key"); return
    # 读诱导表
    induces = [json.loads(l) for l in open(LEDGER)]
    # 读帧日志找每条诱导的命中产出(粗匹配 question 片段)
    frame_texts = []
    if os.path.exists(FRAMES):
        for line in open(FRAMES):
            try:
                d = json.loads(line)
                out = d.get("output") or ""
                if len(out) > 100:
                    frame_texts.append(out)
            except: pass
    print(f"诱导表 {len(induces)} 条 | 帧产出池 {len(frame_texts)} 段 | 抽样 {min(SAMPLE, len(induces))} 条盲审\n")
    results = []
    for ind in induces[:SAMPLE]:
        q = ind.get("question", "")[:80]
        # 找一条可能与 q 相关的帧产出(含 q 关键词的)
        related = next((t for t in frame_texts if any(k in t for k in q[:10].split())), frame_texts[0] if frame_texts else "无")
        verdict = audit(q, related if related != "无" else "该诱导问题的历史产出不可得")
        results.append({"id": ind.get("id"), "question": q, "verdict": verdict})
        print(f"[{ind.get('id')}] {q[:50]}...\n    → {verdict[:80]}")
    # 汇总
    print("\n=== 盲审汇总 ===")
    for r in results:
        print(f"  {r['id']}: {r['verdict'][:60]}")

if __name__ == "__main__":
    main()
