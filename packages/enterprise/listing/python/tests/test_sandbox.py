"""Sandbox 层：执行安全独立于开关；AST 禁用表；路径围栏；stdout 原样。"""
import pandas as pd
import pytest
from openpyxl import Workbook

from sandbox import SANDBOX_BUILTINS, build_environment, run_sandbox_code


def test_dangerous_builtins_absent():
    for name in ("open", "eval", "exec", "compile", "getattr", "input",
                 "globals", "locals", "vars", "delattr", "setattr"):
        assert name not in SANDBOX_BUILTINS


def test_import_is_whitelisted_safe_importer():
    """__import__ 在场但只白名单放行（FP-3）；白名单外给清晰 ImportError。"""
    from sandbox import safe_import
    assert SANDBOX_BUILTINS["__import__"] is safe_import
    import re as real_re
    assert safe_import("re") is real_re
    with pytest.raises(ImportError, match="白名单"):
        safe_import("os")


def test_import_statement_whitelist(project):
    result = run_sandbox_code("import os", project, {})
    assert result["ok"] is False
    assert "白名单" in result["error"]


def test_import_whitelisted_modules_work(project):
    """import re/statistics 等纯计算库照常（FP-3 防变蠢）。"""
    result = run_sandbox_code(
        "import re, statistics\nfound = re.findall(r'\\d+', 'ab12cd34')\navg = statistics.mean([1, 2, 3])\nprint(found, avg)",
        project, {})
    assert result["ok"] is True, result["error"]


def test_import_pandas_submodule_still_guarded(project):
    """import pandas.io.common 拿到的是护栏包装,os 链仍然进不去。"""
    result = run_sandbox_code("import pandas.io.common as c\nx = c.os", project, {})
    assert result["ok"] is False
    assert "沙箱" in result["error"]


def test_numpy_internal_lazy_import_survives(project):
    """ndarray.sum() 经 C 层惰性导入 numpy._core._methods——必须能过（FP-3 回归）。"""
    result = run_sandbox_code(
        "arr = pd.DataFrame({'A': [1, 2]})['A'].to_numpy()\ntotal = int(arr.sum())\nprint(total)", project, {})
    assert result["ok"] is True, result["error"]


def test_open_blocked(project):
    result = run_sandbox_code('open("/etc/passwd")', project, {})
    assert result["ok"] is False
    assert "open" in result["error"]


@pytest.mark.parametrize("code,match", [
    ("df = pd.DataFrame(); x = df.read_csv('a.csv')", "read_csv"),
    ("df = pd.DataFrame(); df.to_excel('x.xlsx')", "to_excel"),
    ("df = pd.DataFrame(); df.to_pickle('x.pkl')", "to_pickle"),
    ("query = 1", "query"),                  # 名字按名阻断（保守）
    ("eval = 1", "eval"),
])
def test_ast_blocklist_rejects_read_to_eval_query(project, code, match):
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is False, code
    assert match in result["error"]


def test_ast_blocklist_allows_normal_pandas(project):
    code = (
        "df = pd.DataFrame({'A': [1, 2]})\n"
        "g = df.groupby(df['A'] > 1)['A'].sum()\n"
        "values = list(df['A']) + df['A'].tolist()\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is True, result["error"]


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
    """审计 P1-1：源头标记不可由模型重贴。"""
    result = run_sandbox_code("tag_dataframe(pd.DataFrame(), 'model-output')", project, {})
    assert result["ok"] is False
    assert "tag_dataframe" in result["error"]


def test_stdout_captured_raw_no_sanitization(project):
    """stdout 原样回显（显式接受的已知边界，不做脱敏）。"""
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
    assert result["ok"] is True
    scanned = result["environment"]["out"]
    assert scanned["_source"] == "aux-excel"
    assert scanned["structure"]["sheets"][0]["columnCount"] == 2


def test_build_environment_contents(project):
    environment = build_environment(project, {})
    for name in ("datasets", "pd", "np", "math", "list_files", "scan_excel_structures"):
        assert name in environment, name
    assert "tag_dataframe" not in environment


# ---------------------------------------------------------------------------
# 2026-08-28 实战反馈（ADR-0007）：内建补齐 + 逃逸面封堵
# ---------------------------------------------------------------------------

def test_common_builtins_available(project):
    """dir/repr/map/filter/异常类可用——不再逼模型裸 except + 试错探环境。"""
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


def test_dunder_attribute_blocked(project):
    """pd.__dict__['read_sas'] 形态按名绕过——双下划线属性整体阻断。"""
    result = run_sandbox_code("fn = pd.__dict__['read_sas']", project, {})
    assert result["ok"] is False
    assert "__dict__" in result["error"]


def test_file_io_constructors_blocked(project):
    for code in (
        "x = pd.ExcelFile('a.xlsx')",
        "x = np.loadtxt('a.csv')",
        "x = np.genfromtxt('a.csv')",
        "x = np.fromfile('a.bin')",
    ):
        result = run_sandbox_code(code, project, {})
        assert result["ok"] is False, code
        assert "文件IO接口" in result["error"]


def test_exec_compile_breakpoint_blocked_by_name(project):
    for name in ("exec", "compile", "breakpoint", "__import__"):
        result = run_sandbox_code(f"{name} = 1", project, {})
        assert result["ok"] is False, name
        assert name in result["error"]


def test_normal_attribute_access_still_works(project):
    """封堵不误伤：普通属性访问（iloc/attrs/shape/tolist）照常。"""
    code = (
        "df = pd.DataFrame({'A': [1, 2]})\n"
        "x = df.shape\n"
        "y = df.iloc[0]['A']\n"
        "z = df['A'].tolist()\n"
        "attrs_ok = df.attrs\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is True, result["error"]


# ---------------------------------------------------------------------------
# 2026-08-28 漏洞扫描回归（V-2/V-3/V-4：AST 黑名单挡不住逐属性合法的下钻链）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("code", [
    "pd.io.common.os.system('echo pwned')",            # V-3 RCE 链
    "pd.io.common.urlopen('file:///etc/hostname')",    # V-2 任意文件读
    "pd.io.common.get_handle('/etc/hostname')",        # V-2 任意文件读
    "np.lib.npyio.DataSource()",                       # V-4 numpy2 新路径
    "np.DataSource()",                                 # V-4 AST 层先行拦截
    "pd.compat",                                       # 内部子模块树
])
def test_runtime_guard_blocks_submodule_and_io_chains(project, code):
    """全部实战复现过的逃逸链必须被拦(AST 或运行时护栏任一层)。"""
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is False, code
    assert ("沙箱" in result["error"]), result["error"]


def test_runtime_guard_preserves_legitimate_api(project):
    """护栏零损耗:顶层 DataFrame/merge/groupby/isinstance/np 照常。"""
    code = (
        "df = pd.DataFrame({'k': ['x', 'y'], 'v': [1, 2]})\n"
        "agg = df.groupby('k')['v'].sum()\n"
        "arr = np.sqrt(np.array([4.0, 9.0]))\n"
        "assert isinstance(df, pd.DataFrame)\n"
        "outputs_ok = True\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is True, result["error"]


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
