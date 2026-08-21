"""FIX-6 / FIX-11: SecurityRuntime 超时、EPIPE 损坏标记与心跳重启的黑盒验证。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("EMERALD_AUDIT_ROOT", str(ROOT / "var" / "egress_audit"))


def run_node(script: str) -> dict:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        env={**os.environ, "PYTHON": sys.executable, "PLUGIN_PYTHON": sys.executable},
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_request_timeout_fails_closed():
    """R-9: requestTimeoutMs=1 时请求超时被拒绝（fail-closed）。"""
    output = run_node(
        "import { SecurityRuntime } from './src/index.js';\n"
        "const rt = new SecurityRuntime({ requestTimeoutMs: 1 });\n"
        "try {\n"
        "  await rt.request({ operation: 'ping' });\n"
        "  process.stdout.write(JSON.stringify({ timedOut: false }));\n"
        "} catch (error) {\n"
        "  process.stdout.write(JSON.stringify({ timedOut: true, message: error.message }));\n"
        "} finally {\n"
        "  rt.dispose();\n"
        "}\n"
    )
    assert output["timedOut"] is True, "超时未生效"
    assert "timeout" in output["message"]


def test_stdin_epipe_fails_all_pending_and_kills_worker():
    """R-9: stdin 损坏 → worker 被 kill、全部 pending 被拒绝。"""
    output = run_node(
        "import { SecurityRuntime } from './src/index.js';\n"
        "const rt = new SecurityRuntime({});\n"
        "// 等 worker 就绪后破坏 stdin。\n"
        "await rt.request({ operation: 'ping' });\n"
        "// cork() 阻止写入刷入 OS buffer；destroy() 时所有挂起 write 回调触发 ERR_STREAM_DESTROYED，\n"
        "// 从而确定性地调用 #failAll，拒绝全部 pending 请求（R-9）。\n"
        "rt.child.stdin.cork();\n"
        "const pending = [rt.request({ operation: 'ping' }), rt.request({ operation: 'ping' })];\n"
        "rt.child.stdin.destroy();\n"
        "const results = await Promise.allSettled(pending);\n"
        "const rejected = results.filter((r) => r.status === 'rejected').length;\n"
        "await new Promise((resolve) => setTimeout(resolve, 300));\n"
        "process.stdout.write(JSON.stringify({\n"
        "  rejected,\n"
        "  broken: rt.broken === true,\n"
        "  childDead: rt.child.exitCode !== null || rt.child.killed,\n"
        "}));\n"
        "rt.dispose();\n"
    )
    assert output["rejected"] == 2, f"pending 未全部拒绝: {output}"
    assert output["broken"] is True
    assert output["childDead"] is True


def test_heartbeat_restarts_dead_worker():
    """FIX-11: worker 被外部 kill 后心跳达到失败阈值自动重启并恢复服务。"""
    output = run_node(
        "import { SecurityRuntime } from './src/index.js';\n"
        "const rt = new SecurityRuntime({\n"
        "  heartbeatIntervalMs: 150,\n"
        "  heartbeatTimeoutMs: 1000,\n"
        "  heartbeatMaxFailures: 2,\n"
        "});\n"
        "rt.startHeartbeat();\n"
        "await rt.request({ operation: 'ping' });\n"
        "const firstChild = rt.child;\n"
        "firstChild.kill('SIGKILL');\n"
        "// 等待心跳发现故障并完成重启。\n"
        "await new Promise((resolve) => setTimeout(resolve, 2500));\n"
        "let restored = false;\n"
        "try {\n"
        "  const probe = await rt.request({ operation: 'ping' }, { timeoutMs: 15000 });\n"
        "  restored = probe.ok === true;\n"
        "} catch {\n"
        "  restored = false;\n"
        "}\n"
        "process.stdout.write(JSON.stringify({\n"
        "  recovered: rt.broken === false,\n"
        "  newChild: rt.child !== firstChild,\n"
        "  restored,\n"
        "}));\n"
        "rt.dispose();\n"
    )
    assert output["newChild"] is True, "worker 未自动重启"
    assert output["restored"] is True, "重启后服务未恢复"


def main() -> int:
    tests = [value for key, value in sorted(globals().items()) if key.startswith("test_")]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as error:
            failures += 1
            print(f"FAIL {test.__name__}: {error}")
    print(f"RESULT {len(tests) - failures}/{len(tests)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
