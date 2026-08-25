"""AI 代码车道的工作流编排（run → iterate → publish）。

三步循环替代 IR 车道的三阶段合同：
- ``run_listing_code``：模型提交 pandas 代码，本地沙箱执行，只回聚合元数据信封
  （行数 / 列名 / dtype / 空值计数；字符串字段全部 scrub）。
- 模型据信封迭代代码（与 inspect 的 schema 对照）。
- ``publish_listing_code``：重放**最近一次成功**的代码，由固定 Writer 在 staging
  产出 Excel，两步改名发布（沿用 F-7 回滚语义），artifact 元数据回执。

安全不变量：
- 红线：SAS 行级数据与 doc/ 外真实数据文件绝不进模型。信封只有聚合元数据。
- 每次触碰真实记录前先记账（run 预算与 publish 预算分别限频 + 审计）。
- 模型看到的错误文案经 sanitize_error 固定占位脱敏。
"""
from __future__ import annotations

import ast
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from security.code_sandbox import SandboxViolation, check_code, run_sandbox
from security.egress_checkpoint import _sign_clinical_guard
from security.listing_budget import charge_code_run, charge_execution
from security.listing_data_catalog import DatasetCatalog
from security.listing_inspector import inspect_listing_context
from security.listing_workflow import (
    ListingWorkflowError,
    _sweep_stale_transient,
)
from security.path_policy import read_credential, resolve_under_root, system_temp_root
from security.project_profile import load_project_profile

DEFAULT_RUN_TIMEOUT_SECONDS = 300.0
DEFAULT_PUBLISH_TIMEOUT_SECONDS = 600.0
OUTPUT_NAME = ".clinical-listing/output"

# (session, project, scenario) → 最近一次成功 run 的重放材料。
_LAST_RUNS: dict[tuple[str, str, str], dict[str, Any]] = {}
# inspect 结果缓存：同一 worker 生命周期内项目规格静态，避免迭代期反复解析。
_INSPECTION_CACHE: dict[tuple[str, str], dict[str, Any]] = {}


def _scrub(value: Any, limit: int | None = None) -> str:
    """信封字符串通道的唯一出口：固定占位脱敏，不生成可关联 token。"""
    text = str(value)
    if limit is not None:
        text = text[:limit]
    try:
        return sanitize_error(text, limit=limit or 500)
    except Exception:
        return ""


def _read_credential_or_fail(
    credential_ref: str | None, credentials_dir: str | None,
) -> bytes | str | None:
    if not credential_ref:
        return None
    if not credentials_dir:
        raise ListingWorkflowError(
            "credentials directory is not configured", code="CREDENTIALS_DIR_NOT_CONFIGURED")
    from security.path_policy import PathPolicyError

    try:
        return read_credential(credentials_dir, credential_ref)
    except PathPolicyError as exc:
        raise ListingWorkflowError(
            "credential reference is invalid", code="CREDENTIAL_REF_INVALID") from exc


def _inspect_cached(
    local_data_root: str, project: str, scenario: str | None, credential: Any,
) -> dict[str, Any]:
    key = (str(local_data_root), str(project))
    cached = _INSPECTION_CACHE.get(key)
    if cached is not None:
        return cached
    try:
        inspection = inspect_listing_context(local_data_root, project, scenario, credential)
    except Exception as exc:
        raise ListingWorkflowError(
            "listing inspection failed", code="LISTING_INSPECTION_FAILED") from exc
    _INSPECTION_CACHE[key] = inspection
    return inspection


def _referenced_datasets(tree: ast.Module, available: set[str]) -> set[str]:
    """静态提取代码引用的数据集名（Name 与字符串常量），与目录名交集。

    用于最小化归档解压；漏提只导致运行期 "dataset not available"，
    错误文案会列出可用数据集，模型可据此修正后重跑。
    """
    names: set[str] = set()
    for node in ast.walk(tree):
        # 2026-08-25（H301 440 页事件根因）：动态取数对静态提取不可见——
        # set("ae aeyn ...".split()) 是单个长字符串常量，运行期拆出的成员名
        # 一个都提取不到，include_datasets 据此只解压子集，迭代式代码静默
        # 遍历部分注册表产出错误聚合。凡经 datasets 动态下标或 .get()/.keys()
        # 取数，保守全量物化；字面量下标 datasets["ae"] 仍走最小化解压。
        if isinstance(node, ast.Subscript) \
                and isinstance(node.value, ast.Name) and node.value.id == "datasets" \
                and not isinstance(node.slice, ast.Constant):
            return available
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "datasets":
            return available
        if isinstance(node, ast.Name):
            names.add(node.id.casefold())
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            names.add(node.value.casefold())
    return available & names


def _sandbox_files(
    project_path: Path, credential: Any, required: set[str],
) -> tuple["DatasetCatalog", dict[str, str]]:
    """打开目录并返回 (catalog, {dataset: path})；歧义名剔除，交给运行期报错。

    2026-08-24 P0 修复：此前在 ``with`` 块内收集路径后立即关闭 catalog，
    归档解压出的数据集随 close() 的 rmtree 一并删除，沙盒子进程拿到的
    是悬空路径——归档型项目（真实 RT01 zip）在代码车道 100% 失败，
    报 "a local dataset could not be read" 且无法定位。调用方必须持有
    catalog 直到 run_sandbox 返回后再关闭，保证路径在子进程读取期间
    始终有效（项目内明文文件不受影响，归档解压文件依赖 catalog 生存）。
    """
    catalog = DatasetCatalog(project_path, credential, required_datasets=required)
    catalog.__enter__()
    files = {
        name: str(paths[0])
        for name, paths in catalog.files().items()
        if len(paths) == 1
    }
    return catalog, files


def _allowed_data_dirs(project_path: Path, catalog: DatasetCatalog) -> list[str]:
    """数据集合法所在目录：只需项目目录本身。

    2026-08-24 P0 修复（RBQM run_code 回归）：解压工作区已固化在项目内 _work
    子目录（listing_data_catalog.py __enter__），解压路径天然在项目目录下，
    无需额外并入白名单。方案比原系统临时区更简洁，且符合项目数据归属原则。
    """
    return [str(project_path)]


def _available_dataset_names(project_path: Path, credential: Any) -> set[str]:
    """central-directory 级索引（不解压）取得全部可用数据集名。"""
    with DatasetCatalog(project_path, credential, materialize_archives=False) as catalog:
        return set(catalog.files()) | set(catalog.archive_datasets())


def _charge_or_receipt(
    *, session_id: str, project: str, scenario: str, code: str,
) -> dict[str, Any] | None:
    """run 预算仅记账和告警，不阻断本地迭代。"""
    charge_code_run(
        session_id=session_id, project=project, scenario=scenario, code=code)
    return None


def run_listing_code(
    *, local_data_root: str, project: str, scenario: str | None = None,
    code: Any = None, credential_ref: str | None = None,
    credentials_dir: str | None = None, session_id: str = "unknown-session",
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """执行模型代码并返回元数据信封；成功则登记为可 publish 状态。"""
    if not isinstance(code, str) or not code.strip():
        raise ListingWorkflowError(
            "code is required", code="SANDBOX_CODE_REJECTED")
    try:
        tree = check_code(code)
    except SandboxViolation as exc:
        return {
            "clinicalGuard": "CLINICAL_LISTING_CODE_RECEIPT",
            "status": "rejected",
            "stage": "run",
            "project": project,
            "scenario": scenario,
            "code": exc.code,
            "message": str(exc),
            "dataClass": "METADATA_ONLY",
        }
    credential = _read_credential_or_fail(credential_ref, credentials_dir)
    inspection = _inspect_cached(local_data_root, project, scenario, credential)
    resolved_scenario = str(inspection.get("scenario") or scenario or "")
    if not resolved_scenario:
        raise ListingWorkflowError(
            "listing scenario could not be resolved", code="SCENARIO_UNKNOWN")
    rejected = _charge_or_receipt(
        session_id=session_id, project=project, scenario=resolved_scenario, code=code)
    if rejected is not None:
        return rejected
    try:
        project_path = resolve_under_root(local_data_root, project, allow_root=True)
    except Exception as exc:
        raise ListingWorkflowError(
            "project must be a relative path under the local root",
            code="PROJECT_PATH_INVALID") from exc
    # P0-FIX (RBQM run_code): 防御校验。即使 resolve_under_root 未抛异常，
    # project_path 为空或纯空白也会让 run_sandbox 传 [""] 到沙箱，导致
    # _ALLOWED_DATA_DIRS 解析成当前工作目录（包根），既越权又掩盖故障。
    if not str(project_path).strip():
        raise ListingWorkflowError(
            "project path resolved to empty", code="PROJECT_PATH_INVALID")
    available = _available_dataset_names(project_path, credential)
    required = _referenced_datasets(tree, available)
    try:
        catalog, files = _sandbox_files(project_path, credential, required)
    except Exception as exc:
        raise ListingWorkflowError(
            "local datasets could not be prepared", code="DATASET_PREPARE_FAILED") from exc
    try:
        envelope = run_sandbox(
            code=code, files=files, mode="run",
            timeout_seconds=timeout_seconds or DEFAULT_RUN_TIMEOUT_SECONDS,
            allowed_data_dirs=_allowed_data_dirs(project_path, catalog),
        )
    finally:
        catalog.close()
    marker = "CLINICAL_LISTING_CODE_RECEIPT"
    receipt: dict[str, Any] = {
        "clinicalGuard": marker,
        "stage": "run",
        "project": project,
        "scenario": resolved_scenario,
        "schemaFingerprint": inspection.get("schemaFingerprint", ""),
        "dataClass": "METADATA_ONLY",
    }
    signature_fields = {
        "listingId": f"{project}:{resolved_scenario}",
        "schemaFingerprint": receipt["schemaFingerprint"],
        "stage": "run",
        "dataClass": "METADATA_ONLY",
    }
    sig = _sign_clinical_guard(marker, signature_fields)
    if sig:
        receipt["signature"] = sig
    if envelope.get("status") == "ok":
        outputs = []
        for item in envelope.get("outputs", []):
            outputs.append({
                "name": _scrub(item.get("name")),
                "rowCount": int(item.get("rowCount") or 0),
                "columnCount": int(item.get("columnCount") or 0),
                "columns": [
                    {
                        "name": _scrub(column.get("name")),
                        "dtype": str(column.get("dtype"))[:32],
                        "nullCount": int(column.get("nullCount") or 0),
                    }
                    for column in item.get("columns", [])
                ],
            })
        receipt.update({
            "status": "ok",
            "outputs": outputs,
            "datasetsTouched": [_scrub(name) for name in envelope.get("datasetsTouched", [])],
        })
        _LAST_RUNS[(session_id, project, resolved_scenario)] = {
            "code": code,
            "required": sorted(required),
            "outputs": [item["name"] for item in outputs],
        }
    elif envelope.get("status") == "rejected":
        error = envelope.get("error") or {}
        receipt.update({
            "status": "rejected",
            "code": "SANDBOX_CODE_REJECTED",
            "message": _scrub(error.get("message")),
        })
    else:
        error = envelope.get("error") or {}
        receipt.update({
            "status": "error",
            "errorType": str(error.get("type") or "SandboxError"),
            "message": _scrub(error.get("message")),
        })
    return receipt


def _move_with_lock_retry(source: Path, target: Path) -> None:
    """发布落盘的 Windows 锁容忍：replace → 短重试 → copy2 兜底。

    2026-08-24：目标产物常被杀毒/索引/浏览中的 Excel/元数据提取器短暂加锁，
    单次 os.replace 撞锁即让整次 publish 以 "listing publish failed" 失败
    （真实会话连续复现）。覆盖写入先 replace；PermissionError 做 2.5s 内
    指数退避重试；仍失败退回 copy+unlink（同样带重试）。持续锁定才上抛。
    """
    import time

    def _retry(action) -> None:
        delays = (0.1, 0.3, 0.7, 1.4)
        for attempt, delay in enumerate(delays):
            try:
                action()
                return
            except PermissionError:
                if attempt == len(delays) - 1:
                    raise
                time.sleep(delay)

    try:
        _retry(lambda: os.replace(source, target))
        return
    except PermissionError:
        pass
    except OSError:
        pass
    _retry(lambda: shutil.copy2(source, target))
    _retry(lambda: source.unlink())


def publish_listing_code(
    *, local_data_root: str, project: str, scenario: str | None = None,
    credential_ref: str | None = None, credentials_dir: str | None = None,
    session_id: str = "unknown-session", output_plane_root: str | None = None,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    """重放最近一次成功代码并发布 Excel 交付物（固定 Writer + 两步改名）。"""
    credential = _read_credential_or_fail(credential_ref, credentials_dir)
    inspection = _inspect_cached(local_data_root, project, scenario, credential)
    resolved_scenario = str(inspection.get("scenario") or scenario or "")
    key = (session_id, project, resolved_scenario)
    stored = _LAST_RUNS.get(key)
    if stored is None:
        return {
            "clinicalGuard": "CLINICAL_LISTING_RECEIPT",
            "status": "rejected",
            "stage": "publish",
            "project": project,
            "scenario": resolved_scenario,
            "code": "NO_SUCCESSFUL_RUN",
            "message": "run the transformation code successfully before publishing",
            "dataClass": "METADATA_ONLY",
        }
    charge_execution(
        session_id=session_id, project=project, scenario=resolved_scenario,
        plan={"outputs": [{"name": name} for name in stored["outputs"]]},
    )
    # 执行态固定在系统统一临时目录（.cache/tmp），与产物域同卷，绝不写 C 盘。
    staging_parent = Path(tempfile.mkdtemp(prefix="emerald-listing-staging-", dir=system_temp_root()))
    staging = staging_parent / uuid.uuid4().hex
    try:
        project_path = resolve_under_root(local_data_root, project, allow_root=True)
        # P0-FIX (RBQM run_code): 同 run_listing_code，空路径必须在传入沙箱前拦截。
        if not str(project_path).strip():
            raise ListingWorkflowError(
                "project path resolved to empty", code="PROJECT_PATH_INVALID")
        profile = load_project_profile(project_path)
        review_columns = (
            list(profile.review_columns)
            if resolved_scenario in {"medical", "rbqm"} else []
        )
        catalog, files = _sandbox_files(project_path, credential, set(stored["required"]))
        try:
            envelope = run_sandbox(
                code=stored["code"], files=files, mode="publish",
                timeout_seconds=timeout_seconds or DEFAULT_PUBLISH_TIMEOUT_SECONDS,
                staging=str(staging), review_columns=review_columns,
                contents_sheet_name=profile.contents_sheet_name,
                scenario=resolved_scenario,
                allowed_data_dirs=_allowed_data_dirs(project_path, catalog),
            )
        finally:
            catalog.close()
        if envelope.get("status") != "ok":
            error = envelope.get("error") or {}
            raise ListingWorkflowError(
                f"listing publish failed ({str(error.get('type'))[:48]})",
                code="LISTING_PUBLISH_FAILED")
        publish_root = project_path
        if output_plane_root:
            publish_root = resolve_under_root(
                output_plane_root, project, must_exist=False, allow_root=True)
            publish_root.mkdir(parents=True, exist_ok=True)
        _sweep_stale_transient(publish_root, OUTPUT_NAME)
        output_dir = publish_root / OUTPUT_NAME / resolved_scenario
        output_dir.mkdir(parents=True, exist_ok=True)
        artifacts = []
        for item in envelope.get("artifacts", []):
            source = staging / str(item.get("file"))
            target = output_dir / source.name
            _move_with_lock_retry(source, target)
            artifacts.append({
                "name": target.name,
                "kind": "xlsx",
                "sheets": item.get("sheets", []),
            })
        if not artifacts:
            raise ListingWorkflowError(
                "listing publish produced no artifacts", code="LISTING_PUBLISH_FAILED")
        first = artifacts[0]
        marker = "CLINICAL_LISTING_RECEIPT"
        receipt = {
            "clinicalGuard": marker,
            "status": "completed",
            "stage": "publish",
            "project": project,
            "scenario": resolved_scenario,
            "artifact": {"id": f"{OUTPUT_NAME}/{resolved_scenario}", "name": first["name"], "kind": "xlsx"},
            "artifacts": artifacts,
            "schemaFingerprint": inspection.get("schemaFingerprint", ""),
            "dataClass": "REAL",
        }
        sig = _sign_clinical_guard(marker, {
            "listingId": f"{project}:{resolved_scenario}",
            "schemaFingerprint": receipt["schemaFingerprint"],
            "stage": "publish",
            "dataClass": "REAL",
        })
        if sig:
            receipt["signature"] = sig
        return receipt
    except ListingWorkflowError:
        raise
    except (OSError, ValueError) as exc:
        # 2026-08-24：错误文案带异常类型名（不含路径/数据值），否则
        # "listing publish failed" 无法区分锁冲突/权限/路径问题，模型只能盲试。
        raise ListingWorkflowError(
            f"listing publish failed ({type(exc).__name__})",
            code="LISTING_PUBLISH_FAILED") from exc
    finally:
        shutil.rmtree(staging_parent, ignore_errors=True)


def reset_code_lane_state() -> None:
    """仅供测试：清空 run 状态与 inspect 缓存。"""
    _LAST_RUNS.clear()
    _INSPECTION_CACHE.clear()
