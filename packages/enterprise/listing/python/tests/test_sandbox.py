"""Sandbox 层(ADR-0009 出域单点):执行面全开、便利助手围栏、捕获上限、stdout 原样。

2026-08-28 终裁后的回归面:①标准 Python 全量可用(import os/open/eval、
pd.read_*/to_* 不再设卡);②list_files/scan_excel_structures 助手自带的
项目根围栏仍在;③捕获流 1MB 上限与 truncated 标记;④stdout 原样回显;
⑤数据集注入与命名空间预置。ADR-0008 时代的 AST/GuardedModule/import
白名单封堵用例已随决策退役(历史见 git 与 SECURITY_SCAN §六)。
"""
import pandas as pd
import pytest
from openpyxl import Workbook

from sandbox import build_environment, run_sandbox_code


# ---------------------------------------------------------------------------
# 执行面全开(ADR-0009):此前被禁的能力逐一回归
# ---------------------------------------------------------------------------

def test_standard_imports_available(project):
    """import os/sys/re 全部可用——执行面不设卡(ADR-0009)。"""
    result = run_sandbox_code(
        "import os, sys, re\n"
        "joined = os.path.join('a', 'b')\n"
        "platform = sys.platform\n"
        "found = re.findall(r'\\d+', 'ab12cd34')\n",
        project, {})
    assert result["ok"] is True, result["error"]
    assert result["environment"]["joined"] == "a/b"


def test_import_pandas_submodule_unguarded(project):
    """import pandas.io.common 拿到裸模块——GuardedModule 已退役。"""
    result = run_sandbox_code(
        "import pandas.io.common as c\nok_flag = c.__name__ == 'pandas.io.common'\n",
        project, {})
    assert result["ok"] is True, result["error"]
    assert result["environment"]["ok_flag"] is True


def test_open_read_write_file(project):
    """open() 读写文件不再被 builtins 白名单挡(ADR-0009)。"""
    target = project / "adr0009_probe.txt"
    code = (
        f"with open({str(target)!r}, 'w', encoding='utf-8') as fh:\n"
        f"    fh.write('probe')\n"
        f"with open({str(target)!r}, encoding='utf-8') as fh:\n"
        f"    text = fh.read()\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is True, result["error"]
    assert result["environment"]["text"] == "probe"


def test_pandas_read_csv_and_to_csv_roundtrip(project):
    """pd 读写器(read_*/to_*)不设卡——中间文件随意,交付仍走 publish。"""
    target = project / "adr0009_rt.csv"
    code = (
        f"pd.DataFrame({{'A': [1, 2]}}).to_csv({str(target)!r}, index=False)\n"
        f"back = pd.read_csv({str(target)!r})\n"
        f"rows = len(back)\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is True, result["error"]
    assert result["environment"]["rows"] == 2


def test_eval_exec_names_available(project):
    """eval/exec/compile 等内建名字在场(此前按名阻断)。"""
    result = run_sandbox_code(
        "computed = eval('2 * 3')\nns = {}\nexec(\"ns['k'] = 7\")\n", project, {})
    assert result["ok"] is True, result["error"]
    assert result["environment"]["computed"] == 6
    assert result["environment"]["ns"]["k"] == 7


def test_numpy_internal_lazy_import_survives(project):
    """ndarray.sum() 经 C 层惰性导入 numpy._core._methods——必须能过(回归)。"""
    result = run_sandbox_code(
        "arr = pd.DataFrame({'A': [1, 2]})['A'].to_numpy()\ntotal = int(arr.sum())\nprint(total)", project, {})
    assert result["ok"] is True, result["error"]


def test_normal_attribute_access_still_works(project):
    """普通属性访问(iloc/attrs/shape/tolist/子模块)照常。"""
    code = (
        "df = pd.DataFrame({'A': [1, 2]})\n"
        "x = df.shape\n"
        "y = df.iloc[0]['A']\n"
        "z = df['A'].tolist()\n"
        "attrs_ok = df.attrs is not None\n"
        "mod_ok = pd.io.common.__name__ == 'pandas.io.common'\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is True, result["error"]


# ---------------------------------------------------------------------------
# 便利助手自带围栏(非执行限制;open/os 可绕,助手契约保持稳定)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("relpath", ["../outside.xlsx", "a/../../b.xlsx"])
def test_path_fence_rejects_escape(project, relpath):
    result = run_sandbox_code(f"s = scan_excel_structures({relpath!r})", project, {})
    assert result["ok"] is False
    assert "ESCAPE_PROJECT_ROOT" in result["error"]


def test_path_fence_rejects_escape_for_list_files(project, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    (outside / "x.csv").write_text("A\n1\n")
    relpath = "../" + outside.name
    result = run_sandbox_code(f"n = len(list_files({relpath!r}))", project, {})
    assert result["ok"] is False
    assert "ESCAPE_PROJECT_ROOT" in result["error"]


def test_tag_dataframe_not_exposed_in_sandbox(project):
    """审计 P1-1:源头标记不可由模型重贴。"""
    result = run_sandbox_code("tag_dataframe(pd.DataFrame(), 'model-output')", project, {})
    assert result["ok"] is False
    assert "tag_dataframe" in result["error"]


# ---------------------------------------------------------------------------
# 回执行为:stdout 原样 / 错误摘要 / 捕获上限
# ---------------------------------------------------------------------------

def test_stdout_captured_raw_no_sanitization(project):
    """stdout 原样回显(显式接受的已知边界 R-2,不做脱敏)。"""
    result = run_sandbox_code('print("SUBJ-777", "2026-08-28")', project, {})
    assert result["ok"] is True
    assert result["stdout"] == "SUBJ-777 2026-08-28\n"


def test_stderr_captured_and_error_reported(project):
    result = run_sandbox_code("print('boom')", project, {})
    assert result["ok"] is True
    assert result["stderr"] == ""
    failed = run_sandbox_code("1 / 0", project, {})
    assert failed["ok"] is False
    assert "division by zero" in failed["error"]
    assert failed["stdout"] == ""


def test_capture_cap_truncates_but_executes(project):
    """V-7a:print 海量输出不撑爆内存——执行继续,回执带 truncated 标记。"""
    code = (
        "for i in range(1500):\n"
        "    print('X' * 1000)\n"
        "outputs_done = True\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is True, result["error"]
    assert result["stdoutTruncated"] is True
    assert len(result["stdout"]) <= 1_001_000        # 上限附近,不无限增长


# ---------------------------------------------------------------------------
# 命名空间预置与注入
# ---------------------------------------------------------------------------

def test_environment_preloads(project):
    datasets = {"AE": pd.DataFrame({"A": [1]})}
    code = (
        "n_files = len(list_files())\n"
        "ae = datasets['AE']\n"
        "has_pd = pd is not None and np is not None and math is not None\n"
    )
    result = run_sandbox_code(code, project, datasets)
    assert result["ok"] is True, result["error"]
    environment = result["environment"]
    assert environment["n_files"] >= 1
    assert environment["has_pd"] is True
    assert environment["ae"] is datasets["AE"]


def test_scan_excel_structures_in_sandbox(project):
    wb = Workbook(); wb.active.append(["A", "B"]); wb.save(project / "t.xlsx")
    result = run_sandbox_code("s = scan_excel_structures('t.xlsx')\nout = s", project, {})
    assert result["ok"] is True, result["error"]
    scanned = result["environment"]["out"]
    assert scanned["_source"] == "aux-excel"
    assert scanned["structure"]["sheets"][0]["columnCount"] == 2


def test_build_environment_contents(project):
    environment = build_environment(project, {})
    for name in ("datasets", "pd", "np", "math", "rng", "datetime", "json",
                 "list_files", "scan_excel_structures"):
        assert name in environment, name
    assert "tag_dataframe" not in environment


def test_common_builtins_available(project):
    """dir/repr/map/filter/异常类可用(标准 builtins 自然包含)。"""
    code = (
        "names = dir(datasets)\n"
        "text = repr(names)\n"
        "doubled = list(map(str, [1, 2]))\n"
        "evens = list(filter(lambda n: n % 2 == 0, [1, 2, 3]))\n"
        "try:\n"
        "    raise ValueError('boom')\n"
        "except ValueError as exc:\n"
        "    pass\n"
        "except Exception:\n"
        "    pass\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is True, result["error"]
