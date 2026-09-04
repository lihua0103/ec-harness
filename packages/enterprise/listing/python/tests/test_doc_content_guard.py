"""doc/ 防洗白回归（ADR-0010 修订决策 10，2026-09-03）。

口径：项目原始 doc 输入直接信任（即使内容与数据集值相同也不拦，需求域
全量可读）；会话建立后新增/被改写的 doc 文件在出域前做保护值精确匹配，
命中即拒绝。
"""
import json

import worker


def _dispatch(request: dict) -> dict:
    return worker.dispatch({**request, "hostDataInterception": True})


def _read_manifest(response: dict) -> dict[str, dict]:
    return {item["path"]: item for item in response["inspection"]["requirementDocuments"]}


def _read_all_chunks(project_path, manifest: dict) -> None:
    for item in manifest.values():
        for chunk_index in range(item["totalChunks"]):
            response = _dispatch({
                "operation": "listing_read_document",
                "project": str(project_path),
                "documentId": item["documentId"],
                "chunkIndex": chunk_index,
            })
            assert response["ok"] is True, response


def test_original_doc_with_dataset_values_is_trusted(project, capsys):
    """原始 doc 输入即使包含数据集同值也全量可读——需求域语义不变。"""
    (project / "doc" / "spec.txt").write_text("SUBJ-777 出现在需求描述中\n", encoding="utf-8")
    capsys.readouterr()
    inspect = _dispatch({"operation": "listing_inspect", "project": str(project)})
    assert inspect["ok"] is True
    manifest = _read_manifest(inspect)
    assert "spec.txt" in manifest
    _read_all_chunks(project, manifest)
    chunk = _dispatch({
        "operation": "listing_read_document",
        "project": str(project),
        "documentId": manifest["spec.txt"]["documentId"],
        "chunkIndex": 0,
    })
    assert chunk["ok"] is True
    assert "SUBJ-777" in chunk["document"]["content"]


def test_reinspect_drops_planted_doc_containing_dataset_values(project, capsys):
    """run_code 会话期间写进 doc/ 的数据值文件：re-inspect 剔除并记录 doc-guard。"""
    capsys.readouterr()
    inspect = _dispatch({"operation": "listing_inspect", "project": str(project)})
    assert inspect["ok"] is True
    (project / "doc" / "planted.md").write_text("-exported::\nSUBJ-777,Headache\n", encoding="utf-8")
    reinspect = _dispatch({"operation": "listing_inspect", "project": str(project)})
    assert reinspect["ok"] is True
    manifest = _read_manifest(reinspect)
    assert "planted.md" not in manifest
    codes = {item.get("code") for item in reinspect["inspection"]["failures"]}
    assert "PROTECTED_DOCUMENT_CONTENT" in codes


def test_swapped_doc_file_does_not_leak_without_reload(project, capsys):
    """会话建立后覆写 doc 文件：不重装载时分片来自内存快照（原始内容），
    磁盘上的数据值不进入上下文；重装载时由 doc-guard 剔除。"""
    capsys.readouterr()
    inspect = _dispatch({"operation": "listing_inspect", "project": str(project)})
    assert inspect["ok"] is True
    manifest = _read_manifest(inspect)
    document_id = manifest["spec.txt"]["documentId"]
    (project / "doc" / "spec.txt").write_text("SPECJ swap:\nSUBJ-777,Headache,USUBJID\n", encoding="utf-8")
    response = _dispatch({
        "operation": "listing_read_document",
        "project": str(project),
        "documentId": document_id,
        "chunkIndex": 0,
    })
    # 内存快照：返回的是装载时的原始需求文本，不含换入的数据值
    assert response["ok"] is True
    assert "SUBJ-777" not in response["document"]["content"]
    assert "REQUIREMENT-TAIL" in response["document"]["content"]


def test_swapped_doc_without_dataset_values_still_readable(project, capsys):
    """基线外文件改写但不含受保护值：放行并刷新基线（不干扰需求域）。"""
    capsys.readouterr()
    inspect = _dispatch({"operation": "listing_inspect", "project": str(project)})
    assert inspect["ok"] is True
    manifest = _read_manifest(inspect)
    document_id = manifest["spec.txt"]["documentId"]
    (project / "doc" / "spec.txt").write_text("部署方正常修订的需求文本，无数据值。\n", encoding="utf-8")
    response = _dispatch({
        "operation": "listing_read_document",
        "project": str(project),
        "documentId": document_id,
        "chunkIndex": 0,
    })
    assert response["ok"] is True
    followup = _dispatch({"operation": "listing_inspect", "project": str(project)})
    assert followup["ok"] is True
    assert "spec.txt" in _read_manifest(followup)


def test_cold_start_run_code_reports_dataset_failures(tmp_path, capsys):
    """run_code 冷启动时部分数据集失败：datasetFailureCount 不得静默清零。"""
    capsys.readouterr()
    (tmp_path / "doc").mkdir()
    (tmp_path / "AE.csv").write_text("USUBJID\nSUBJ-777\n", encoding="utf-8")
    (tmp_path / "BAD.xpt").write_bytes(b"HEADER_RECORD*******garbage***\x00\x01")  # 非 XPORT 头 → 读取失败
    response = _dispatch({
        "operation": "listing_run_code",
        "project": str(tmp_path),
        "code": "outputs = {'X': __import__('pandas').DataFrame({'a': [1]})}",
    })
    if response["ok"]:
        assert response["receipt"]["datasetFailureCount"] >= 1, json.dumps(response, ensure_ascii=False)
    else:
        # fail-closed 亦接受：失败清单必须如实上报而非清零
        assert response.get("failures"), response
