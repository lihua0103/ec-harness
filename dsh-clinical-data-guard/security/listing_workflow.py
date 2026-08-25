"""本地临床 Listing 安全编排器。

模型只提交根内相对项目名与本地凭据引用。真实记录、密码、绝对路径和异常原文
均不会进入返回对象。三阶段（inspect → validate → execute）是唯一执行车道。
"""
from __future__ import annotations

import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from security.path_policy import (
    PathPolicyError,
    read_credential,
    relative_display_path,
    resolve_under_root,
    system_temp_root,
)
from security.listing_plan import ListingPlanError, validate_listing_plan
from security.listing_budget import charge_execution
from security.listing_inspector import inspect_listing_context
from security.listing_executor import ListingExecutionError, execute_listing_plan
from security.project_profile import ProjectProfile, load_project_profile


class ListingWorkflowError(ValueError):
    """对模型安全的工作流拒绝原因。

    message 是模型安全文案（不含路径/记录/凭据）；code 是结构化拒绝码，
    worker 原样回传（E-3），让 AI 能据此采取行动而不是收到一句无解的话。
    """

    def __init__(self, message: str, code: str = "LISTING_WORKFLOW_ERROR") -> None:
        super().__init__(message)
        self.code = code


def inspect_listing(
    *, local_data_root: str, project: str, scenario: str | None = None,
    credential_ref: str | None = None, credentials_dir: str | None = None,
) -> dict[str, Any]:
    """只发现需求和数据结构，不读取真实记录。"""
    try:
        credential = None
        if credential_ref:
            if not credentials_dir:
                raise ListingWorkflowError(
                    "credentials directory is not configured", code="CREDENTIALS_DIR_NOT_CONFIGURED")
            try:
                credential = read_credential(credentials_dir, credential_ref)
            except PathPolicyError as exc:
                raise ListingWorkflowError(
                    "credential reference is invalid", code="CREDENTIAL_REF_INVALID") from exc
        return inspect_listing_context(local_data_root, project, scenario, credential)
    except ListingWorkflowError:
        # E-3: 具体拒绝（如凭据缺失）不得被下面的通用包装抹平。
        raise
    except Exception as exc:
        # 保留原始错误信息，不要通用包装抹平
        original_msg = str(exc)
        error_type = type(exc).__name__
        raise ListingWorkflowError(
            f"listing inspection failed: {error_type}: {original_msg}",
            code="LISTING_INSPECTION_FAILED") from exc


def _schema_from_inspection(inspection: dict[str, Any]) -> dict[str, set[str]]:
    return {
        str(dataset).casefold(): {str(column) for column in columns}
        for dataset, columns in (inspection.get("schema") or {}).items()
    }


def _requirement_text(inspection: dict[str, Any]) -> str:
    """F-11: medical 来源确认规则的判据文本。

    只取非 ALS spec 的需求正文（与旧生成器 _require_medical_rule_provenance
    同口径）；ALS 是字段目录，不承载"要标识 New/Modified"这类规则语句。
    """
    return "\n".join(
        str(cell)
        for document in inspection.get("documents", [])
        if document.get("kind") != "als"
        for requirement in (document.get("content") or {}).get("requirements", [])
        for cell in requirement.get("cells", [])
    )


def validate_listing_submission(
    *, local_data_root: str, project: str, scenario: str, plan: Any,
    credential_ref: str | None = None, credentials_dir: str | None = None,
) -> dict[str, Any]:
    credential = None
    if credential_ref:
        if not credentials_dir:
            raise ListingWorkflowError(
                "credentials directory is not configured", code="CREDENTIALS_DIR_NOT_CONFIGURED")
        try:
            credential = read_credential(credentials_dir, credential_ref)
        except PathPolicyError as exc:
            raise ListingWorkflowError(
                "credential reference is invalid", code="CREDENTIAL_REF_INVALID") from exc
    try:
        inspection = inspect_listing_context(local_data_root, project, scenario, credential)
    except Exception as exc:
        raise ListingWorkflowError(
            "listing inspection failed", code="LISTING_INSPECTION_FAILED") from exc
    try:
        project_path = resolve_under_root(local_data_root, project, allow_root=True)
        profile = load_project_profile(project_path)
    except PathPolicyError:
        profile = ProjectProfile()
    try:
        normalized = validate_listing_plan(
            plan, _schema_from_inspection(inspection), scenario,
            requirement_text=_requirement_text(inspection),
            review_columns=dict(profile.review_columns),
            reserved_sheet_name=profile.contents_sheet_name,
        )
    except ListingPlanError as exc:
        return {
            "clinicalGuard": "CLINICAL_LISTING_PLAN_RECEIPT",
            "status": "invalid",
            "stage": "validate",
            "project": project,
            "scenario": scenario,
            "code": exc.code,
            "path": exc.path,
            "message": str(exc),
            "schemaFingerprint": inspection.get("schemaFingerprint", ""),
            "dataClass": "METADATA_ONLY",
        }
    return {
        "clinicalGuard": "CLINICAL_LISTING_PLAN_RECEIPT",
        "status": "validated",
        "stage": "validate",
        "project": project,
        "scenario": scenario,
        "outputCount": len(normalized["outputs"]),
        "schemaFingerprint": inspection.get("schemaFingerprint", ""),
        "plan": normalized,
        "dataClass": "METADATA_ONLY",
    }


def _sweep_stale_transient(project_path: Path, output_name: str) -> None:
    """E-4（2026-08-22 e2e 审计）：执行前回收历史运行遗留的临时目录。

    超时/崩溃的旧执行会把 `.{scenario}-tmp-*`、`.{scenario}-backup-*`（旧
    生成器与两步改名发布）残留在 output 下；staging 残留则来自被杀死的
    worker。残留会污染后续产物可见性（模型曾把 37 个临时件误读为"产出不
    完整"的证据）。worker 串行处理请求且本次 staging 用新 uuid，启动时
    统一清扫不会误删进行中的运行。
    """
    output_root = project_path / output_name
    for stale in [*output_root.glob(".*-tmp-*"), *output_root.glob(".*-backup-*")]:
        if stale.is_dir():
            shutil.rmtree(stale, ignore_errors=True)
    staging_root = project_path / ".clinical-listing" / "staging"
    if staging_root.is_dir():
        shutil.rmtree(staging_root, ignore_errors=True)


def execute_listing_plan_workflow(
    *, local_data_root: str, project: str, scenario: str, plan: Any,
    output_name: str = ".clinical-listing/output",
    output_plane_root: str | None = None,
    credential_ref: str | None = None, credentials_dir: str | None = None,
    session_id: str = "unknown-session",
) -> dict[str, Any]:
    validation = validate_listing_submission(
        local_data_root=local_data_root, project=project, scenario=scenario, plan=plan,
        credential_ref=credential_ref, credentials_dir=credentials_dir,
    )
    if validation["status"] != "validated":
        return validation
    charge_execution(
        session_id=session_id, project=project, scenario=scenario,
        plan=validation["plan"],
    )
    try:
        project_path = resolve_under_root(local_data_root, project, allow_root=True)
        publish_root = project_path
        if output_plane_root:
            # 产物域按项目懒创建；根目录已在配置校验阶段确认存在，项目子目录
            # 不应被要求预先创建，否则只读数据域无法完成首次交付。
            publish_root = resolve_under_root(
                output_plane_root, project, must_exist=False, allow_root=True,
            )
            publish_root.mkdir(parents=True, exist_ok=True)
        _sweep_stale_transient(publish_root, output_name)
        # 执行态全部位于系统统一临时目录（.cache/tmp），避免超时/权限残留
        # 污染临床项目树；2026-08-24 起绝不写 C 盘用户临时区，且与产物域
        # 同卷（G:），两步改名发布不再触发跨盘复制回退。
        staging_parent = Path(tempfile.mkdtemp(prefix="emerald-listing-staging-", dir=system_temp_root()))
        staging = staging_parent / uuid.uuid4().hex
        staging.mkdir(parents=True, exist_ok=True)
        credential = None
        if credential_ref:
            credential = read_credential(credentials_dir or "", credential_ref)
        result = execute_listing_plan(str(project_path), str(staging), validation["plan"], credential)
        artifact_relatives = [
            Path(item["path"]).resolve(strict=True).relative_to(staging.resolve())
            for item in result.get("artifacts", [])
        ]
        output_dir = publish_root / output_name / scenario
        output_dir.parent.mkdir(parents=True, exist_ok=True)
        backup = output_dir.parent / f".{scenario}-backup-{uuid.uuid4().hex}"
        # F-7: 发布是两步改名（output→backup，staging→output）。若第二步失败而
        # 不回滚，旧产物会留在孤儿 backup 目录里、output 不存在——用户既拿不到
        # 新产物也丢了上一版。回滚把旧产物放回原位后再上抛。
        warnings: list[str] = []
        published = False
        try:
            if output_dir.exists():
                output_dir.rename(backup)
            try:
                staging.rename(output_dir)
            except OSError as exc:
                # Windows 临时目录通常位于系统盘，而受控产物域可能位于
                # 另一卷；跨卷 rename 不可用。复制到同卷目标后再继续发布，
                # 仍由下面的备份恢复路径处理失败。
                if getattr(exc, "winerror", None) != 17:
                    raise
                shutil.copytree(staging, output_dir)
            published = True
        except Exception:
            if backup.exists() and not output_dir.exists():
                backup.rename(output_dir)
            raise
        finally:
            if published and backup.exists():
                try:
                    shutil.rmtree(backup)
                except OSError:
                    # 备份清理失败不影响本次发布结果，降级为收据 warning。
                    warnings.append("a previous listing backup could not be removed")
        artifacts = []
        for item, relative in zip(result.get("artifacts", []), artifact_relatives):
            artifact_path = (output_dir / relative).resolve(strict=True)
            artifacts.append({
                "id": relative_display_path(publish_root, output_dir / relative),
                "name": artifact_path.name,
                "kind": "xlsx",
                "sheets": [{"name": item["name"][:128], "rowCount": int(item.get("rowCount", 0)), "columnCount": int(item.get("columnCount", 0))}],
            })
        return {
            "clinicalGuard": "CLINICAL_LISTING_RECEIPT",
            "status": "completed",
            "stage": "execute",
            "project": project,
            "scenario": scenario,
            "artifact": {key: artifacts[0][key] for key in ("id", "name", "kind")},
            "artifacts": artifacts,
            "schemaFingerprint": validation["schemaFingerprint"],
            "dataClass": "REAL",
            "warnings": warnings,
        }
    except (ListingExecutionError, OSError, ValueError) as exc:
        raise ListingWorkflowError(
            "listing execution failed", code="LISTING_EXECUTION_FAILED") from exc
    finally:
        if 'staging' in locals() and staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
