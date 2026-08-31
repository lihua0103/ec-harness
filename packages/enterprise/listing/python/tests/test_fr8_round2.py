"""FR-8 二次对抗探测（R2 轮，测试经理，2026-08-29，BUG-1/BUG-2 修复后）。

首轮（test_fr8_matrix.py A-1~A-15/E-*）已覆盖基础矩阵；本轮针对修复后
实现做更深攻击：fd 直写家族（os.write/buffer/spawn）、logging 通道、
跨回执文件中转、outputs 表名遮蔽冲突的确定性、5 万值集 + 1MB 吞吐、
以及四项既有口径的回归锁定。全部合成数据，先写断言再实测，只测不修。

口径备忘（继承首轮，非 bug）：精确匹配=大小写敏感、len<4 短值豁免、
doc/ 载荷豁免直通、开关关闭零拦截、主进程 TextIOWrapper 块缓冲在 fd
劫持期间 flush 属宿主侧既有登记残余（worker 协议写显式 flush 在 fd
恢复后，不受影响）。
"""
import json
import logging
import re
import time

import pytest

import worker


#: 靶场数据集全部行值（合成）——任何回执出域必须零出现。
SECRET_VALUES = ("SUBJ-777", "SUBJ-888", "Headache", "Nausea", "12345")


@pytest.fixture()
def r2_project(tmp_path):
    """标准靶场：AE.csv(含数值列) + doc 文本。"""
    (tmp_path / "doc").mkdir()
    (tmp_path / "doc" / "spec.txt").write_text("需求文档 REQUIREMENT-TAIL", encoding="utf-8")
    (tmp_path / "AE.csv").write_text(
        "USUBJID,AETERM,DOSE\nSUBJ-777,Headache,12345\nSUBJ-888,Nausea,12345\n",
        encoding="utf-8")
    return tmp_path


@pytest.fixture(autouse=True)
def clean_logging_root():
    """清 root logger：防 run_code 内 basicConfig 的 handler 持旧捕获流跨测试残留。"""
    logging.getLogger().handlers.clear()
    yield
    logging.getLogger().handlers.clear()


def _payload(result) -> str:
    return json.dumps(result, ensure_ascii=False)


def _assert_zero_leak(result) -> None:
    payload = _payload(result)
    for value in SECRET_VALUES:
        assert value not in payload, f"数据集行值出域: {value}"


# ---------------------------------------------------------------------------
# R2-1 os.write(1/2) 直写文件描述符：fd 重定向捕获 + 回执遮蔽
# ---------------------------------------------------------------------------

def test_r2_1_os_write_fd1_fd2_captured_and_masked(r2_project, capfd):
    """断言：os.write(1, 值) 与 os.write(2, 值) 均落入 fd 捕获流并经回执
    遮蔽为 [DATA]；fd 级真实输出（capfd）零外泄。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import os\n'
                'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'os.write(1, v.encode())\n'
                'os.write(2, v.encode())\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "[DATA]"
    assert result["receipt"]["stderr"] == "[DATA]"
    _assert_zero_leak(result)
    fd_out = capfd.readouterr()
    assert "Headache" not in fd_out.out and "Headache" not in fd_out.err


def test_r2_1b_os_write_embedded_form_masked(r2_project):
    """断言：os.write 嵌入形态（ID=SUBJ-777;）同样被长值嵌入兜底遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import os\n'
                'v = datasets["AE"].iloc[0]["USUBJID"]\n'
                'os.write(1, f"ID={v};".encode())\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "ID=[DATA];"
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# R2-2 sys.stdout.buffer / sys.__stdout__ / print(file=sys.stderr)
# ---------------------------------------------------------------------------

def test_r2_2a_stdout_buffer_attack_surface_absent(r2_project):
    """断言：redirect_stdout 后捕获流无 buffer 属性——
    sys.stdout.buffer.write 直接 AttributeError，值不出现在异常回执中。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import sys\n'
                'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'sys.stdout.buffer.write(v.encode())\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is False
    assert result["code"] == "CODE_EXECUTION_ERROR"
    assert "buffer" in result["reason"]
    _assert_zero_leak(result)


def test_r2_2b_dunder_stdout_buffer_fd_redirected_masked(r2_project, capfd):
    """断言：sys.__stdout__.buffer.write（真实对象、有 buffer）在 fd 劫持
    期间写 fd1 → 落入捕获流并遮蔽；fd 级零外泄。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import sys\n'
                'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'sys.__stdout__.buffer.write(v.encode() + b"\\n")\n'
                'sys.__stdout__.buffer.flush()\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "[DATA]\n"
    _assert_zero_leak(result)
    leaked = capfd.readouterr()
    assert "Headache" not in leaked.out and "Headache" not in leaked.err


def test_r2_2c_print_file_stderr_masked(r2_project):
    """断言：print(值, file=sys.stderr) → 回执 stderr 遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import sys\n'
                'print(datasets["AE"].iloc[0]["AETERM"], file=sys.stderr)\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stderr"] == "[DATA]\n"
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# R2-3 multiprocessing spawn 子进程 print 值 → 继承 fd1 捕获遮蔽
# ---------------------------------------------------------------------------

def test_r2_3_spawn_child_print_masked(r2_project, capfd):
    """断言：spawn 上下文子进程（builtin print 可 pickle）继承劫持后的
    fd1，print(值) 落入 fd 捕获并入回执 stdout 遮蔽；fd 级零外泄。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import multiprocessing\n'
                'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'proc = multiprocessing.get_context("spawn").Process(\n'
                '    target=print, args=(v,))\n'
                'proc.start()\n'
                'proc.join()\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert "[DATA]" in result["receipt"]["stdout"]
    _assert_zero_leak(result)
    leaked = capfd.readouterr()
    assert "Headache" not in leaked.out and "Headache" not in leaked.err


def test_r2_3b_fork_context_child_print_masked(r2_project, capfd):
    """断言：默认上下文子进程（同 spawn 语义在 Windows）print 值同样
    捕获遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import multiprocessing\n'
                'v = datasets["AE"].iloc[0]["USUBJID"]\n'
                'proc = multiprocessing.Process(target=print, args=(v,))\n'
                'proc.start()\n'
                'proc.join()\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert "[DATA]" in result["receipt"]["stdout"]
    _assert_zero_leak(result)
    leaked = capfd.readouterr()
    assert "SUBJ-777" not in leaked.out and "SUBJ-777" not in leaked.err


# ---------------------------------------------------------------------------
# R2-4 logging 通道（stream=sys.stdout / 默认 stderr）
# ---------------------------------------------------------------------------

def test_r2_4a_logging_stream_stdout_masked(r2_project):
    """断言：basicConfig(stream=sys.stdout, level=INFO) 后 logging.info(值)
    → 经捕获流 → 回执 stdout 遮蔽（level 必须 INFO，默认 WARNING 会丢消息）。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import logging, sys\n'
                'logging.getLogger().handlers.clear()\n'
                'logging.basicConfig(stream=sys.stdout, level=logging.INFO)\n'
                'logging.info(datasets["AE"].iloc[0]["AETERM"])\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "INFO:root:[DATA]\n"
    _assert_zero_leak(result)


def test_r2_4b_logging_default_stderr_masked(r2_project):
    """断言：basicConfig() 默认流（调用时即捕获流 sys.stderr）+
    logging.warning(值) → 回执 stderr 遮蔽。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import logging\n'
                'logging.getLogger().handlers.clear()\n'
                'logging.basicConfig(level=logging.WARNING)\n'
                'logging.warning(datasets["AE"].iloc[0]["AETERM"])\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stderr"] == "WARNING:root:[DATA]\n"
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# R2-5 交互攻击：值写临时文件 → 跨回执（另一 run_code）读回打印
# ---------------------------------------------------------------------------

def test_r2_5_cross_receipt_file_roundtrip_masked(r2_project):
    """断言：回执①把值落盘项目根文件（不打印）；回执②另一次 run_code
    读回该文件并 print——数据流仍必经 stdout 捕获流 → 遮蔽；两回执均零泄露。"""
    stage = str(r2_project / "leak_stage.txt").replace("\\", "/")
    first = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": f'v = datasets["AE"].iloc[0]["USUBJID"]\n'
                f'with open("{stage}", "w", encoding="utf-8") as fh:\n'
                f'    fh.write(v)\n'
                f'outputs = {{"AE": datasets["AE"].copy()}}\n'})
    assert first["ok"] is True, first
    _assert_zero_leak(first)

    second = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": f'with open("{stage}", encoding="utf-8") as fh:\n'
                f'    print(fh.read())\n'
                f'outputs = {{"AE": datasets["AE"].copy()}}\n'})
    assert second["ok"] is True, second
    assert second["receipt"]["stdout"] == "[DATA]\n"
    _assert_zero_leak(second)


# ---------------------------------------------------------------------------
# R2-6 outputs 表名遮蔽后 key 冲突：回执恒合法 JSON、行为确定
# ---------------------------------------------------------------------------

def test_r2_6a_masked_table_name_collision_valid_json(r2_project):
    """断言：两个表名均为单元格值 → 遮蔽后同 key "[DATA]"（插入序后者
    覆盖）；回执仍是合法 JSON（json.dumps 不抛）、outputCount 保留 2、
    零泄露、重复调用结果逐字节一致（确定性）。"""
    code = ('v1 = datasets["AE"].iloc[0]["AETERM"]\n'
            'v2 = datasets["AE"].iloc[1]["AETERM"]\n'
            'outputs = {v1: pd.DataFrame({"K": [1]}), v2: pd.DataFrame({"K": [2]})}\n')
    request = {"operation": "listing_run_code", "project": str(r2_project), "code": code}
    result = worker.dispatch(dict(request))
    assert result["ok"] is True, result
    assert list(result["receipt"]["outputs"]) == ["[DATA]"]
    assert result["receipt"]["outputCount"] == 2
    assert json.dumps(result)                      # 合法 JSON，不抛
    _assert_zero_leak(result)
    again = worker.dispatch(dict(request))
    assert _payload(again) == _payload(result)     # 行为确定性


def test_r2_6b_native_data_key_collision_valid_json(r2_project):
    """断言：原生表名 "[DATA]" 与走私表名（遮蔽后同名）冲突 → 插入序后者
    覆盖，回执仍合法 JSON、零泄露。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'v = datasets["AE"].iloc[0]["AETERM"]\n'
                'outputs = {"[DATA]": pd.DataFrame({"K": [1]}),\n'
                '           v: pd.DataFrame({"K": [2]})}\n'})
    assert result["ok"] is True, result
    assert list(result["receipt"]["outputs"]) == ["[DATA]"]
    assert json.dumps(result)
    _assert_zero_leak(result)


# ---------------------------------------------------------------------------
# R2-7 大规模压力：50000 值集 + 1MB stdout（1000 处嵌入命中）
# ---------------------------------------------------------------------------

_VALUE_RE = re.compile(r"VAL-\d{6}")


def _build_stress_project(tmp_path):
    (tmp_path / "doc").mkdir()
    with (tmp_path / "BIG.csv").open("w", encoding="utf-8") as fh:
        fh.write("V\n")
        for index in range(1, 50_001):
            fh.write(f"VAL-{index:06d}\n")
    return tmp_path


def test_r2_7a_unit_mask_1mb_50k_values_under_2s():
    """断言（单元级）：50000 值集 + 1MB 文本（1000 处嵌入命中），
    mask_text 全量遮蔽且耗时 ≤2s。"""
    from value_mask import build_value_set, mask_text
    import pandas as pd
    frame = pd.DataFrame({"V": [f"VAL-{i:06d}" for i in range(1, 50_001)]})
    values, stats = build_value_set({"BIG": frame})
    assert stats == {"total": 50_000, "selected": 50_000, "degraded": False, "dropped": 0}
    hits = "".join(f"x{f'VAL-{i:06d}'}y" for i in range(1, 1001))
    text = hits + "-" * (1024 * 1024 - len(hits))
    assert len(text) == 1024 * 1024
    start = time.perf_counter()
    masked = mask_text(text, values)
    elapsed = time.perf_counter() - start
    assert elapsed <= 2.0, f"1MB 遮蔽超预算: {elapsed:.3f}s"
    assert masked.count("[DATA]") == 1000          # 命中全遮
    assert _VALUE_RE.findall(masked) == []         # 完整值零残留


def test_r2_7b_end_to_end_dispatch_1mb_under_2s(tmp_path):
    """断言（端到端）：inspect 种 50000 值会话后，run_code 打印 1MB
    stdout（1000 处嵌入命中）→ dispatch ≤2s、stdoutTruncated=True、
    回执内 1000 命中全遮蔽、完整值零出域。"""
    project = _build_stress_project(tmp_path)
    seeded = worker.dispatch({"operation": "listing_inspect", "project": str(project)})
    assert seeded["ok"] is True, seeded
    code = ('import sys\n'
            'hits = "".join("xVAL-%06dy" % i for i in range(1, 1001))\n'
            'sys.stdout.write(hits + "-" * (1024 * 1024 - len(hits)))\n'
            'print()\n'
            'outputs = {"T": pd.DataFrame({"K": [1]})}\n')
    start = time.perf_counter()
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(project), "code": code})
    elapsed = time.perf_counter() - start
    assert result["ok"] is True, result
    assert elapsed <= 2.0, f"端到端 1MB dispatch 超预算: {elapsed:.3f}s"
    receipt = result["receipt"]
    assert receipt["stdoutTruncated"] is True      # 1MB 触捕获上限护栏
    assert receipt["stdout"].count("[DATA]") == 1000
    assert _VALUE_RE.findall(_payload(result)) == []


# ---------------------------------------------------------------------------
# R2-8 回归锁定：doc/ 豁免、开关关原样、7 键放行、执行自由
# ---------------------------------------------------------------------------

def test_r2_8a_doc_payload_exemption_regression(r2_project):
    """断言：doc/ 文本全量直通（REQUIREMENT-TAIL 可见），数据集行值仍零泄露。"""
    result = worker.dispatch({"operation": "listing_inspect", "project": str(r2_project)})
    assert result["ok"] is True, result
    payload = _payload(result)
    assert "REQUIREMENT-TAIL" in payload
    _assert_zero_leak(result)


def test_r2_8b_switch_off_passthrough_regression(tmp_path):
    """断言：dataInterception=false → 零拦截，stdout 原样含行值（正确语义）。"""
    (tmp_path / "AE.csv").write_text(
        "USUBJID,AETERM\nSUBJ-777,Headache\n", encoding="utf-8")
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(tmp_path),
        "dataInterception": False,
        "code": 'print(datasets["AE"].iloc[0]["AETERM"])\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert result["receipt"]["stdout"] == "Headache\n"


def test_r2_8c_dataset_metadata_seven_keys_regression(r2_project):
    """断言：数据集元数据 7 键 + profile（2026-08-30 重构：语义画像列级
    放行）+ _source 放行，值不遮蔽列名（零误伤）。"""
    result = worker.dispatch({"operation": "listing_inspect", "project": str(r2_project)})
    assert result["ok"] is True, result
    dataset = result["inspection"]["datasets"][0]
    assert set(dataset) == {
        "name", "path", "columns", "rowCount", "dtypes", "nullCount",
        "uniqueCount", "profile", "_source"}
    assert dataset["columns"] == ["USUBJID", "AETERM", "DOSE"]


def test_r2_8d_execution_freedom_subprocess_regression(r2_project):
    """断言：执行自由不回归——import os/subprocess 可用、子进程可执行。"""
    result = worker.dispatch({
        "operation": "listing_run_code", "project": str(r2_project),
        "code": 'import os, subprocess, sys\n'
                'os.environ["R2_PROBE"] = "1"\n'
                'proc = subprocess.run(\n'
                '    [sys.executable, "-c", "print(\'R2-SUBPROC-OK\')"],\n'
                '    capture_output=True, text=True)\n'
                'assert proc.returncode == 0\n'
                'print(proc.stdout.strip())\n'
                'outputs = {"AE": datasets["AE"].copy()}\n'})
    assert result["ok"] is True, result
    assert "R2-SUBPROC-OK" in result["receipt"]["stdout"]
    _assert_zero_leak(result)
