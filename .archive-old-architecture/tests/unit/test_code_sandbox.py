"""代码车道沙箱的安全合同测试。

覆盖三类不变量：
1. 白名单 AST：导入/反射链/IO 调用/动态执行/作用域逃逸全部拒绝（fail closed）
2. 受限运行时：数据集只经注入注册表；异常收敛为脱敏信封；超时可杀
3. 元数据信封：只含行数/列名/dtype/空值计数，绝不含单元格值
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from security.code_sandbox import SandboxViolation, check_code, run_sandbox, safe_builtins


def _reject(source: str) -> None:
    try:
        check_code(source)
    except SandboxViolation:
        return
    raise AssertionError(f"code must be rejected:\n{source}")


def _fixture_csv(root: Path) -> dict[str, str]:
    path = root / "dm.csv"
    path.write_text(
        "USUBJID,AGE,SEX\n101-001-0001,44,M\n101-001-0002,51,F\n", encoding="utf-8")
    return {"dm": str(path)}


class CheckCodeContract(unittest.TestCase):
    def test_ast_policy_is_independent_from_egress_environment(self):
        previous = os.environ.get("DATA_PROTECTION_ENABLED")
        try:
            for value in ("0", "1"):
                os.environ["DATA_PROTECTION_ENABLED"] = value
                _reject("import os")
                _reject("frame = pd.read_csv('x.csv')")
        finally:
            if previous is None:
                os.environ.pop("DATA_PROTECTION_ENABLED", None)
            else:
                os.environ["DATA_PROTECTION_ENABLED"] = previous

    def test_imports_are_rejected(self):
        _reject("import os")
        _reject("from pathlib import Path")
        _reject("import pandas as pd")

    def test_reflection_chains_are_rejected(self):
        _reject("x = pd.__version__")
        _reject("x = ().__class__")
        _reject("y = result.__globals__")
        _reject("z = __builtins__")

    def test_io_and_dynamic_calls_are_rejected(self):
        _reject("frame = pd.read_csv('x.csv')")
        _reject("datasets['dm'].to_pickle('x')")
        _reject("value = eval('1+1')")
        _reject("result = datasets['dm'].query('AGE > 40')")
        _reject("np.fromfile('x.bin')")
        _reject("data = open('x')")

    def test_scope_escape_and_async_are_rejected(self):
        _reject("global x")
        _reject("def f():\n    nonlocal x")
        _reject("async def f():\n    pass")
        _reject("async def f():\n    await g()")

    def test_malformed_code_is_rejected(self):
        _reject("")
        _reject("   ")
        with self.assertRaises(SandboxViolation) as caught:
            check_code("def broken(:\n    pass")
        message = str(caught.exception)
        self.assertIn("invalid syntax", message)
        self.assertIn("line 1", message)
        self.assertIn("column 12", message)

    def test_large_valid_code_is_not_rejected_by_size(self):
        check_code("x = 1\n" * 100000)

    def test_legitimate_code_passes(self):
        check_code("result = datasets['dm']")
        check_code(
            "frames = [datasets[name] for name in ['dm']]\n"
            "result = pd.concat(frames)\n")
        check_code("total = sum(row for row in range(10))")
        check_code("for _ in range(3):\n    pass")
        check_code(
            "def derive(frame):\n"
            "    return frame.assign(FLAG=lambda s: s['AGE'] > 40)\n"
            "result = derive(datasets['dm'])\n")

    def test_safe_builtins_have_no_io(self):
        builtins = safe_builtins()
        for name in ("open", "eval", "exec", "compile", "__import__", "input",
                     "print", "getattr", "setattr", "globals", "locals", "vars",
                     "breakpoint", "delattr"):
            self.assertNotIn(name, builtins)


class SandboxExecutionContract(unittest.TestCase):
    """run_sandbox 走真实子进程,验证信封与隔离。"""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="sandbox-test-")
        cls.files = _fixture_csv(Path(cls._tmp.name))
        cls.allowed_dirs = [cls._tmp.name]

    def test_empty_allowed_data_dirs_rejects(self):
        """P0-FIX: 空目录列表必须在 set_allowed_dirs 层被拦截。"""
        envelope = run_sandbox(
            code="result = datasets['dm']", files=self.files, timeout_seconds=60,
            allowed_data_dirs=[])
        self.assertEqual(envelope.get("status"), "rejected")
        message = envelope["error"]["message"]
        self.assertIn("empty", message.lower())

    def test_whitespace_only_dirs_rejects(self):
        """P0-FIX: 纯空白或空串项必须被清洗并拦截。"""
        envelope = run_sandbox(
            code="result = datasets['dm']", files=self.files, timeout_seconds=60,
            allowed_data_dirs=["", "  ", "\t"])
        self.assertEqual(envelope.get("status"), "rejected")
        message = envelope["error"]["message"]
        self.assertIn("empty", message.lower())

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_envelope_is_metadata_only(self):
        envelope = run_sandbox(
            code="result = datasets['dm']", files=self.files, timeout_seconds=120,
            allowed_data_dirs=self.allowed_dirs)
        self.assertEqual(envelope.get("status"), "ok")
        outputs = envelope.get("outputs", [])
        self.assertEqual(len(outputs), 1)
        output = outputs[0]
        self.assertEqual(output["rowCount"], 2)
        names = [column["name"] for column in output["columns"]]
        self.assertIn("USUBJID", names)
        self.assertIn("AGE", names)
        serialized = json.dumps(envelope, ensure_ascii=False)
        # 红线：受试者标记绝不出现在回程信封里。
        self.assertNotIn("101-001-0001", serialized)
        self.assertNotIn("101-001-0002", serialized)

    def test_outputs_dict_multiple_frames(self):
        envelope = run_sandbox(
            code=(
                "dm = datasets['dm']\n"
                "outputs = {\n"
                "    'demography': dm,\n"
                "    'adults': dm[dm['AGE'] > 45],\n"
                "}\n"),
            files=self.files, timeout_seconds=120, allowed_data_dirs=self.allowed_dirs)
        self.assertEqual(envelope.get("status"), "ok")
        counts = {item["name"]: item["rowCount"] for item in envelope["outputs"]}
        self.assertEqual(counts["demography"], 2)
        self.assertEqual(counts["adults"], 1)

    def test_missing_dataset_error_lists_available(self):
        envelope = run_sandbox(
            code="result = datasets['lb']", files=self.files, timeout_seconds=120,
            allowed_data_dirs=self.allowed_dirs)
        self.assertEqual(envelope.get("status"), "error")
        message = envelope["error"]["message"]
        self.assertIn("not available", message)
        self.assertIn("dm", message)

    def test_unknown_dataset_format_is_actionable(self):
        path = Path(self._tmp.name) / "opaque.bin"
        path.write_bytes(b"not-a-tabular-dataset")
        envelope = run_sandbox(
            code="result = datasets['opaque']", files={"opaque": str(path)},
            timeout_seconds=120, allowed_data_dirs=self.allowed_dirs)
        self.assertEqual(envelope.get("status"), "error")
        self.assertIn("unsupported dataset format: .bin", envelope["error"]["message"])

    def test_non_dataframe_result_is_rejected(self):
        envelope = run_sandbox(
            code="result = 42", files=self.files, timeout_seconds=120,
            allowed_data_dirs=self.allowed_dirs)
        self.assertEqual(envelope.get("status"), "error")

    def test_missing_result_is_rejected(self):
        envelope = run_sandbox(
            code="frame = datasets['dm']", files=self.files, timeout_seconds=120,
            allowed_data_dirs=self.allowed_dirs)
        self.assertEqual(envelope.get("status"), "error")

    def test_infinite_loop_is_killed(self):
        started = time.monotonic()
        envelope = run_sandbox(
            code="while True:\n    pass", files=self.files, timeout_seconds=3,
            allowed_data_dirs=self.allowed_dirs)
        elapsed = time.monotonic() - started
        self.assertEqual(envelope.get("status"), "error")
        self.assertEqual(envelope["error"]["type"], "SandboxTimeout")
        self.assertLess(elapsed, 60)

    def test_runner_rechecks_ast_defense_in_depth(self):
        # 父层 run_sandbox 会先拒绝；直接调 runner 验证子进程侧的第二道闸。
        from security.sandbox_runner import execute_job

        result = execute_job({"mode": "run", "code": "import os\nresult = datasets['dm']",
                              "datasets": self.files,
                              "allowedDataDirs": self.allowed_dirs})
        self.assertEqual(result.get("status"), "rejected")


if __name__ == "__main__":
    unittest.main()
