"""真实项目冒烟测试：用本机真实交付项目跑通完整链路。

合成 fixture（openpyxl 自建 xlsx、自打包 zip）证明的是"代码符合开发者
想象"；TAISHAN-304 实测暴露的一串缺陷（ZipCrypto 错误密码碰巧过校验后
CRC 抛 pyzipper BadZipFile、HTML 冒名 .xls、超短单元格值误拦）全部只
在真实交付形态下出现。本文件把真实项目作为回归夹具：项目目录不存在时
自动跳过；可用 DSH_REAL_SMOKE_PROJECT 指向其他真实项目。

只做只读断言（inspect/run_code），不 publish——不写入真实项目；
红线探测用的行值取自会话内存，不落测试文件。
"""
import os
from pathlib import Path

import pytest

import worker

REAL_PROJECT = Path(os.environ.get(
    "DSH_REAL_SMOKE_PROJECT", r"D:\project\company\epro\Project\304_manual"))

pytestmark = pytest.mark.skipif(
    not REAL_PROJECT.is_dir(),
    reason="真实项目目录不存在；设 DSH_REAL_SMOKE_PROJECT 指向真实项目后启用")


def _long_row_value() -> str:
    """取一个有辨识度且未被车道披露的真实行值作红线探针；JSON 字面量与
    设计词（"False"/"访视日期"）是刻意不入索引的，不能拿来当探针。
    2026-09-19 起探针只取**非词表列**（高基数）的值——与保护值索引的
    列基数口径一致：词表列（码表解码/访视/表单/状态）本就不入索引，
    拿它当探针会假报"红线失守"。"""
    disclosed = worker._disclosed_design_values(
        worker._session_datasets, worker._session_auxiliary_documents)
    if not worker._session_protected_hashes:
        ## 哈希索引由 listing_scan_init 建立（inspect 不建）；测试进程需显式预热
        worker.dispatch({"operation": "listing_scan_init", "project": str(REAL_PROJECT)})
    protected = worker._session_protected_hashes or set()
    for frame in worker._session_datasets.values():
        for column in frame.columns:
            own = frame[column].dropna().tolist()
            if worker._is_vocabulary_column(own):
                continue
            for value in own[:8]:
                ## 候选值必须与索引注册同源（表示形态/词表列/汇集规则一致）：
                ## 数值 str() 形态（46791.0 vs 46791）或汇集词表列的值不在
                ## 索引里，拿去当探针是假阴性——端到端断言要的是"真实受
                ## 保护值必然被 scan_text 拦下"。
                hashes = set()
                for text in worker._protected_representations(value):
                    hashes |= worker._scalar_hashes(text)
                if not (hashes & protected):
                    continue
                for text in worker._protected_representations(value):
                    if worker._is_distinctive_value(text) and text not in disclosed:
                        return text
    return ""


def test_real_project_inspect_and_run_code_end_to_end():
    result = worker.dispatch({"operation": "listing_inspect", "project": str(REAL_PROJECT)})
    assert result["ok"] is True, result.get("reason")
    inspection = result["inspection"]

    # 加密归档必须被自动推导的密码解开：不允许任何归档级失败
    archive_codes = {failure.get("code") for failure in inspection["failures"]}
    assert archive_codes.isdisjoint({
        "ARCHIVE_PASSWORD_REQUIRED", "ARCHIVE_EXTRACT_FAILED",
        "ARCHIVE_INVALID", "ARCHIVE_PASSWORD_PARTIAL"}), inspection["failures"]

    # 数据集元数据必须成规模（TAISHAN-304 归档含 99 个成员）
    datasets = inspection["datasets"]
    assert len(datasets) >= 50, f"数据集目录过小: {len(datasets)}"

    # doc/ 需求必须全部进入 manifest（含解析成功的 466.xls）
    doc_paths = {document["path"] for document in inspection["requirementDocuments"]}
    assert any(path.endswith("466.xls") for path in doc_paths), doc_paths

    # 辅助 Excel 必须解析出结构
    assert inspection["auxiliaryDocuments"], "辅助 Excel 未解析出任何结构"

    # read_document 通道可用即可；不强制读完全部 87 片（通用 DVP 模板
    # 不必整本读入上下文，未读分片只做软披露）
    for document in inspection["requirementDocuments"]:
        chunk = worker.dispatch({
            "operation": "listing_read_document", "project": str(REAL_PROJECT),
            "documentId": document["documentId"], "chunkIndex": 0})
        assert chunk["ok"] is True, document["path"]

    # 车道可用性：未读完需求分片也不得阻塞 run_code（此前被硬拦）
    run = worker.dispatch({
        "operation": "listing_run_code", "project": str(REAL_PROJECT),
        "code": "outputs = {name: frame.head(3) for name, frame in list(datasets.items())[:3]}"})
    assert run["ok"] is True, (run.get("code"), run.get("reason"))
    assert run["receipt"]["requirementsFullyRead"] is False

    # 通用车道保护值扫描仍然在岗：真实行值必须拦（红线未松）
    probe_value = _long_row_value()
    assert probe_value, "未找到可用于红线探测的长行值"
    scanned = worker.dispatch({
        "operation": "listing_scan_text", "project": str(REAL_PROJECT),
        "text": f"ordinary diagnostic output containing {probe_value}"})
    assert scanned == {"ok": True, "containsProtectedValue": True}

    # 而不含行值的普通诊断文本不误拦
    clean = worker.dispatch({
        "operation": "listing_scan_text", "project": str(REAL_PROJECT),
        "text": "plain diagnostic text without any clinical value"})
    assert clean == {"ok": True, "containsProtectedValue": False}
