"""快照绑定与发布版本防护（方案 §5.2/§7.4，T04/T11）。

回归面：run_code/publish 回执携带 snapshotId；会话建立后数据面变化
（换批次/补数据）时 run_code 拒绝执行（SNAPSHOT_STALE）；旧快照产物
不得隐式 publish。
"""
import pytest

import worker

RUN_CODE = {"project": None, "hostDataInterception": True,
            "code": "outputs = {'T': datasets['AE'].copy()}"}


def _run_code(project) -> dict:
    request = dict(RUN_CODE, project=str(project))
    return worker.operation_run_code(request)


def test_run_and_publish_bind_snapshot(project):
    result = _run_code(project)
    assert result["ok"] is True, result
    snapshot_id = result["receipt"]["snapshotId"]
    assert snapshot_id == worker._session_snapshot_id
    assert worker._last_outputs_snapshot == snapshot_id
    published = worker.operation_publish(
        {"project": str(project), "scenario": "manual", "hostDataInterception": True})
    assert published["ok"] is True, published
    assert published["receipt"]["snapshotId"] == snapshot_id


def test_data_change_does_not_invalidate_session_snapshot(project):
    """快照语义（方案 §5.2）：inspect 全量入会话后，run_code 只消费会话内存；
    磁盘文件事后变化不作废当前快照（重 inspect 才换快照）。"""
    assert _run_code(project)["ok"] is True
    (project / "LB.csv").write_text("USUBJID,LBTEST\nNEW-SUBJ-900,HB\n", encoding="utf-8")
    again = _run_code(project)
    assert again["ok"] is True, again
    assert again["receipt"]["snapshotId"] == worker._session_snapshot_id
    # 数据更新经重 inspect 全量重载后旧产物不可隐式发布（见下一条）。


def test_publish_refuses_outputs_from_old_snapshot(project):
    assert _run_code(project)["ok"] is True
    # 模拟重 inspect 后新快照（旧产物仍挂在 _last_outputs 上）
    worker._session_snapshot_id = "new-snapshot-after-reload"
    refused = worker.operation_publish(
        {"project": str(project), "scenario": "manual", "hostDataInterception": True})
    assert refused["ok"] is False
    assert refused["code"] == "SNAPSHOT_STALE"


def test_decode_runner_outputs_strict_contract():
    frame = {"name": "T", "columns": ["A"], "records": [[1]], "attrs": {}}
    # 重复列名 → 显式拒绝（此前静默去重改形，统计取列会炸）
    with pytest.raises(ValueError):
        worker.decode_runner_outputs([dict(frame, columns=["A", "A"], records=[[1, 2]])])
    # 未登记 attrs 键（模型可伪造任意 attrs）→ 拒绝
    with pytest.raises(ValueError):
        worker.decode_runner_outputs([dict(frame, attrs={"evil_source": "x"})])
    # 登记白名单内的 attrs 正常通过
    decoded = worker.decode_runner_outputs([dict(frame, attrs={"labels": {"A": "标签"}})])
    assert list(decoded) == ["T"]
    # 总单元格资源上限（防 OOM）仍生效
    with pytest.raises(ValueError):
        worker.decode_runner_outputs([
            dict(frame, records=[[1]] * (worker.MAX_RUNNER_TOTAL_CELLS + 1))])


def test_sheet_count_is_not_capped():
    """工作表数量由需求决定：100+ 张表是正常交付，护栏不得设业务上限。

    2026-10-20 实案：曾加 50 帧上限，真实 Manual Listing 需 51 张表，
    模型被迫反复试探 50/51/52 边界（纯无效调用）。
    """
    frames = [{"name": f"LISTING_{index:03d}", "columns": ["A"], "records": [[index]], "attrs": {}}
              for index in range(150)]
    decoded = worker.decode_runner_outputs(frames)
    assert len(decoded) == 150


def test_large_single_sheet_is_not_capped():
    """单表行数也不设业务上限（只受总单元格资源兜底）。"""
    rows = 250_000
    decoded = worker.decode_runner_outputs([
        {"name": "BIG", "columns": ["A"], "records": [[index] for index in range(rows)], "attrs": {}}])
    assert len(decoded["BIG"]) == rows
