"""scan_init 数据面指纹核对（方案 §1.2/§5.2，2026-10-20 P0）。

同项目**换数据必须刷新**保护值索引：此前 scan_init 对同 project + 已有
哈希直接 ready，不查指纹，主车道重 inspect（换批次/补数据）后扫描进程
仍用旧数据的哈希集合——真实命中漏判（安全）与旧值误判（误拦）双向风险。
"""
import pytest

import worker


@pytest.fixture()
def scan_state(project):
    """首次预热建好索引；返回项目路径。"""
    result = worker.operation_scan_init({"project": str(project), "hostDataInterception": True})
    assert result["ok"] is True, result
    return project


def test_first_init_binds_fingerprint(scan_state):
    assert worker._session_project is not None
    assert worker._session_scan_fingerprint is not None
    assert worker._session_protected_hashes


def test_unchanged_project_short_circuits_without_rebuild(scan_state, monkeypatch):
    fingerprint_before = worker._session_scan_fingerprint
    calls: list[int] = []
    original = worker.protected_value_hashes

    def counting(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(worker, "protected_value_hashes", counting)
    result = worker.operation_scan_init({"project": str(scan_state), "hostDataInterception": True})
    assert result["ok"] is True
    assert calls == [], "指纹未变时不得重建索引"
    assert worker._session_scan_fingerprint == fingerprint_before


def test_data_change_forces_index_rebuild(scan_state, monkeypatch):
    fingerprint_before = worker._session_scan_fingerprint
    # 数据面变化：新增一个带新受保护值的数据文件（相对路径/大小/mtime 全变）。
    (scan_state / "LB.csv").write_text(
        "USUBJID,LBTEST\nNEW-SUBJ-900,HAEMOGLOBIN\n", encoding="utf-8")
    calls: list[int] = []
    original = worker.protected_value_hashes

    def counting(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(worker, "protected_value_hashes", counting)
    result = worker.operation_scan_init({"project": str(scan_state), "hostDataInterception": True})
    assert result["ok"] is True
    assert calls, "数据面变化后必须重建保护值索引"
    assert worker._session_scan_fingerprint != fingerprint_before
    # 新数据值进入保护索引：同值出现在普通文本中会被识别（索引确实是新的）。
    assert worker.text_contains_protected_value(
        "sample NEW-SUBJ-900 here", worker._session_protected_hashes) is True
