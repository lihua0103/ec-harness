"""保护索引哈希的跨进程稳定性（红线静默失效回归）。

实案（2026-09-20）：保护索引用内建 hash() 落盘为 scan-cache.json，而
hash() 对 str 按 PYTHONHASHSEED 每进程随机加盐——重启后的新进程加载缓存，
索引与当前进程算出的哈希零交集（同尺寸、完全失配），数据集行值扫描全部
放行=红线静默失效；真实项目冒烟测试的探针取不到命中值正是这条的哨兵。

断言口径：哈希只依赖文本，不依赖进程；缓存装载后的索引必须仍能拦截值。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import worker

PYTHON_DIR = Path(__file__).resolve().parent.parent

SAMPLE_TEXTS = ["SUBJ-777", "Headache grade 3", "2024-01-05", "S01001"]
PROBE = "SUBJ-777"

_CHILD = """
import sys, json
sys.path.insert(0, {python_dir!r})
import worker
texts = {texts!r}
print(json.dumps({{t: sorted(worker._scalar_hashes(t)) for t in texts}}))
"""


def _hashes_in_subprocess(seed: str) -> dict:
    env = dict(os.environ)
    env["PYTHONHASHSEED"] = seed
    out = subprocess.run(
        [sys.executable, "-c", _CHILD.format(python_dir=str(PYTHON_DIR), texts=SAMPLE_TEXTS)],
        capture_output=True, text=True, check=True, env=env, timeout=120,
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_scalar_hashes_stable_across_processes():
    """同一文本在不同 PYTHONHASHSEED 进程里必须得到同一哈希集合。"""
    first = _hashes_in_subprocess("0")
    second = _hashes_in_subprocess("7")
    assert first == second, "保护值哈希随进程变化：落盘缓存索引在重启后必然全失配"
    assert first[PROBE], "探针值必须产出哈希（否则断言空转）"


def test_scan_cache_roundtrip_survives_new_hash_seed(tmp_path):
    """缓存落盘→（新 seed 进程）装载→仍能拦截值：扫描红线跨重启有效。"""
    project = tmp_path / "proj"
    project.mkdir()
    (project / "Output").mkdir()
    fingerprint = worker._scan_cache_fingerprint(project)
    hashes = worker._scalar_hashes(PROBE)
    worker._save_scan_cache(project, fingerprint, hashes)

    loaded = worker._load_scan_cache(project, fingerprint)
    assert loaded == hashes

    child = """
import sys, json
sys.path.insert(0, {python_dir!r})
import worker
from pathlib import Path
project = Path({project!r})
fingerprint = {fingerprint!r}
loaded = worker._load_scan_cache(project, fingerprint)
print(json.dumps({{
    "loaded": loaded is not None,
    "blocks": worker.text_contains_protected_value("diagnostic " + {probe!r}, loaded or set()),
    "clean": worker.text_contains_protected_value("plain diagnostic text", loaded or set()),
}}))
"""
    env = dict(os.environ)
    env["PYTHONHASHSEED"] = "11"   # 与缓存写入进程的 seed 不同（同进程写入时即为当前 seed）
    out = subprocess.run(
        [sys.executable, "-c", child.format(python_dir=str(PYTHON_DIR), project=str(project),
                                            fingerprint=fingerprint, probe=PROBE)],
        capture_output=True, text=True, check=True, env=env, timeout=120,
    )
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["loaded"] is True, "缓存未被装载（指纹/版本不符）"
    assert result["blocks"] is True, "重启后缓存索引拦截失效：数据集红线静默放行"
    assert result["clean"] is False, "普通诊断文本被误拦"


def test_unprotected_representations_of_short_values_not_hashed():
    """短值（<4 字符）不入索引：防止对日志/文件名全面误拦。"""
    assert worker._scalar_hashes("Y/N") == set()
    assert worker._scalar_hashes(True) == set()
    assert worker._scalar_hashes(None) == set()


def test_scan_cache_rejected_when_hash_scheme_changed(tmp_path):
    """哈希口径变化（探针不符）必须整体拒收缓存，而不是装载一条死索引。

    这正是缺陷形态：装载"成功"但索引与当前进程算出的哈希零交集 → 扫描全放行。
    """
    project = tmp_path / "proj"
    (project / "Output").mkdir(parents=True)
    fingerprint = worker._scan_cache_fingerprint(project)
    cache_path = worker._scan_cache_path(project)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({
        "version": worker._SCAN_CACHE_VERSION,
        "fingerprint": fingerprint,
        "probe": 12345,                      # 伪造：与当前哈希口径不一致
        "hashes": sorted(worker._scalar_hashes(PROBE)),
    }), encoding="utf-8")
    assert worker._load_scan_cache(project, fingerprint) is None

    # 缺 probe 字段的旧格式同样拒收
    cache_path.write_text(json.dumps({
        "version": worker._SCAN_CACHE_VERSION,
        "fingerprint": fingerprint,
        "hashes": sorted(worker._scalar_hashes(PROBE)),
    }), encoding="utf-8")
    assert worker._load_scan_cache(project, fingerprint) is None
