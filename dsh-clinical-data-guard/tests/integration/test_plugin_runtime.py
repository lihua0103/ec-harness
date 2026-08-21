from __future__ import annotations

import json
import hashlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "tests" / "integration" / "plugin_driver.js"
sys.path.insert(0, str(ROOT))
# FIX-12 后审计默认写入用户主目录；测试显式指回项目 var 以便断言审计内容。
os.environ.setdefault("EMERALD_AUDIT_ROOT", str(ROOT / "var" / "egress_audit"))


def make_xlsx(path: Path):
    import openpyxl
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Specification"
    sheet.append(["Subject", "Visit", "Status"])
    sheet.append(["A1234567", "2024-03-05", "Screening"])
    workbook.save(path)


def run(scenario: str, excel: Path | None = None, authz: Path | None = None,
        python: str | None = None, mode: str | None = None,
        credentials_dir: Path | None = None, credential_file: Path | None = None):
    env = os.environ.copy()
    env["PYTHON"] = python or sys.executable
    env["PLUGIN_PYTHON"] = python or sys.executable
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if excel:
        env["EXCEL_FILE"] = str(excel)
    if authz:
        env["AUTHZ_ROOT"] = str(authz)
    if mode:
        env["PLUGIN_MODE"] = mode
    if credentials_dir:
        env["CREDENTIALS_DIR"] = str(credentials_dir)
    if credential_file:
        env["CREDENTIAL_FILE"] = str(credential_file)
    result = subprocess.run(
        ["node", str(DRIVER), scenario],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_local_metadata_lane_denies_generic_source_access():
    """UAT 车道不因启用本地分析而放开 bash/read 的原始文件读取。"""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / "project"
        root.mkdir()
        source = root / "source.xlsx"
        make_xlsx(source)
        env = os.environ.copy()
        env["PYTHON"] = sys.executable
        env["PLUGIN_PYTHON"] = sys.executable
        env["LOCAL_DATA_ACCESS"] = "uat-local"
        env["LOCAL_DATA_ROOT"] = str(root)
        env["LOCAL_METADATA_FILE"] = str(source)
        result = subprocess.run(
            ["node", str(DRIVER), "pre-generic-source"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        assert result.returncode == 0, result.stderr
        output = json.loads(result.stdout)
        assert output["kind"] == "deny"
        assert "本地" in output.get("reason", "")


def test_local_metadata_lane_returns_only_structure_and_enforces_root():
    """UAT 本地数据车道只给模型结构元数据，且不可越过指定项目根。"""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / "project"
        root.mkdir()
        source = root / "source.xlsx"
        make_xlsx(source)
        outside = Path(directory) / "outside.xlsx"
        make_xlsx(outside)
        env = os.environ.copy()
        env["PYTHON"] = sys.executable
        env["PLUGIN_PYTHON"] = sys.executable
        env["LOCAL_DATA_ACCESS"] = "uat-local"
        env["LOCAL_DATA_ROOT"] = str(root)
        env["LOCAL_METADATA_FILE"] = str(source)
        env["LOCAL_METADATA_OUTSIDE_FILE"] = str(outside)
        result = subprocess.run(
            ["node", str(DRIVER), "local-metadata"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        assert result.returncode == 0, result.stderr
        output = json.loads(result.stdout)
        assert output["gate"]["kind"] == "allow"
        value = output["value"]
        assert value["clinicalGuard"] == "LOCAL_METADATA_ONLY"
        assert value["path"] == "source.xlsx"
        assert value["sheets"][0]["columns"] == ["Subject", "Visit", "Status"]
        assert "A1234567" not in json.dumps(value, ensure_ascii=False)

        outside_result = subprocess.run(
            ["node", str(DRIVER), "local-metadata-outside-root"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        assert outside_result.returncode == 0, outside_result.stderr
        assert json.loads(outside_result.stdout)["blocked"] is True


def test_extension_registration_and_sas_denial():
    decision = run("pre-sas")
    assert decision["kind"] == "deny"
    assert "SAS" in decision["reason"] or "数据" in decision["reason"]


def test_llm_clean_streams_and_dirty_blocks():
    assert run("llm-clean")["streamed"] is True
    assert run("llm-platform-header-clean")["streamed"] is True
    # smart_guard 自愈：脏载荷不再抛异常拦死，token 化后继续流式；
    # 原值不出域（content 中受试者编号已换成 [SUBJ:xx] token）。
    dirty = run("llm-dirty")
    assert dirty["streamed"] is True
    assert "A1234567" not in dirty["content"]
    assert "[SUBJ:" in dirty["content"]


def test_full_model_request_scope_blocks_and_audits_clean_requests():
    # smart_guard 自愈：system 字段命中同样 token 化后继续，不再拦死。
    dirty = run("llm-system-dirty")
    assert dirty["streamed"] is True
    assert "A1234567" not in dirty["system"]
    assert "[SUBJ:" in dirty["system"]

    assert run("llm-clean")["streamed"] is True
    payload = {
        "provider": "test-provider",
        "model": "test-model",
        "messages": [{"role": "user", "content": "请生成列表规范。"}],
        "system": "出域审计范围验证",
        "tools": [{
            "name": "demo",
            "description": "演示工具",
            "parameters": {"type": "object", "properties": {}},
        }],
        "temperature": 0.2,
        "maxTokens": 128,
        "stop": ["完成"],
        "purpose": "session-title",
    }
    canonical = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    audit_path = max(
        (ROOT / "var" / "egress_audit").glob("*.jsonl"),
        key=lambda path: path.stat().st_mtime,
    )
    record = json.loads(audit_path.read_text(encoding="utf-8").splitlines()[-1])
    evidence = record["request_evidence"]
    assert record["action"] == "ALLOWED"
    assert evidence["payload_sha256"] == hashlib.sha256(canonical).hexdigest()
    assert evidence["payload_bytes"] == len(canonical)
    assert evidence["message_count"] == 1
    assert {"provider", "model", "messages", "system", "tools", "stop"} <= set(
        evidence["payload_fields"]
    )
    assert "A1234567" not in json.dumps(record, ensure_ascii=False)


def test_shadow_mode_observes_without_blocking_llm():
    assert run("llm-dirty", mode="shadow")["streamed"] is True


def test_non_text_and_invalid_messages_fail_closed():
    assert run("llm-image")["thrown"] is True
    assert run("llm-invalid")["thrown"] is True


def test_excel_post_execute_keeps_headers_only():
    with tempfile.TemporaryDirectory() as directory:
        excel = Path(directory) / "clinical.xlsx"
        make_xlsx(excel)
        decision = run("post-excel", excel=excel)
        blob = json.dumps(decision, ensure_ascii=False)
        assert decision["kind"] == "accept"
        assert "A1234567" not in blob and "2024-03-05" not in blob
        assert "Subject" in blob


def test_no_path_tool_result_is_scrubbed():
    decision = run("post-no-path")
    blob = json.dumps(decision, ensure_ascii=False)
    assert "A1234567" not in blob and "2024-03-05" not in blob
    assert "已自动脱敏" in blob
    assert "[DATE:" in blob


def test_credential_file_value_stays_local():
    """本地凭据通道：credentialsDir 下文件原值不进 LLM 上下文，只回占位+路径。"""
    with tempfile.TemporaryDirectory() as directory:
        cred_dir = Path(directory) / "credentials"
        cred_dir.mkdir()
        cred_file = cred_dir / "A1234567.txt"
        cred_file.write_text("A1234567", encoding="utf-8")
        decision = run(
            "credential-local",
            credentials_dir=cred_dir,
            credential_file=cred_file,
        )
        assert decision["kind"] == "accept"
        value = json.loads(decision["content"][0]["text"])
        assert value["clinicalGuard"] == "CREDENTIAL_LOCAL_ONLY"
        assert "A1234567" not in value.get("message", "")
        # 路径本身是 agent 交给本地工具所需，允许保留文件名中的密码标识。
        assert value["credentialPath"].endswith("A1234567.txt")


def test_l3_prompt_shows_location_patterns_evidence_and_options():
    import gc

    from security.data_egress_guard import scan_xlsx_sheet_safe

    with tempfile.TemporaryDirectory() as directory:
        excel = Path(directory) / "sensitive.xlsx"
        make_xlsx(excel)
        import openpyxl
        workbook = openpyxl.load_workbook(excel, read_only=True, data_only=True)
        sheet = workbook.active
        report = scan_xlsx_sheet_safe(sheet, sheet.title)
        workbook.close()
        # openpyxl 3.2.0b1 read_only 句柄跟随对象生命周期，显式释放后再清理临时目录。
        del workbook, sheet
        gc.collect()
    prompt = report["user_prompt"]
    message = prompt["message"]
    assert "Specification / 第 2 行" in message
    assert "受试者编号" in message
    assert "[SUBJ]" in message
    assert len(prompt["options"]) == 3


def test_l3_approval_allows_once_and_writes_authz():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        excel = root / "sensitive.xlsx"
        authz = root / "authz"
        make_xlsx(excel)
        decision = run("sensitive-allowed", excel=excel, authz=authz)
        assert decision["kind"] == "allow"
        # pre-execute 的 Excel L3 预检与出域 L3 是两条不同的授权路径；
        # 前者只放行本次本地读取，不把授权持久化为未来模型出域能力。


def test_missing_python_worker_fails_closed():
    decision = run("fail-closed", python="definitely-missing-python-7f3c")
    assert decision["kind"] == "deny"
    assert "不可用" in decision["reason"]


def test_fetch_database_result_without_path_is_scrubbed():
    """TC-20 / BY-13（真）：非 read 工具名 + 无路径 + 合成受试者标记被替换。"""
    decision = run("fetch-database")
    blob = json.dumps(decision, ensure_ascii=False)
    assert decision["kind"] == "accept"
    assert "A1234567" not in blob and "2024-03-05" not in blob


def test_unknown_extension_result_is_scrubbed():
    """BR-03.4：带路径但扩展名未识别（.xpt）的结果强制脱敏。"""
    decision = run("post-unknown-ext")
    blob = json.dumps(decision, ensure_ascii=False)
    assert decision["kind"] == "accept"
    assert "A1234567" not in blob and "2024-03-05" not in blob


def test_post_sensitive_without_approval_channel_fail_closed():
    """TC-26：整表转储（唯一 L3 硬红线）无审批通道 → BLOCKED，三选项不进入模型上下文。"""
    decision = run("post-sensitive")
    blob = json.dumps(decision, ensure_ascii=False)
    assert decision["kind"] == "accept"
    assert decision["content"][0]["text"]
    assert "clinicalGuard" in decision["content"][0]["text"]
    assert "BLOCKED" in decision["content"][0]["text"]
    assert "101-000" not in blob
    assert "跳过" not in blob and "脱敏后继续" not in blob


def test_post_sensitive_user_choices_write_matching_category():
    """TC-27：授权类别与用户选择一致（载荷为整表转储硬红线）。"""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        authz = root / "authz-redacted"
        decision = run("post-sensitive-redacted", authz=authz)
        blob = json.dumps(decision, ensure_ascii=False)
        # 脱敏后继续：数据值已 token 化，原值不进模型上下文。
        assert "101-000" not in blob and "2024-03-05" not in blob
        assert "[SUBJ:" in blob
        record = next(authz.rglob("egress_authz.json"))
        assert "L3_REDACTED_CONTINUE" in record.read_text(encoding="utf-8")

        authz2 = root / "authz-audited"
        decision2 = run("post-sensitive-audited", authz=authz2)
        # 允许并审计：当次放行原值并落 L3_ALLOW_AUDITED 授权。
        assert "101-000 | 2024-03-05 | Screening 已入组" in decision2["content"][0]["text"]
        record2 = next(authz2.rglob("egress_authz.json"))
        assert "L3_ALLOW_AUDITED" in record2.read_text(encoding="utf-8")


def test_l3_allow_audited_is_consumed_once():
    """TC-28：L3_ALLOW_AUDITED 仅当次有效——首个转储出域消费授权放行，第二次阻断。"""
    with tempfile.TemporaryDirectory() as directory:
        authz = Path(directory) / "authz"
        flow = run("l3-consume-flow", authz=authz)
        assert flow["grantedKind"] == "accept"
        assert flow["firstDirty"]["streamed"] is True
        assert flow["secondDirty"]["blocked"] is True


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
