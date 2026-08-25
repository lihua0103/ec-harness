"""dataInterceptionEnabled 开关的最新验收合同。

关闭开关表示完全旁路：Harness 接管 AI 行为，worker 不得扫描、改写或
以数据访问能力、Listing 流程、AST、沙箱目录及路径策略进行拦截。
开启开关时，原有安全边界必须继续生效。

本文件只测试 worker 边界和安全组件的合同，不修改生产代码。
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

PYTHON_ROOT = Path(__file__).resolve().parents[2] / "python"
sys.path.insert(0, str(PYTHON_ROOT))

from security import worker
from security.code_sandbox import SandboxViolation, check_code
from security.path_policy import PathPolicyError, resolve_under_root
from security import listing_code_lane


CLINICAL_TEXT = "USUBJID A1234567 visit 2026-03-18"


def _request(operation: str, *, enabled: bool, **fields):
    return {
        "operation": operation,
        **fields,
        "context": {
            "dataInterceptionEnabled": enabled,
            # 关闭态故意不给 uat-local，验证门禁不会被旁路遗漏。
            "localDataAccess": "disabled",
            "localDataRoot": "path-that-must-not-be-read",
        },
    }


def test_disabled_llm_is_a_true_bypass_and_does_not_scan() -> None:
    payload = {"messages": [{"role": "user", "content": CLINICAL_TEXT}]}
    with patch.object(worker, "check_egress_v2", side_effect=AssertionError("egress scanned")):
        result = worker._handle(_request("check_llm", enabled=False, payload=payload))

    assert result == {"ok": True, "action": "allow", "payload": payload}


def test_disabled_scrub_text_is_a_true_bypass_and_does_not_rewrite() -> None:
    with patch("security.patterns.scan_text_context_aware", side_effect=AssertionError("text scanned")):
        result = worker._handle(_request("scrub_text", enabled=False, text=CLINICAL_TEXT))

    assert result == {"ok": True, "action": "allow", "text": CLINICAL_TEXT}


def test_disabled_local_data_access_bypasses_gate_but_keeps_metadata_operation() -> None:
    metadata = {"columns": ["USUBJID"], "rowCount": 1}
    with patch.object(worker, "inspect_local_data", return_value=metadata) as inspect:
        result = worker._handle(_request("inspect_local_data", enabled=False, path="outside.csv"))

    inspect.assert_called_once_with("path-that-must-not-be-read", "outside.csv")
    assert result == {"ok": True, "action": "local-metadata", "metadata": metadata}


@pytest.mark.parametrize(
    ("operation", "action", "function"),
    [
        ("listing_inspect", "listing-inspect", "inspect_listing"),
        ("listing_run_code", "listing-run-code", "run_listing_code"),
        ("listing_publish", "listing-publish", "publish_listing_code"),
    ],
)
def test_disabled_listing_operations_bypass_local_access_gate(
    operation: str, action: str, function: str,
) -> None:
    """关闭态的 inspect/run/publish 都必须交给 Harness 自主操作。"""
    receipt = {"status": "ok", "stage": operation}
    module_name = "security.listing_workflow" if operation == "listing_inspect" else "security.listing_code_lane"
    with patch(f"{module_name}.{function}", return_value=receipt) as listing_call:
        result = worker._handle(_request(
            operation,
            enabled=False,
            project="../outside-project",
            scenario="rbqm",
            code="import os; result = datasets['DM']",
        ))

    listing_call.assert_called_once()
    assert result["ok"] is True
    assert result["action"] == action
    assert result["inspection" if operation == "listing_inspect" else "receipt"] == receipt


def test_enabled_llm_still_blocks_clinical_data() -> None:
    result = worker._handle(_request(
        "check_llm", enabled=True,
        payload={"messages": [{"role": "tool", "content": CLINICAL_TEXT}]},
    ))

    assert result["ok"] is False
    assert result["code"] == "EGRESS_VIOLATION"


def test_enabled_local_data_access_still_requires_uat_local() -> None:
    with patch.object(worker, "inspect_local_data", side_effect=AssertionError("read attempted")):
        result = worker._handle(_request("inspect_local_data", enabled=True, path="source.csv"))

    assert result["ok"] is False
    assert result["code"] == "LOCAL_DATA_ACCESS_REQUIRED"


def test_enabled_listing_still_requires_uat_local() -> None:
    with patch("security.listing_workflow.inspect_listing", side_effect=AssertionError("workflow entered")):
        result = worker._handle(_request("listing_inspect", enabled=True, project="study"))

    assert result["ok"] is False
    assert result["code"] == "LOCAL_DATA_ACCESS_REQUIRED"


def test_enabled_ast_and_sandbox_boundaries_remain_enforced() -> None:
    with pytest.raises(SandboxViolation):
        check_code("import os")
    with pytest.raises(SandboxViolation):
        check_code("result = datasets['DM'].to_csv('outside.csv')")


def test_disabled_code_lane_does_not_run_ast_check_or_directory_restriction() -> None:
    """关闭态把代码执行控制权交给 Harness，不调用 AST/路径限制器。"""
    fake_inspection = {"scenario": "rbqm", "schemaFingerprint": "fp"}
    fake_catalog = Mock()
    fake_files = {"DM": "C:/outside/DM.xpt"}
    fake_envelope = {"status": "ok", "outputs": []}
    with (
        patch.object(listing_code_lane, "_inspect_cached", return_value=fake_inspection),
        patch.object(listing_code_lane, "_available_dataset_names", return_value={"DM"}),
        patch.object(listing_code_lane, "_sandbox_files", return_value=(fake_catalog, fake_files)),
        patch.object(listing_code_lane, "run_sandbox", return_value=fake_envelope) as sandbox,
        patch.object(listing_code_lane, "check_code", side_effect=AssertionError("AST checked")),
    ):
        result = listing_code_lane.run_listing_code(
            local_data_root="C:/root", project="../outside-project",
            scenario="rbqm", code="import os; result = datasets['DM']",
            data_interception_enabled=False,
        )

    sandbox.assert_called_once()
    assert sandbox.call_args.kwargs["interception_enabled"] is False
    assert sandbox.call_args.kwargs["allowed_data_dirs"] is None
    assert result["status"] == "ok"


def test_enabled_code_lane_still_rejects_ast_before_sandbox() -> None:
    result = listing_code_lane.run_listing_code(
        local_data_root="C:/root", project="study", scenario="rbqm",
        code="import os; result = datasets['DM']",
        data_interception_enabled=True,
    )

    assert result["status"] == "rejected"
    assert result["stage"] == "run"
    assert result["code"] == "SANDBOX_CODE_REJECTED"


def test_enabled_path_policy_rejects_absolute_and_escape_paths(tmp_path: Path) -> None:
    root = tmp_path / "clinical-root"
    root.mkdir()
    (root / "source.csv").write_text("USUBJID\nA1234567\n", encoding="utf-8")

    with pytest.raises(PathPolicyError, match="absolute"):
        resolve_under_root(root, root / "source.csv")
    with pytest.raises(PathPolicyError, match="outside"):
        resolve_under_root(root, "../source.csv", must_exist=False)
