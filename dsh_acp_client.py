#!/usr/bin/env python3
"""
dsh_acp_client.py — Hermes 调度 DeepSeek Harness 的持续对话客户端

通过 ACP（Agent Client Protocol）stdio JSON-RPC 与 dsh 通信，支持多轮会话。

用法:
  python3 dsh_acp_client.py "任务"                 # 新会话，执行一次任务
  python3 dsh_acp_client.py --continue "追问"       # 续接上次会话（同一 sessionId）
  python3 dsh_acp_client.py --session <id> "追问"   # 续接指定会话
  python3 dsh_acp_client.py --new                   # 重置会话

输出: assistant 的最终文本回复（纯文本，可直接读取）
会话状态: /home/ubuntu/dsh-fork/.acp_session 保存当前 sessionId
"""

import subprocess
import json
import sys
import os
import threading
import queue
import time
import argparse
from pathlib import Path

DSH_FORK = "/home/ubuntu/dsh-fork"
SESSION_FILE = Path(DSH_FORK) / ".acp_session"

# ACP server 启动命令（tsx 跑源码，已验证可用）
ACP_CMD = [
    "node", "--import", "tsx",
    "packages/examples/acp-demo/src/bin.ts",
    "--config", "acp-cognitive.yml",
]


class ACPClient:
    """stdio JSON-RPC 客户端，管理一个 dsh ACP 会话。"""

    def __init__(self, dsh_home: str, api_key: str):
        env = os.environ.copy()
        env["DSH_HOME"] = dsh_home
        env["DEEPSEEK_API_KEY"] = api_key
        env["PATH"] = "/home/ubuntu/.npm-global/bin:" + env.get("PATH", "")

        self.proc = subprocess.Popen(
            ACP_CMD,
            cwd=DSH_FORK,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            text=True,
            bufsize=1,
        )
        self._next_id = 0
        self._pending = {}       # id → (event, response)
        self._chunks = {}        # sessionId → [text chunks]
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # ── 底层 JSON-RPC ──────────────────────────────

    def _call(self, method: str, params: dict, timeout: float = 300) -> dict:
        self._next_id += 1
        mid = self._next_id
        event = threading.Event()
        with self._lock:
            self._pending[mid] = (event, None)
        msg = json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
        self.proc.stdin.write(msg + "\n")
        self.proc.stdin.flush()
        if not event.wait(timeout):
            raise TimeoutError(f"ACP 调用超时: {method}")
        with self._lock:
            event_, resp = self._pending.pop(mid, (None, None))
        if "error" in resp:
            raise RuntimeError(f"ACP 错误 {method}: {resp['error'].get('message')}")
        return resp.get("result", {})

    def _read_loop(self):
        """后台读 stdout，分发响应和通知。"""
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in msg and msg["id"] is not None:
                # 响应
                with self._lock:
                    if msg["id"] in self._pending:
                        event, _ = self._pending[msg["id"]]
                        self._pending[msg["id"]] = (event, msg)
                        event.set()
            elif msg.get("method") == "session/update":
                # 通知：收集 assistant 文本块
                sid = msg.get("params", {}).get("sessionId", "")
                update = msg.get("params", {}).get("update", {})
                if update.get("sessionUpdate") == "agent_message_chunk":
                    content = update.get("content", {})
                    if content.get("type") == "text":
                        with self._lock:
                            self._chunks.setdefault(sid, []).append(content["text"])

    # ── 高层操作 ───────────────────────────────────

    def initialize(self) -> dict:
        return self._call("initialize", {"protocolVersion": 1, "clientCapabilities": {}})

    def new_session(self, cwd: str) -> str:
        result = self._call("session/new", {"cwd": cwd, "mcpServers": []})
        return result["sessionId"]

    def prompt(self, session_id: str, text: str) -> str:
        """发送提示，返回 assistant 回复文本。"""
        self._chunks.pop(session_id, None)  # 清空本轮的 chunk 缓冲
        self._call(
            "session/prompt",
            {"sessionId": session_id, "prompt": [{"type": "text", "text": text}]},
        )
        chunks = self._chunks.get(session_id, [])
        return "".join(chunks).strip()

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def load_api_key() -> str:
    """从 Hermes 环境读取 DeepSeek key。"""
    if os.environ.get("DEEPSEEK_API_KEY"):
        return os.environ["DEEPSEEK_API_KEY"]
    env_file = Path.home() / ".hermes" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("DEEPSEEK_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("未找到 DEEPSEEK_API_KEY")


def main():
    parser = argparse.ArgumentParser(description="dsh ACP 持续对话客户端")
    parser.add_argument("task", nargs="*", help="任务文本（多词自动拼接）")
    parser.add_argument("--continue", dest="cont", action="store_true", help="续接上次会话")
    parser.add_argument("--session", dest="session", help="续接指定 sessionId")
    parser.add_argument("--new", dest="new", action="store_true", help="重置会话")
    parser.add_argument("--cwd", default="/home/ubuntu/dsh-fork", help="工作目录")
    args = parser.parse_args()

    task = " ".join(args.task).strip()
    if not task and not args.new:
        parser.error("需要任务文本")

    api_key = load_api_key()
    client = ACPClient("/home/ubuntu/.dsh", api_key)

    try:
        client.initialize()

        # 决定 sessionId
        session_id = None
        if args.session:
            session_id = args.session
        elif args.new or not SESSION_FILE.exists():
            session_id = client.new_session(args.cwd)
            SESSION_FILE.write_text(session_id)
        else:
            session_id = SESSION_FILE.read_text().strip()
            if not session_id:
                session_id = client.new_session(args.cwd)
                SESSION_FILE.write_text(session_id)

        if args.new and not task:
            print(f"会话已重置: {session_id}")
            return

        reply = client.prompt(session_id, task)
        print(reply if reply else "(无回复)")
    finally:
        client.close()


if __name__ == "__main__":
    main()
