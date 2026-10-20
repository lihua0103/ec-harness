"""code_runner 编译/执行分离与错误诊断协议（方案 §7.2，2026-10-20 P0）。

回归面：
1. 编译期 SyntaxError 带 stage=compile 与行号文本（数据未进执行，安全）；
2. 运行期异常只回固定白名单消息与可信类名——自定义类名归并
   ExecutionError、运行期 raise 的 SyntaxError 不再借"编译期"口径回流文本；
3. outputsDefined 是进程内可确认观察，成功与异常路径都如实上报；
4. 常用内置异常（NameError/ZeroDivisionError/JSONDecodeError）修错信号保留。
"""
import json

from sandbox import run_sandbox_code


def test_compile_error_reports_stage_and_location(project):
    result = run_sandbox_code("def broken(:\n    pass\n", project, {})
    assert result["ok"] is False
    assert result["stage"] == "compile"
    assert result["errorType"] == "SyntaxError"
    assert "line 1" in (result["error"] or "")


def test_compile_failure_reports_outputs_defined_false(project):
    result = run_sandbox_code("outputs = = 1\n", project, {})
    assert result["ok"] is False
    assert result["stage"] == "compile"
    assert result["outputsDefined"] is False


def test_runtime_custom_exception_class_name_is_masked(project):
    """自定义异常类名可由模型编造（类名即可控文本），一律归并 ExecutionError。"""
    code = (
        "class Boom(Exception):\n"
        "    pass\n"
        "raise Boom('ignored')\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["ok"] is False
    assert result["stage"] == "execute"
    assert result["errorType"] == "ExecutionError"
    assert result["error"] is None


def test_runtime_builtin_subclass_also_masked(project):
    code = (
        "class MyValueError(ValueError):\n"
        "    pass\n"
        "raise MyValueError('ignored')\n"
    )
    result = run_sandbox_code(code, project, {})
    assert result["errorType"] == "ExecutionError"


def test_runtime_syntax_error_text_not_released(project):
    """运行期 raise 的 SyntaxError 文本可能嵌数据值：类型名保留，正文不出域。"""
    result = run_sandbox_code("raise SyntaxError('SYN-LEAK-MARKER')\n", project, {})
    assert result["ok"] is False
    assert result["stage"] == "execute"
    assert result["errorType"] == "SyntaxError"
    assert result["error"] is None
    assert "SYN-LEAK-MARKER" not in json.dumps(result, ensure_ascii=False)


def test_outputs_defined_observed_even_when_execution_raises(project):
    """outputs 在异常前已定义：outputsDefined 必须如实为 True（此前异常
    路径缺省 False，谎报诊断事实）。"""
    result = run_sandbox_code("outputs = 1\nraise ValueError('ignored')\n", project, {})
    assert result["ok"] is False
    assert result["outputsDefined"] is True


def test_outputs_defined_false_when_never_assigned(project):
    result = run_sandbox_code("x = 1\n", project, {})
    assert result["ok"] is True
    assert result["outputsDefined"] is False


def test_common_builtin_error_signals_preserved(project):
    zero = run_sandbox_code("1 / 0\n", project, {})
    assert zero["errorType"] == "ZeroDivisionError"
    assert zero["error"] == "division by zero"

    name = run_sandbox_code("no_such_symbol_xyz + 1\n", project, {})
    assert name["errorType"] == "NameError"
    assert "no_such_symbol_xyz" in (name["error"] or "")

    decode = run_sandbox_code("import json\njson.loads('{bad')\n", project, {})
    assert decode["errorType"] == "JSONDecodeError"
