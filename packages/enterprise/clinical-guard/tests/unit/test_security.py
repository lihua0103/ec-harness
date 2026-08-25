from __future__ import annotations

import json
import hashlib
import re
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
# 2026-08-25 架构迁移：Python 运行时已移入 python/ 子目录。
PYTHON_ROOT = ROOT / "python"
sys.path.insert(0, str(PYTHON_ROOT))
os.chdir(ROOT)
# FIX-12 后审计/授权默认写入用户主目录；测试显式指回项目 var 以便断言审计内容。
os.environ.setdefault("EMERALD_AUDIT_ROOT", str(PYTHON_ROOT / "var" / "egress_audit"))

from security.audit_log import AuditLockTimeout, write_audit_record  # noqa: E402
from security.egress_checkpoint import EgressCheckpoint, EgressViolation, check_egress  # noqa: E402
from security.patterns import sanitize_error  # noqa: E402

CASES = []


def case(func):
    CASES.append(func)
    return func


@case
def subject_id_blocks():
    try:
        check_egress([{"role": "user", "content": "Subject A1234567"}])
    except EgressViolation as exc:
        assert exc.audit_id
        return
    raise AssertionError("字母前缀受试者编号未拦截")


@case
def data_protection_toggle_is_dynamic_per_request():
    """同一 worker/checkpoint 实例必须按请求态开关立即切换。"""
    with tempfile.TemporaryDirectory() as directory:
        checkpoint = EgressCheckpoint(directory)
        payload = [{"role": "user", "content": "Subject A1234567"}]
        disabled = checkpoint.check(payload, {"dataProtectionEnabled": False})
        assert disabled["egress_disabled"] is True
        try:
            checkpoint.check(payload, {"dataProtectionEnabled": True})
        except EgressViolation:
            return
    raise AssertionError("请求态重新开启保护后仍放行临床数据")


@case
def audit_lock_timeout_falls_back_to_append():
    """审计锁竞争不得阻塞业务，也不得丢掉本条审计记录。"""
    with tempfile.TemporaryDirectory() as directory:
        with mock.patch("security.audit_log._exclusive_lock", side_effect=AuditLockTimeout("busy")):
            write_audit_record(directory, "lock_fallback", {"event": "fallback", "sequence": 1})
        path = next(Path(directory).glob("lock_fallback_*.jsonl"))
        assert json.loads(path.read_text(encoding="utf-8"))["event"] == "fallback"


@case
def lowercase_subject_and_sas_date_block():
    """ST-P1-1 红队：小写受试者号/SAS 日期不得绕过检测（检测与脱敏口径统一）。"""
    for content in ["subject a1234567", "visit 01jan2024", "pt: 10001234"]:
        try:
            check_egress([{"role": "user", "content": content}])
        except EgressViolation:
            continue
        raise AssertionError(f"小写绕过未拦截: {content}")


@case
def invisible_and_nfkc_bypass_block():
    """ST-P1-2 红队：全角数字/软连字符/BOM/bidi 插入不得切断受试者号检测。"""
    for content in [
        "Subject Ａ１２３４５６７",  # 全角 A1234567
        "A123­4567",   # 软连字符
        "A﻿1234567",   # BOM
        "A​1234567",   # 零宽空格
    ]:
        try:
            check_egress([{"role": "user", "content": content}])
        except EgressViolation:
            continue
        raise AssertionError(f"不可见字符/NFKC 绕过未拦截: {content!r}")


@case
def platform_hyphenated_identifiers_are_not_subject_ids():
    """真实 DSH 请求头回归：平台 kebab-case 标识不得被 USUBJID 模式误杀。"""
    payload = {
        "messages": [{"role": "user", "content": "读取项目需求文档。"}],
        "sessionId": "session-6ad2d0e2-c715-4a38-bdc2-2def4bdfe804",
        "system": "Current fs-observation-policy uses modification-time-ordered files.",
        "tools": [{
            "name": "pwsh",
            "description": "Run with danger-full-access only after approval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sandbox_permissions": {
                        "type": "string",
                        "enum": ["workspace-write", "danger-full-access"],
                    }
                },
            },
        }],
    }
    check_egress(payload)

    # 仅 GenerateOptions 顶层 sessionId 是协议元数据；嵌套同名业务字段不能借此绕过。
    try:
        check_egress({"messages": [{"role": "user", "content": "正常请求"}],
                      "metadata": {"sessionId": "A1234567"}})
    except EgressViolation:
        pass
    else:
        raise AssertionError("嵌套 sessionId 绕过临床数据扫描")

    # 收紧误报不能削弱真实复合 USUBJID 检测。
    for sample in [
        "STUDY001-SITE01-SUBJ001",
        "STUDY-SITE-001",
        "ABC-DEF-001",
    ]:
        try:
            check_egress([{"role": "user", "content": sample}])
        except EgressViolation:
            continue
        raise AssertionError(f"真实 USUBJID 未拦截: {sample}")


@case
def site_subject_and_date_composite_blocks():
    try:
        check_egress([{"role": "user", "content": "101-001234 on 2024-03-05"}])
    except EgressViolation:
        return
    raise AssertionError("复合临床信号未拦截")


@case
def base64_payload_blocks():
    import base64
    encoded = base64.b64encode("USUBJID: A1234567".encode()).decode()
    try:
        check_egress([{"role": "user", "content": encoded}])
    except EgressViolation:
        return
    raise AssertionError("base64 临床载荷未拦截")


@case
def full_generate_options_fields_are_scanned():
    clean_messages = [{"role": "user", "content": "请生成列表规范。"}]
    auxiliary_fields = {
        "system": "Subject A1234567",
        "tools": [{"name": "demo", "description": "Subject A1234567", "parameters": {}}],
        "stop": ["Subject A1234567"],
    }
    for field, value in auxiliary_fields.items():
        try:
            check_egress({"messages": clean_messages, field: value})
        except EgressViolation:
            continue
        raise AssertionError(f"完整模型请求字段未拦截: {field}")


@case
def clean_model_request_audit_keeps_only_fingerprint():
    payload = {
        "provider": "test-provider",
        "model": "test-model",
        "messages": [{"role": "user", "content": "clean request evidence"}],
        "system": "clean system evidence",
        "tools": [{"name": "demo", "description": "clean tool", "parameters": {}}],
        "stop": ["finish"],
    }
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    with tempfile.TemporaryDirectory() as directory:
        checkpoint = EgressCheckpoint(directory)
        evidence = checkpoint.check(payload)
        assert evidence["payload_sha256"] == hashlib.sha256(canonical).hexdigest()
        assert evidence["payload_bytes"] == len(canonical)
        assert evidence["message_count"] == 1
        audit_path = next(Path(directory).glob("*.jsonl"))
        blob = audit_path.read_text(encoding="utf-8")
        assert "clean request evidence" not in blob
        assert "clean system evidence" not in blob


@case
def filename_date_is_allowed():
    check_egress([{"role": "user", "content": "report_v2024-08-18.xlsx"}])


@case
def normal_request_is_fast():
    """NFR-1: 正常请求检查路径 <10ms。

    使用独立临时审计目录（隔离宿主盘 IO 抖动）+ 5 次采样最小值，
    度量检查逻辑本身的成本。
    """
    with tempfile.TemporaryDirectory() as directory:
        checkpoint = EgressCheckpoint(directory)
        best = float("inf")
        for _ in range(5):
            start = time.perf_counter()
            checkpoint.check([{"role": "user", "content": "请帮我生成列表规范说明。"}])
            best = min(best, time.perf_counter() - start)
        assert best * 1000 < 10


@case
def normal_requests_have_low_false_positive_rate():
    samples = [
        "请生成列表规范说明。",
        "更新 README 文档。",
        "运行 npm test。",
        "检查 CI 状态。",
        "准备开发计划。",
    ] * 20
    blocked = [text for text in samples if not _allows(text)]
    assert not blocked, f"正常请求误拦: {blocked}"


def _allows(text: str) -> bool:
    try:
        check_egress([{"role": "user", "content": text}])
        return True
    except EgressViolation:
        return False


@case
def every_request_is_audited_without_raw_values():
    audit_dir = Path(os.environ.get("EMERALD_AUDIT_ROOT", PYTHON_ROOT / "var" / "egress_audit"))
    # D-3 (2026-08-22): 只统计 egress 域文件。此前 glob("*.jsonl") 会把
    # ai_ops/listing_ops 一起拼进 records——一旦 listing_ops_*.jsonl 存在
    # （任何 listing execute 测试先运行过），尾部 2 条就不再是本次 egress
    # 记录，ALLOWED/BLOCKED 断言必红。
    before = sum(
        len(path.read_text(encoding="utf-8").splitlines())
        for path in audit_dir.glob("egress_*.jsonl")
    )
    _allows("请生成列表规范说明。")
    assert not _allows("Subject A1234567")
    records = []
    for path in audit_dir.glob("egress_*.jsonl"):
        records.extend(line for line in path.read_text(encoding="utf-8").splitlines() if line)
    assert len(records) - before == 2
    blob = "\n".join(records[-2:])
    assert '"action":"ALLOWED"' in blob or '"action": "ALLOWED"' in blob
    assert '"action":"BLOCKED"' in blob or '"action": "BLOCKED"' in blob
    assert "A1234567" not in blob


@case
def audit_rotation_has_disk_cap():
    with tempfile.TemporaryDirectory() as root:
        # ST-D-4: 文件名跟随当前月份，不能写死 egress_202608（否则跨月必红）。
        stem = f"egress_{datetime.now().strftime('%Y%m')}.jsonl"
        for index in range(6):
            archive = Path(root) / f"{stem}.{index:02d}-00000000.rotated"
            archive.write_text("{}", encoding="utf-8")
        write_audit_record(
            root, "egress", {"audit_id": "rotation-test"},
            max_bytes=1, max_archives=2,
        )
        files = list(Path(root).iterdir())
        archives = [path for path in files if path.name.endswith(".rotated")]
        current = Path(root) / stem
        assert len(archives) == 2
        assert current.read_text(encoding="utf-8").strip()


@case
def hardened_audit_directory_remains_writable():
    """Windows 仅支持 chmod 的只读位语义，权限加固不能锁死审计目录。"""
    with tempfile.TemporaryDirectory() as root:
        audit_dir = Path(root) / "fresh" / "audit"
        write_audit_record(str(audit_dir), "egress", {"audit_id": "first"})
        write_audit_record(str(audit_dir), "egress", {"audit_id": "second"})
        records = "\n".join(
            path.read_text(encoding="utf-8")
            for path in audit_dir.glob("egress_*.jsonl")
        )
        assert '"audit_id":"first"' in records
        assert '"audit_id":"second"' in records


# ============================================================================
# FIX-1~FIX-12 新增验收用例
# ============================================================================


def _run_worker(lines, timeout=20):
    """直接以子进程驱动 security.worker，逐行喂请求并收集响应。"""
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(ROOT)
    proc = subprocess.Popen(
        [sys.executable, "-m", "security.worker"],
        cwd=PYTHON_ROOT, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8",
    )
    try:
        out, err = proc.communicate("\n".join(lines) + "\n", timeout=timeout)
        responses = [json.loads(line) for line in out.splitlines() if line.strip()]
        return responses, err
    finally:
        if proc.poll() is None:
            proc.kill()


@case
def worker_malformed_line_returns_unavailable_and_survives():
    """AR-2.6 / FIX-6: 非法 JSON 行返回 SECURITY_UNAVAILABLE 且继续服务。"""
    good = json.dumps({
        "requestId": "r1", "operation": "ping",
    })
    responses, _ = _run_worker(["{{{not-json", good])
    assert responses[0]["ok"] is False
    assert responses[0]["code"] == "SECURITY_UNAVAILABLE"
    assert responses[0]["requestId"] is None
    assert responses[1]["ok"] is True
    assert responses[1]["requestId"] == "r1"


@case
def sanitize_error_strips_paths_subjects_and_dates():
    """FIX-3: sanitize_error 覆盖 Windows 路径、受试者编号与日期。"""
    raw = r"open failed: C:\data\patient-A1234567.xlsx at 2024-03-05 visit 101-0012"
    cleaned = sanitize_error(raw)
    assert "A1234567" not in cleaned
    assert "2024-03-05" not in cleaned
    assert "101-0012" not in cleaned
    assert "C:" not in cleaned


@case
def sensitive_key_names_block_and_audit_never_leak_raw_key():
    """R-7 / FR-09-03 / FR-12-05 / FIX-2: 顶层/嵌套敏感键名阻断；审计只留哈希。"""
    with tempfile.TemporaryDirectory() as directory:
        checkpoint = EgressCheckpoint(directory)
        for payload in (
            {"A1234567": "value", "messages": [{"role": "user", "content": "hi"}]},
            {"messages": [{"role": "user", "content": "hi", "meta": {"SUBJ-01-001234": 1}}]},
        ):
            try:
                checkpoint.check(payload)
            except EgressViolation:
                continue
            raise AssertionError(f"敏感键名未拦截: {payload}")
        blob = "\n".join(
            path.read_text(encoding="utf-8")
            for path in Path(directory).glob("*.jsonl")
        )
        assert "A1234567" not in blob
        assert "SUBJ-01-001234" not in blob


@case
def audit_payload_fields_use_known_whitelist_and_hash_unknown():
    """FR-12-05 / FIX-2: 已知字段呈现名称，未知字段只留截断哈希。"""
    with tempfile.TemporaryDirectory() as directory:
        checkpoint = EgressCheckpoint(directory)
        checkpoint.check({
            "model": "m", "messages": [{"role": "user", "content": "clean"}],
            "secretCustomField": "anything",
        })
        record = json.loads(
            next(Path(directory).glob("*.jsonl")).read_text(encoding="utf-8").splitlines()[-1]
        )
        fields = record["request_evidence"]["payload_fields"]
        assert "model" in fields and "messages" in fields
        assert "secretCustomField" not in fields
        assert any(str(f).startswith("sha256:") for f in fields)


@case
def _concurrent_writer(root, worker_id):
    for i in range(40):
        write_audit_record(
            root, "egress",
            {"worker": worker_id, "seq": i},
            # max_bytes=400 使并发期间触发多次轮转 + 归档清理，覆盖 TC-34 全路径。
            max_bytes=400, max_archives=5,
        )


@case
def concurrent_audit_writes_keep_every_record():
    """BR-06.10 / TC-34 / NFR-13 / FIX-7: 双进程并发追加 + 轮转不丢记录。"""
    import multiprocessing

    with tempfile.TemporaryDirectory() as root:
        procs = [
            multiprocessing.Process(target=_concurrent_writer, args=(root, w))
            for w in range(2)
        ]
        for p in procs:
            p.start()
        for p in procs:
            p.join(timeout=60)
            assert p.exitcode == 0

        records = []
        for path in Path(root).glob("egress_*.jsonl*"):
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    records.append(json.loads(line))
        assert len(records) == 80, f"并发丢记录: {len(records)}/80"
        seen = {(r["worker"], r["seq"]) for r in records}
        assert len(seen) == 80
        archives = list(Path(root).glob("*.rotated"))
        assert len(archives) <= 5


@case
def base64_short_candidates_are_not_flagged():
    """NFR-2 / FIX-11: 短 base64 候选（<24 总长）不触发拦截，误报不回归。"""
    for token in ["aGVsbG8gd29ybGQh", "dGVzdDEyMw", "QUJDREVGRw"]:
        try:
            check_egress([{"role": "user", "content": f"ref {token} done"}])
        except EgressViolation:
            raise AssertionError(f"短 base64 候选误报: {token}")


@case
def identity_context_hash_is_non_empty():
    """BR-06.5 / FIX-9: camelCase 上下文身份真实进入审计（哈希非空）。"""
    with tempfile.TemporaryDirectory() as directory:
        checkpoint = EgressCheckpoint(directory)
        checkpoint.check(
            [{"role": "user", "content": "clean"}],
            {"mode": "enforce", "sessionId": "sess-1", "userId": "user-1"},
        )
        record = json.loads(
            next(Path(directory).glob("*.jsonl")).read_text(encoding="utf-8").splitlines()[-1]
        )
        assert record["context"]["session_id"]
        assert record["context"]["session_id"].startswith("sha256:")
        assert record["context"]["user_id"].startswith("sha256:")


@case
def node_patterns_json_matches_python_source_of_truth():
    """Claude P2-3 / FIX-11: node_patterns.json 与 patterns.py 保持一致。"""
    from security.patterns import NODE_DLP_PATTERNS
    synced = json.loads(
        (PYTHON_ROOT / "security" / "node_patterns.json").read_text(encoding="utf-8")
    )
    expected = [
        {
            "source": p["re"],
            "flags": p.get("flags", ""),
            "label": p["label"],
            # S4: severity 决定 Node 侧阻断/仅告警，属于必须同步的判据。
            "severity": p.get("severity", "block"),
        }
        for p in NODE_DLP_PATTERNS
    ]
    assert synced == expected, "运行 scripts/sync_patterns.py 同步 Node 模式副本"
    # 纯日期形态在两侧都只是 WARN；若被改回 block，写 spec/SAS 会再次被拦死。
    severities = {item["label"]: item["severity"] for item in synced}
    assert severities["ISO_DATE"] == "warn"
    assert severities["SAS_DATE"] == "warn"
    assert severities["ISO8601_DATETIME"] == "block"
    assert severities["SITE_SUBJECT_ID"] == "block"


@case
def xls_header_extraction_delivers_structure_without_values():
    """FR-06-03 / TC-15 / FIX-8: .xls 经 xlrd 解析表头结构，数据值不泄露。"""
    import xlwt
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "legacy.xls"
        workbook = xlwt.Workbook()
        sheet = workbook.add_sheet("DM")
        for col, name in enumerate(["USUBJID", "BRTHDTC", "SEX"]):
            sheet.write(0, col, name)
        sheet.write(1, 0, "A1234567")
        sheet.write(1, 1, "2024-03-05")
        workbook.save(str(path))

        result = subprocess.run(
            [sys.executable, str(ROOT / "excel_header_extractor.py"), str(path)],
            capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        blob = json.dumps(payload, ensure_ascii=False)
        assert payload["sheets"][0]["sheet"] == "DM"
        assert any(c["value"] == "USUBJID" for c in payload["sheets"][0]["header_cells"])
        assert "A1234567" not in blob and "2024-03-05" not in blob


# ============================================================================
# 真实项目（CGB3002-TEST）暴露缺陷的回归用例
# ============================================================================


@case
def worker_surrogate_input_survives():
    """真实故障（CGB3002 运行一炮报错）：JSON 携带 \\udcae 孤立代理。

    worker 响应写 stdout 曾直接 UnicodeEncodeError 崩溃、后续请求全部挂起；
    现在必须返回响应（代理→U+FFFD）且继续服务。
    """
    dirty = json.dumps({
        "requestId": "s1", "operation": "scrub_text",
        "text": "subject 01001 on 08 Jun 2026 \udcae trailing", "context": {},
    })
    ping = json.dumps({"requestId": "s2", "operation": "ping"})
    responses, _ = _run_worker([dirty, ping])
    assert len(responses) == 2, "worker 遇孤立代理崩溃，未继续服务"
    assert responses[0]["ok"] is True
    assert "\udcae" not in responses[0].get("text", "")
    assert responses[1]["ok"] is True and responses[1]["requestId"] == "s2"


@case
def sanitize_error_and_clean_surrogates_handle_lone_surrogates():
    """sanitize_error / clean_surrogates 清除孤立代理且保留可读文本。"""
    from security.patterns import clean_surrogates
    raw = "read failed: \udcae\udcff at C:\\data\\A1234567.xlsx"
    cleaned = sanitize_error(raw)
    assert "\udcae" not in cleaned and "\udcff" not in cleaned
    assert "A1234567" not in cleaned and "C:" not in cleaned
    assert "\ud800" not in clean_surrogates("ok \ud800\udfff done")


@case
def dd_mmm_yyyy_clinical_date_is_detected_and_scrubbed():
    """真实缺陷（crViewer.xls）：DD-MMM-YYYY 临床日期未识别。

    08 Jun 2026 / 08 Jun 2026 05:19:50 是 Rave/EDC 导出标准格式，
    检测（出域阻断）与轻度脱敏双侧必须覆盖。
    """
    for text in ["Visit 08 Jun 2026 done", "Entry 08 Jun 2026 05:19:50 done"]:
        try:
            check_egress([{"role": "user", "content": text}])
        except EgressViolation:
            continue
        raise AssertionError(f"临床报告日期未拦截: {text}")
    from security.tokenizer import tokenize_clinical_text
    joined = " ".join(tokenize_clinical_text(value) for value in (
        "08 Jun 2026", "08 Jun 2026 05:19:50"
    ))
    assert "Jun" not in joined and "[DATE:" in joined


@case
def headerless_data_table_does_not_leak_rows():
    """真实红线泄露（crViewer.xls）：无表头数据表整表被当作表头输出。

    结构复刻：2 行标题 + 数值型数据行（编号/数值/日期/状态）。
    修复后 header_cells 只含标题行，data_start_row 停在首个数据行。
    """
    import openpyxl
    from excel_header_extractor import process_xlsx  # 薄壳转发
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "crviewer_like.xlsx")
        workbook = openpyxl.Workbook()
        sheet = workbook.active
        sheet.append(["SiteGroup: World"])
        sheet.append(["Site: UAT_006 (Site Number:23)"])
        for subject in ["01001", "01002", "S005"]:
            sheet.append([subject, "346.0", "08 Jun 2026 05:19:50", "Screening"])
        workbook.save(path)
        result = subprocess.run(
            [sys.executable, str(ROOT / "excel_header_extractor.py"), path],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
        assert result.returncode == 0, result.stderr
        blob = result.stdout
        for marker in ["01001", "01002", "S005", "346.0", "08 Jun 2026"]:
            assert marker not in blob, f"无表头数据表泄露数据行: {marker}"
        payload = json.loads(blob)
        entry = payload["sheets"][0]
        assert entry["data_start_row"] == 2
        assert entry["header_cells"] == [
            {"row": 0, "col": 0, "value": "COLUMN_1"},
            {"row": 1, "col": 0, "value": "COLUMN_1"},
        ]


@case
def leading_zero_subject_cell_is_redacted():
    """真实缺陷（crViewer.xls）：前导零 5 位受试者号（01001）未脱敏。

    NUMERIC_SUBJECT_ID_RE 覆盖 EDC 前导零形态。
    ST-P1-9 输出白名单收紧后：普通短数值（346.0/002/2024）在表头输出侧
    也一律 REDACTED（DATA_VALUE 兜底）——列名极少是纯数字，数据值常是，
    误判表头时这类值原值输出即泄露通道。
    """
    from security.header_detect import _dlp_scan_cell
    cleaned, label = _dlp_scan_cell("01001")
    assert label == "SUBJECT_ID" and "01001" not in str(cleaned)
    repeated, _ = _dlp_scan_cell("01001")
    assert repeated == cleaned and str(cleaned).startswith("[SUBJ:")
    for data_like in ["346.0", "002", "2024"]:
        value, hit = _dlp_scan_cell(data_like)
        assert hit == "DATA_VALUE" and data_like not in str(value), \
            f"数据形态值原值输出: {data_like}"
    # 合法列名（含安全词/中文列名）不误伤
    for header in ["Subject", "Visit Date", "受试者编号", "Visit 1", "Day 8"]:
        value, hit = _dlp_scan_cell(header)
        assert hit is None and value == header, f"列名误报: {header}"


@case
def sdtm_column_names_survive_metadata_projection():
    """真实缺陷回放：合法 SDTM 字段名被元数据车道打成 COLUMN_n。

    2026-08-24：header_names 原先用白名单证明制（必须命中临床词表才输出原值），
    实测 32 个标准列名丢 13 个——ALT、AST、TBIL、EXDOSE、EXTRT、CMTRT、VSORRES、
    VSTESTCD、QSORRES、SUPPDM、IDVAR、QNAM、QVAL。列名进 inspect 收据的 schema，
    harness 拿到 COLUMN_n 无法按 ALS 字段定位数据列，execute 取列也会失败。
    列名是结构元数据，不能套用面向数据值的保护启发式。
    """
    from security.header_detect import header_names
    columns = [
        "STUDYID", "DOMAIN", "USUBJID", "SUBJID", "RFSTDTC", "RFENDTC",
        "SITEID", "BRTHDTC", "AGE", "AGEU", "SEX", "RACE", "ETHNIC",
        "ARMCD", "ARM", "ALT", "AST", "TBIL", "AETERM", "AEDECOD", "AESEV",
        "AESTDTC", "EXDOSE", "EXTRT", "CMTRT", "VSORRES", "VSTESTCD",
        "QSORRES", "SUPPDM", "IDVAR", "QNAM", "QVAL",
    ]
    projected, verdict = header_names(columns, with_verdict=True)
    lost = [(a, b) for a, b in zip(columns, projected) if a != b]
    assert not lost, f"合法 SDTM 列名被降级: {lost}"
    assert verdict, "标准 SDTM 表头行未被判为表头，rowCount 会多算一行"

    # ALS/EDC 导出表头与中文表头同样必须原样通过。
    for header in (
        ["Form", "ItemOID", "SASLabel", "DataType", "CodeList"],
        ["受试者编号", "访视", "检查项目", "结果", "单位"],
    ):
        assert header_names(header) == header, f"表头被降级: {header}"


@case
def data_rows_still_degrade_in_metadata_projection():
    """放宽列名投影不能放宽安全边界：无表头文件的首行仍须整行降级。"""
    from security.header_detect import header_names
    rows = [
        ["GQ1005-301", "101-0001", "2024-03-05", "45", "M", "ASIAN", "12.5", "ONGOING"],
        ["1", "2", "3.5", "1,200", "0.001"],
        ["S001", "受试者", "2023-01-02"],
    ]
    for row in rows:
        projected, verdict = header_names(row, with_verdict=True)
        assert not verdict, f"数据行被误判为表头: {row}"
        leaked = [value for value in projected if value in row]
        assert not leaked, f"数据行原值出现在投影结果里: {leaked}"


@case
def edc_system_fields_map_to_canonical_roles():
    from security.header_detect import canonical_edc_field, header_names
    aliases = {
        "SubjectName": "subject", "SiteNumber": "site",
        "FolderName": "visit", "FormName": "form",
        "RecordPosition": "repeat", "ItemGroupRepeatKey": "repeat",
        "SubjectStatus": "status", "ModifiedDate": "date",
    }
    for field, expected in aliases.items():
        assert canonical_edc_field(field) == expected
    assert header_names(list(aliases)) == list(aliases)


@case
def message_id_uuid_does_not_trigger_egress_block():
    """E2E-4 回归: 消息元数据 UUID 字段（payload.messages[n].id）不引发误拦截。

    UUID 形如 abc12345-0001-0002-0003-def456789012，与受试者编号模式部分重叠；
    _METADATA_KEY_FIELDS 白名单确保此类标量值跳过内容 DLP。
    """
    payload = {
        "model": "gpt-4o",
        "messages": [
            {"role": "user", "content": "请生成列表", "id": "abc12345-0001-0002-0003-def456789012"},
            {"role": "assistant", "content": "好的", "id": "bcd23456-0001-0002-0003-ef0123456789"},
        ],
    }
    try:
        check_egress(payload)
    except EgressViolation as exc:
        raise AssertionError(f"消息 id UUID 误报触发拦截: {exc}") from exc


@case
def singleton_get_egress_checkpoint_is_thread_safe():
    """ST-P3-x 回归: 并发 get_egress_checkpoint() 返回同一对象。"""
    import threading
    from security.egress_checkpoint import get_egress_checkpoint
    instances = []
    def _get(): instances.append(id(get_egress_checkpoint()))
    threads = [threading.Thread(target=_get) for _ in range(8)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert len(set(instances)) == 1, f"单例不唯一，得到 {len(set(instances))} 个实例"


@case
def document_version_number_is_not_subject_id():
    """真实缺陷回归：'标识+YYYYMMDD' 文档版本号不得被误判为受试者编号。

    历史故障：`\\b[A-Z]{1,4}\\d{6,8}\\b` 把 DVP20260610 判为受试者编号。因
    llm/stream 每轮重扫完整 messages 历史，一条误报即把整个会话永久钉死
    （审计 20260820_135432-c4f47e1a89：109 个阻断威胁全是该模式）。
    """
    for text in ("DVP20260610 修订说明", "SPEC20260610", "ALS20251231 定稿",
                 "参见 DVP 20260610 第 3 节"):
        assert _allows(text), f"文档版本号被误拦: {text!r}"


@case
def document_version_exemption_does_not_weaken_subject_detection():
    """反向回归：文档版本号豁免绝不能放宽真实受试者编号的检出。

    豁免是纯格式判据（尾部 8 位须为合法 YYYYMMDD），因此 7 位数字的
    A1234567、月份非法的 S0001234、非日期的 EC12345678 必须仍被拦截。
    """
    for text in ("Subject A1234567", "subj S0001234", "Edit Check EC12345678",
                 "site 101-001"):
        assert not _allows(text), f"真实受试者编号漏放: {text!r}"


@case
def spec_and_header_terms_are_allowed():
    """spec/ALS/template 文本与 SAS 表头字段名允许出域（用户规则：表头可读）。"""
    for text in ("spec ALS DVP template 表头 USUBJID AESTDTC VISITNUM",
                 "读取 CGB3002 项目的 ALS 文档与 DVP 模板",
                 "SAS 数据集表头: USUBJID, SITEID, VISIT, AEDECOD"):
        assert _allows(text), f"spec/表头文本被误拦: {text!r}"


@case
def main() -> int:
    failures = 0
    for test in CASES:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as exc:
            failures += 1
            print(f"FAIL {test.__name__}: {exc}")
    print(f"RESULT {len(CASES) - failures}/{len(CASES)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
