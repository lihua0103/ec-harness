#!/usr/bin/env python3
"""真实链路回放：以 index.js SecurityRuntime 相同方式拉起 worker 进程，
把真实会话的全部字符串走完 写入侧(scrub_text) → 出域侧(check_llm) 全流程。

用法: python tests/replay_e2e.py <session.jsonl.zstd>...
验收: 出境拦截数应为 0；数据值拦截由 check_egress 单测保证。

覆盖：worker.py 接线、模块导入、JSON 行协议、egress/data_egress/tokenizer/patterns
在真实运行进程中的行为。用法：python3 replay_e2e.py <session.jsonl.zstd>...
"""
import json
import os
import subprocess
import sys
import zstandard

import pathlib
PLUGIN = str(pathlib.Path(__file__).resolve().parent.parent)
PY = sys.executable


def strings_of(record):
    out = []

    def walk(o):
        if isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, str) and len(o) > 3:
            out.append(o)

    walk(record.get("data", {}))
    return out


def main(paths):
    env = {
        "PATH": os.environ.get("PATH", ""),
        "EMERALD_WORKER_ROOT": PLUGIN,
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONPATH": PLUGIN,
        "EMERALD_AUDIT_ROOT": os.environ.get("EMERALD_AUDIT_ROOT", "/tmp/audit_replay"),
    }
    os.makedirs(os.environ.get("EMERALD_AUDIT_ROOT", "/tmp/audit_replay"), exist_ok=True)
    worker = subprocess.Popen(
        [PY, "-m", "security.worker"], cwd=PLUGIN,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env=env, text=True, encoding="utf-8", bufsize=1,
    )
    seq = 0

    def request(payload, timeout_ok=True):
        nonlocal seq
        seq += 1
        rid = f"req-{seq}"
        worker.stdin.write(json.dumps({"requestId": rid, **payload}, ensure_ascii=False) + "\n")
        worker.stdin.flush()
        line = worker.stdout.readline()
        if not line:
            raise RuntimeError("worker died")
        resp = json.loads(line)
        assert resp.get("requestId") == rid
        return resp

    assert request({"operation": "ping"})["ok"], "worker ping 失败"

    total = write_scrubbed = write_kept = 0
    egress_blocked = []
    for path in paths:
        raw = zstandard.ZstdDecompressor().stream_reader(open(path, "rb")).read()
        for line in raw.decode("utf-8", "replace").splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            for text in strings_of(rec):
                total += 1
                # 写入侧：工具结果进会话前的 scrub_text
                r1 = request({"operation": "scrub_text", "text": text,
                              "context": {"mode": "enforce"}})
                assert r1["ok"], f"scrub_text 失败: {r1.get('reason')}"
                model_sees = r1["text"]
                if model_sees != text:
                    write_scrubbed += 1
                else:
                    write_kept += 1
                # 出域侧：模型可见文本（scrub 后）重组出境请求
                r2 = request({"operation": "check_llm",
                              "payload": {"messages": [{"role": "user", "content": model_sees}]},
                              "context": {"mode": "enforce", "sessionId": "replay"}})
                if not r2["ok"] and r2.get("code") == "EGRESS_VIOLATION":
                    egress_blocked.append((text, model_sees))
                # 出域侧：原文本直接出境（模拟历史重放/用户手贴）单独统计
    print(f"回放字符串总数: {total}")
    print(f"写入侧改写(token化): {write_scrubbed} | 原样保留: {write_kept}")
    print(f"出域侧(scrub后出境)拦截数: {len(egress_blocked)}")
    for text, seen in egress_blocked[:5]:
        print("  BLOCKED:", repr(text[:90]))
    worker.stdin.close()
    worker.wait(timeout=10)
    return 0 if not egress_blocked else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
