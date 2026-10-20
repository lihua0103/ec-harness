"""pytest 公共配置：把 python/ 放进 sys.path，隔离 worker 会话状态。"""
import sys
from pathlib import Path

import pytest

PYTHON_DIR = Path(__file__).resolve().parent.parent
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))


@pytest.fixture(autouse=True)
def isolated_edc_profiles(tmp_path, monkeypatch):
    """学习型 EDC 注册表指向测试专用临时文件，绝不写入真实注册表。"""
    monkeypatch.setenv("DSH_EDC_PROFILES", str(tmp_path / "edc-profiles.json"))


@pytest.fixture(autouse=True)
def isolated_worker_session():
    """每个测试独占会话状态，避免跨测试串扰。

    指纹字段必须一并保存/恢复（2026-10-20 审计补全）：此前
    _session_data_fingerprint 漏恢复、新增的 _session_scan_fingerprint
    若漏恢复都会让"同项目换数据必须刷新"的回归在不同测试顺序下假绿。"""
    import worker
    saved = (worker._session_project, worker._session_datasets, worker._session_sources,
             worker._session_documents, worker._session_auxiliary_documents,
             worker._session_document_chunks_read, worker._last_outputs,
             worker._session_failures, worker._session_protected_hashes,
             worker._session_doc_baseline, worker._session_doc_baseline_project,
             worker._session_data_fingerprint, worker._session_scan_fingerprint,
             worker._session_snapshot_id, worker._last_outputs_snapshot)
    worker._reset_session()
    yield
    (worker._session_project, worker._session_datasets, worker._session_sources,
     worker._session_documents, worker._session_auxiliary_documents,
     worker._session_document_chunks_read, worker._last_outputs,
     worker._session_failures, worker._session_protected_hashes,
     worker._session_doc_baseline, worker._session_doc_baseline_project,
     worker._session_data_fingerprint, worker._session_scan_fingerprint,
     worker._session_snapshot_id, worker._last_outputs_snapshot) = saved


@pytest.fixture()
def project(tmp_path):
    """带一个 AE.csv 与 doc/spec.txt 的最小项目。"""
    (tmp_path / "doc").mkdir()
    (tmp_path / "doc" / "spec.txt").write_text("需求文档\n" + "X" * 400 + "\nREQUIREMENT-TAIL", encoding="utf-8")
    (tmp_path / "AE.csv").write_text("USUBJID,AETERM\nSUBJ-777,Headache\nSUBJ-888,Nausea\n", encoding="utf-8")
    return tmp_path
