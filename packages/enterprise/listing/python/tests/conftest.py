"""pytest 公共配置：把 python/ 放进 sys.path，隔离 worker 会话状态。"""
import sys
from pathlib import Path

import pytest

PYTHON_DIR = Path(__file__).resolve().parent.parent
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))


@pytest.fixture(autouse=True)
def isolated_worker_session():
    """每个测试独占会话状态，避免跨测试串扰。"""
    import worker
    saved = (worker._session_project, worker._session_datasets, worker._last_outputs)
    worker._session_project, worker._session_datasets, worker._last_outputs = None, {}, None
    yield
    worker._session_project, worker._session_datasets, worker._last_outputs = saved


@pytest.fixture()
def project(tmp_path):
    """带一个 AE.csv 与 doc/spec.txt 的最小项目。"""
    (tmp_path / "doc").mkdir()
    (tmp_path / "doc" / "spec.txt").write_text("需求文档\n" + "X" * 400 + "\nREQUIREMENT-TAIL", encoding="utf-8")
    (tmp_path / "AE.csv").write_text("USUBJID,AETERM\nSUBJ-777,Headache\nSUBJ-888,Nausea\n", encoding="utf-8")
    return tmp_path
