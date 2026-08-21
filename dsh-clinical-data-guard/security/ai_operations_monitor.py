"""AI操作监控系统 (AI Operations Monitor)

防止DeepSeek harness自主决策时绕过数据防护，100%监控所有AI操作。

设计目标：
1. 监控所有工具调用（bash/read/write/pickle等）
2. 检测危险操作模式（读SAS数据、调用pickle.load等）
3. 实时阻断高风险操作（不等执行完）
4. 记录完整操作链（用于事后审计和AI行为分析）
5. AI生成的代码也必须经过检查（防止写代码绕过）
"""

import re
import os
import ast
import hashlib
from typing import Any, Dict, List, Optional
from dataclasses import dataclass
from datetime import datetime
from enum import IntEnum

from security.audit_log import write_audit_record
from security.patterns import DATE_PATTERNS, SUBJECT_ID_PATTERNS


class RiskLevel(IntEnum):
    """操作风险等级"""
    SAFE = 0        # 安全操作
    LOW = 1         # 低风险（记录即可）
    MEDIUM = 2      # 中风险（需检查参数）
    HIGH = 3        # 高风险（需审批或自动拒绝）
    CRITICAL = 4    # 极危险（立即阻断）


@dataclass
class OperationThreat:
    """操作威胁检测结果"""
    operation: str  # 操作名称（tool名或命令）
    risk_level: RiskLevel
    reason: str  # 为什么危险
    evidence: str  # 证据（脱敏）
    recommendation: str  # ALLOW | BLOCK | REQUIRE_APPROVAL


class DangerousOperationBlocked(Exception):
    """危险操作被阻断"""
    def __init__(self, threat: OperationThreat, audit_id: str):
        self.threat = threat
        self.audit_id = audit_id
        super().__init__(
            f"🚫 危险操作被阻断\n"
            f"操作: {threat.operation}\n"
            f"风险: {threat.risk_level.name}\n"
            f"原因: {threat.reason}\n"
            f"审计ID: {audit_id}"
        )


class AIOperationMonitor:
    """AI操作监控器

    拦截所有AI发起的工具调用和代码执行，检测危险模式。
    """

    # 危险工具黑名单
    DANGEROUS_TOOLS = {
        # 直接数据访问
        "read_sas_folder": RiskLevel.HIGH,
        "read_sas_columns": RiskLevel.MEDIUM,  # 只读元数据，中风险
        "read_expected_output": RiskLevel.CRITICAL,  # 绝对禁止
        "peek_data_values": RiskLevel.CRITICAL,

        # 可能读取数据的工具
        "bash": RiskLevel.MEDIUM,  # 取决于命令内容
        "read_file": RiskLevel.LOW,  # 取决于文件路径
        "write_file": RiskLevel.LOW,
    }

    # 危险bash命令模式
    DANGEROUS_BASH_PATTERNS = [
        # pickle相关（读取数据）
        (re.compile(r'pickle\.load', re.IGNORECASE), RiskLevel.CRITICAL,
         "尝试用pickle.load读取数据"),

        # 混淆后的pickle与管道执行（BY-10）
        (re.compile(r'\bimport\s+pickle\b.*\b\w+\.load\b', re.IGNORECASE | re.DOTALL),
         RiskLevel.CRITICAL, "尝试用别名导入pickle后读取数据"),
        (re.compile(r'base64\s+-d\b.*\|\s*(?:sh|bash|pwsh)\b', re.IGNORECASE | re.DOTALL),
         RiskLevel.CRITICAL, "尝试解码隐藏载荷后直接执行shell"),

        # 直接读取SAS文件
        (re.compile(r'\.sas7bdat', re.IGNORECASE), RiskLevel.HIGH,
         "尝试读取SAS数据文件"),

        # 读取expected/output文件
        (re.compile(r'expected.*\.xlsx', re.IGNORECASE), RiskLevel.CRITICAL,
         "尝试读取expected文件（标准答案）"),

        # cat/head/tail/strings/xxd/od 读取数据文件（FIX-12: FR-03-10 补 strings 等十六进制/字符串转储）
        (re.compile(r'\b(cat|head|tail|strings|xxd|od)\b\s+.*\.(xlsx|xls|csv|sas7bdat|pkl)',
                    re.IGNORECASE), RiskLevel.HIGH,
         "尝试直接查看数据文件"),

        # Python脚本直接读数据
        (re.compile(r'python.*read_excel|python.*read_sas', re.IGNORECASE), RiskLevel.HIGH,
         "Python脚本读取数据"),

        # 绕过工具直接访问docment/目录
        (re.compile(r'(cat|less|head|tail|grep)\s+.*docment/', re.IGNORECASE), RiskLevel.MEDIUM,
         "直接访问项目数据目录"),
    ]

    # 危险文件路径模式
    DANGEROUS_PATH_PATTERNS = [
        (re.compile(r'sas_data_cache\.pkl$', re.IGNORECASE), RiskLevel.HIGH,
         "SAS数据缓存"),

        (re.compile(r'expected.*\.xlsx$', re.IGNORECASE), RiskLevel.CRITICAL,
         "Expected文件（标准答案）"),

        (re.compile(r'output.*\.xlsx$', re.IGNORECASE), RiskLevel.MEDIUM,
         "输出文件（可能含真实数据）"),

        (re.compile(r'\.sas7bdat$', re.IGNORECASE), RiskLevel.HIGH,
         "SAS数据集"),

        (re.compile(r'docment/.*/data/', re.IGNORECASE), RiskLevel.HIGH,
         "项目数据目录"),
    ]

    # Python代码危险模式（AST分析前的快速正则检查；FIX-5: 修正未转义括号）
    DANGEROUS_CODE_PATTERNS = [
        "pickle\\.load",
        "pd\\.read_sas",
        "pd\\.read_excel",
        "open\\(.*sas7bdat",
        "open\\(.*expected.*xlsx",
    ]

    def __init__(self, audit_dir: str = None):
        # ST-P2-13: 默认目录改回项目内 var/，符合规范 §10.2（禁止落用户主目录）。
        # 仍可通过 EMERALD_AUDIT_ROOT 覆盖至其他路径。
        _pkg_root = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
        self.audit_dir = audit_dir or os.environ.get("EMERALD_AUDIT_ROOT") or os.path.join(
            _pkg_root, "var", "ai_ops_audit"
        )
        os.makedirs(self.audit_dir, exist_ok=True)
        self._operation_chain: List[Dict] = []  # 本次会话的操作链

    def check_tool_call(self, tool_name: str, args: Dict[str, Any],
                       context: Dict[str, Any] = None) -> OperationThreat:
        """检查工具调用是否危险

        Args:
            tool_name: 工具名称
            args: 工具参数
            context: 上下文（session_id, user_id等）

        Returns:
            OperationThreat: 威胁评估结果

        Raises:
            DangerousOperationBlocked: 极危险操作，立即阻断
        """
        threat = self._assess_tool_threat(tool_name, args)

        # 记录操作链
        self._operation_chain.append({
            "timestamp": datetime.now().isoformat(),
            "tool": tool_name,
            "args_summary": self._sanitize_args(args),
            "risk": threat.risk_level.name,
            "blocked": threat.risk_level >= RiskLevel.HIGH,
        })

        # 记录审计
        audit_id = self._log_operation_audit(tool_name, args, threat, context)

        # P1-8: recommendation=BLOCK 优先于 risk 级别判断（修复 MEDIUM+BLOCK 不抛异常的缺陷）
        if threat.recommendation == "BLOCK" or threat.risk_level >= RiskLevel.HIGH:
            raise DangerousOperationBlocked(threat, audit_id)

        return threat

    def check_bash_command(self, command: str,
                           context: Dict[str, Any] = None) -> OperationThreat:
        """检查bash命令是否危险

        这是最高风险的检查点，因为bash可以做任何事。
        """
        threat = self._assess_bash_threat(command)

        audit_id = self._log_operation_audit("bash", {"command": command}, threat, context)

        if threat.recommendation == "BLOCK" or threat.risk_level >= RiskLevel.HIGH:
            raise DangerousOperationBlocked(threat, audit_id)

        return threat

    def check_file_access(self, file_path: str, mode: str,
                         context: Dict[str, Any] = None) -> OperationThreat:
        """检查文件访问是否危险

        Args:
            file_path: 文件路径
            mode: 访问模式（read/write）
        """
        threat = self._assess_file_threat(file_path, mode)

        audit_id = self._log_operation_audit(f"file_{mode}", {"path": file_path}, threat, context)

        if threat.recommendation == "BLOCK" or threat.risk_level >= RiskLevel.HIGH:
            raise DangerousOperationBlocked(threat, audit_id)

        return threat

    def check_python_code(self, code: str,
                         context: Dict[str, Any] = None) -> OperationThreat:
        """检查AI生成的Python代码是否危险

        这是防止AI写代码绕过工具限制的关键检查点。
        """
        threat = self._assess_code_threat(code)

        audit_id = self._log_operation_audit("python_code", {"code_hash": hash(code)}, threat, context)

        if threat.recommendation == "BLOCK" or threat.risk_level >= RiskLevel.HIGH:
            raise DangerousOperationBlocked(threat, audit_id)

        return threat

    _LOCAL_SOURCE_SUFFIXES = (".xlsx", ".xls", ".csv", ".sas7bdat", ".xpt")
    _LOCAL_SOURCE_PATH_KEYS = frozenset({
        "path", "file_path", "filepath", "filename", "file",
    })
    _LOCAL_SOURCE_COMMAND_TOOLS = frozenset({
        "bash", "pwsh", "shell", "command", "read", "read_file", "grep",
        "write", "write_file", "edit", "edit_file", "job_output",
    })

    @classmethod
    def _references_local_source(cls, tool_name: str, args: Dict[str, Any]) -> bool:
        """Detect a raw source-file operation without treating discovery as reading.

        This is a capability classification, not a filename blacklist. Glob is
        deliberately excluded: discovering candidate paths is harmless; opening
        or streaming a source file is what must use the local analysis boundary.
        """
        if tool_name == "local_data_metadata" or tool_name == "glob":
            return False
        if not isinstance(args, dict) or tool_name not in cls._LOCAL_SOURCE_COMMAND_TOOLS:
            return False
        for key, value in args.items():
            key_lower = str(key).lower()
            if key_lower in cls._LOCAL_SOURCE_PATH_KEYS:
                if isinstance(value, str) and value.lower().split("?", 1)[0].endswith(cls._LOCAL_SOURCE_SUFFIXES):
                    return True
            if key_lower in {"command", "script"} and isinstance(value, str):
                normalized = value.replace("\\", "/").lower()
                if any(suffix in normalized for suffix in cls._LOCAL_SOURCE_SUFFIXES):
                    return True
        return False

    def check_local_data_policy(self, tool_name: str, args: Dict[str, Any],
                                context: Dict[str, Any] = None) -> None:
        """Enforce the UAT local-data capability boundary.

        In ``uat-local`` mode raw source access is denied for every generic
        tool. The dedicated local analysis tool is the only reader and returns
        data-free metadata/aggregates. The denial is audited through the same
        operation monitor as every other policy decision.
        """
        if (context or {}).get("localDataAccess") != "uat-local":
            return
        if not self._references_local_source(tool_name, args):
            return
        threat = OperationThreat(
            operation=tool_name,
            risk_level=RiskLevel.HIGH,
            reason="UAT 源文件必须通过本地分析车道读取，通用工具不得返回原始数据",
            evidence="[LOCAL_SOURCE_ACCESS]",
            recommendation="BLOCK",
        )
        audit_id = self._log_operation_audit(tool_name, args, threat, context)
        raise DangerousOperationBlocked(threat, audit_id)


    def _assess_tool_threat(self, tool_name: str, args: Dict[str, Any]) -> OperationThreat:
        """评估工具调用威胁"""

        # 参数敏感工具先看具体内容，避免通用低风险名单短路更准确的路径/命令评估。
        if tool_name == "bash":
            command = args.get("command", "")
            return self._assess_bash_threat(command)

        if tool_name in ["read_file", "Read"]:
            file_path = args.get("file_path", "") or args.get("path", "")
            return self._assess_file_threat(file_path, "read")

        # FIX-5 (FR-03-13/14/15 / BY-10 / TC-25): 写入类工具的 Python 内容接入
        # check_python_code 的 AST 检查，防止 Agent 写代码绕过工具限制。
        if tool_name in ["write_file", "Write", "edit_file", "Edit", "apply_patch"]:
            return self._assess_write_tool(tool_name, args)

        # 检查工具黑名单
        if tool_name in self.DANGEROUS_TOOLS:
            risk = self.DANGEROUS_TOOLS[tool_name]

            # read_sas_columns只读元数据，检查参数
            if tool_name == "read_sas_columns":
                dataset_name = args.get("dataset_name", "")
                if not dataset_name:  # 读所有数据集的元数据
                    risk = RiskLevel.LOW

            return OperationThreat(
                operation=tool_name,
                risk_level=risk,
                reason=f"工具 {tool_name} 在危险工具列表中",
                evidence=f"args: {list(args.keys())}",
                recommendation="BLOCK" if risk >= RiskLevel.HIGH else "ALLOW"
            )

        # 默认：低风险
        return OperationThreat(
            operation=tool_name,
            risk_level=RiskLevel.LOW,
            reason="常规工具调用",
            evidence="",
            recommendation="ALLOW"
        )

    # Python 源文件扩展与内容特征：命中即进入代码检查。
    _CODE_FILE_SUFFIXES = (".py", ".pyw", ".ipynb")

    def _assess_write_tool(self, tool_name: str, args: Dict[str, Any]) -> OperationThreat:
        """评估写入类工具：目标为 Python 源码或内容含 Python 特征时做代码检查。"""
        file_path = str(
            args.get("file_path") or args.get("path") or args.get("filename") or ""
        )
        content = str(
            args.get("content") or args.get("new_str") or args.get("newText") or ""
        )
        looks_python = file_path.lower().endswith(self._CODE_FILE_SUFFIXES) or (
            content and ("import " in content or "def " in content)
        )
        if looks_python and content:
            code_threat = self._assess_code_threat(content)
            if code_threat.recommendation == "BLOCK" or code_threat.risk_level >= RiskLevel.HIGH:
                code_threat.operation = tool_name
                return code_threat
        # 写入本身低风险（内容已检查或非代码）
        return OperationThreat(
            operation=tool_name,
            risk_level=RiskLevel.LOW,
            reason="常规写入（代码内容已检查）" if looks_python else "常规写入",
            evidence="",
            recommendation="ALLOW"
        )

    def _assess_bash_threat(self, command: str) -> OperationThreat:
        """评估bash命令威胁"""

        # ST-P1-8: 剥离 shell 引号拼接绕过（c''at / c""at / c\at → cat）。空引号对与
        # 反斜杠转义在 shell 里不改变语义，却能绕开 \b 锚定的模式匹配。归一化后
        # 用同一套危险模式检查（原文仍进审计 evidence）。
        deobfuscated = re.sub(r"(?<=\w)(?:''|\"\"|\\)(?=\w)", "", command)
        scan_targets = {command, deobfuscated}

        # 检查危险模式
        for pattern, risk, reason in self.DANGEROUS_BASH_PATTERNS:
            if any(pattern.search(target) for target in scan_targets):
                return OperationThreat(
                    operation="bash",
                    risk_level=risk,
                    reason=reason,
                    evidence=self._sanitize_command(command),
                    recommendation="BLOCK" if risk >= RiskLevel.HIGH else "WARN"
                )

        # 检查是否访问敏感目录
        if "docment/" in command.lower():
            # 允许读取 _rules/, 但不允许读取 data/, output/, expected/
            if any(d in command.lower() for d in ["data/", "output/", "expected/"]):
                return OperationThreat(
                    operation="bash",
                    risk_level=RiskLevel.HIGH,
                    reason="访问项目数据目录",
                    evidence=self._sanitize_command(command),
                    recommendation="BLOCK"
                )

        # 默认：bash是中风险（因为能力强）
        return OperationThreat(
            operation="bash",
            risk_level=RiskLevel.LOW,
            reason="常规bash命令",
            evidence=self._sanitize_command(command),
            recommendation="ALLOW"
        )

    def _assess_file_threat(self, file_path: str, mode: str) -> OperationThreat:
        """评估文件访问威胁"""

        # ST-P2-6: 归一化 Windows 路径分隔符，防止通过 \ 替代 / 绕过黑名单模式
        _norm_path = file_path.replace('\\', '/')

        # 检查危险路径模式
        for pattern, risk, reason in self.DANGEROUS_PATH_PATTERNS:
            if pattern.search(_norm_path):
                return OperationThreat(
                    operation=f"file_{mode}",
                    risk_level=risk,
                    reason=reason,
                    evidence=f"path: {os.path.basename(file_path)}",
                    recommendation="BLOCK" if risk >= RiskLevel.HIGH else "WARN"
                )

        # 默认：文件访问是低风险
        return OperationThreat(
            operation=f"file_{mode}",
            risk_level=RiskLevel.LOW,
            reason="常规文件访问",
            evidence="",
            recommendation="ALLOW"
        )

    def _assess_code_threat(self, code: str) -> OperationThreat:
        """评估Python代码威胁（AST分析）"""

        # 1. 模式匹配（快速检查）
        for pattern in self.DANGEROUS_CODE_PATTERNS:
            if re.search(pattern, code, re.IGNORECASE):
                return OperationThreat(
                    operation="python_code",
                    risk_level=RiskLevel.HIGH,
                    reason=f"代码含危险模式: {pattern}",
                    evidence="[代码已省略]",
                    recommendation="BLOCK"
                )

        # 2. AST分析（深度检查）
        try:
            tree = ast.parse(code)
            threat = self._analyze_ast(tree)
            if threat:
                return threat
        except SyntaxError:
            # 语法错误的代码不执行，但记录warning
            return OperationThreat(
                operation="python_code",
                risk_level=RiskLevel.MEDIUM,
                reason="代码语法错误（可能是攻击尝试）",
                evidence="",
                recommendation="BLOCK"
            )

        # 默认：代码安全
        return OperationThreat(
            operation="python_code",
            risk_level=RiskLevel.LOW,
            reason="代码看起来安全",
            evidence="",
            recommendation="ALLOW"
        )

    # AST 深度检查关注的危险模块与函数名
    _DANGEROUS_MODULES = {"pickle", "marshal", "shelve", "dill", "joblib"}
    _DANGEROUS_FROM_NAMES = {"load", "loads"}
    # 危险内建函数：动态执行/反射/动态导入，均可用于绕过静态检查执行任意代码
    # 或反射式读取数据（ST-P1-8）。
    _DANGEROUS_BUILTINS = {"eval", "exec", "compile", "__import__", "getattr"}

    def _collect_dangerous_bindings(self, tree: ast.AST) -> tuple[set[str], set[str]]:
        """收集危险导入的绑定名（FIX-5 / FR-03-15）。

        Returns:
            (module_aliases, from_names):
            module_aliases — `import pickle` / `import pickle as p` 绑定的模块名集合
            from_names     — `from pickle import load` / `from pickle import load as l`
                             绑定的函数名集合
        """
        module_aliases: set[str] = set()
        from_names: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = alias.name.split(".")[0]
                    if root in self._DANGEROUS_MODULES:
                        module_aliases.add(alias.asname or root)
            elif isinstance(node, ast.ImportFrom):
                root = (node.module or "").split(".")[0]
                if root in self._DANGEROUS_MODULES:
                    for alias in node.names:
                        if alias.name in self._DANGEROUS_FROM_NAMES:
                            from_names.add(alias.asname or alias.name)
        return module_aliases, from_names

    def _analyze_ast(self, tree: ast.AST) -> Optional[OperationThreat]:
        """AST深度分析，检测危险模式（含 import 别名形态，FR-03-15 / TC-25）"""

        module_aliases, from_names = self._collect_dangerous_bindings(tree)

        for node in ast.walk(tree):
            # ST-P1-8: 危险内建函数调用（eval/exec/compile/__import__/getattr）——
            # 动态执行与反射可绕过一切静态模式检查执行任意代码或反射式读数据。
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
                    and node.func.id in self._DANGEROUS_BUILTINS:
                return OperationThreat(
                    operation="python_code",
                    risk_level=RiskLevel.CRITICAL,
                    reason=f"代码调用危险内建 {node.func.id}（动态执行/反射，可绕过检查）",
                    evidence=f"{node.func.id}(...)",
                    recommendation="BLOCK",
                )

            # ST-P1-8: __import__('pickle').load(...) —— 动态导入危险模块后调用
            # load/loads，静态 import 检查看不到，需单独识别。
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and node.func.attr in ("load", "loads") \
                    and isinstance(node.func.value, ast.Call) \
                    and isinstance(node.func.value.func, ast.Name) \
                    and node.func.value.func.id == "__import__" \
                    and node.func.value.args \
                    and isinstance(node.func.value.args[0], ast.Constant) \
                    and str(node.func.value.args[0].value).split(".")[0] in self._DANGEROUS_MODULES:
                return OperationThreat(
                    operation="python_code",
                    risk_level=RiskLevel.CRITICAL,
                    reason="代码用 __import__ 动态导入危险模块后调用 load",
                    evidence="__import__(...).load(...)",
                    recommendation="BLOCK",
                )

            # 检测 pickle.load 及其别名形态（import pickle as p; p.load(...)）
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Attribute):
                    if node.func.attr in ("load", "loads"):
                        if isinstance(node.func.value, ast.Name) and (
                            node.func.value.id == "pickle"
                            or node.func.value.id in module_aliases
                        ):
                            return OperationThreat(
                                operation="python_code",
                                risk_level=RiskLevel.CRITICAL,
                                reason="代码调用 pickle.load（读取数据，含别名形态）",
                                evidence="pickle.load(...)",
                                recommendation="BLOCK"
                            )

            # 检测 from pickle import load 的裸调用形态
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in from_names:
                    return OperationThreat(
                        operation="python_code",
                        risk_level=RiskLevel.CRITICAL,
                        reason="代码调用 from pickle 导入的 load（读取数据）",
                        evidence=f"{node.func.id}(...)",
                        recommendation="BLOCK"
                    )

            # 检测 pd.read_* 调用
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Attribute):
                    if node.func.attr in ["read_sas", "read_excel", "read_csv"]:
                        if isinstance(node.func.value, ast.Name):
                            if node.func.value.id in ["pd", "pandas"]:
                                # 检查读取的文件路径
                                if node.args:
                                    first_arg = node.args[0]
                                    if isinstance(first_arg, ast.Constant):
                                        path = str(first_arg.value)
                                        if any(kw in path.lower() for kw in ["expected", "sas7bdat", "output"]):
                                            return OperationThreat(
                                                operation="python_code",
                                                risk_level=RiskLevel.HIGH,
                                                reason=f"代码读取敏感文件: {os.path.basename(path)}",
                                                evidence=f"pd.{node.func.attr}(...)",
                                                recommendation="BLOCK"
                                            )

            # 检测 open() 调用读取敏感文件
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id == "open":
                    if node.args:
                        first_arg = node.args[0]
                        if isinstance(first_arg, ast.Constant):
                            path = str(first_arg.value)
                            if any(kw in path.lower() for kw in ["expected", "sas7bdat", ".pkl"]):
                                return OperationThreat(
                                    operation="python_code",
                                    risk_level=RiskLevel.HIGH,
                                    reason=f"代码打开敏感文件: {os.path.basename(path)}",
                                    evidence="open(...)",
                                    recommendation="BLOCK"
                                )

        return None

    # ========================================================================
    # 审计与日志
    # ========================================================================

    def _log_operation_audit(self, operation: str, args: Dict[str, Any],
                            threat: OperationThreat,
                            context: Dict[str, Any]) -> str:
        """记录操作审计"""

        audit_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")

        # FIX-9 (BR-06.5): camelCase/snake_case 双侧兼容，身份哈希非空串。
        session_raw = (context or {}).get("session_id") or (context or {}).get("sessionId")
        user_raw = (context or {}).get("user_id") or (context or {}).get("userId")

        audit_record = {
            "audit_id": audit_id,
            "timestamp": datetime.now().isoformat(),
            "operation": operation,
            "risk_level": threat.risk_level.name,
            "action": "BLOCKED" if threat.risk_level >= RiskLevel.HIGH else "ALLOWED",
            "reason": self._sanitize_command(threat.reason),
            "evidence": self._sanitize_command(threat.evidence),
            "args_summary": self._sanitize_args(args),
            "context": {
                "session_id": "sha256:" + hashlib.sha256(
                    str(session_raw).encode("utf-8")
                ).hexdigest()[:24] if session_raw else None,
                "user_id": "sha256:" + hashlib.sha256(
                    str(user_raw).encode("utf-8")
                ).hexdigest()[:24] if user_raw else None,
                "tool_sequence": len(self._operation_chain),
            }
        }

        write_audit_record(self.audit_dir, "ai_ops", audit_record)
        return audit_id

    def _sanitize_args(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """脱敏参数（只保留键名和类型）"""
        return {k: type(v).__name__ for k, v in args.items()}

    def _sanitize_command(self, command: str) -> str:
        """脱敏命令：只保留命令结构，值统一替换为类型占位。"""
        s = str(command)
        for pattern, label in SUBJECT_ID_PATTERNS:
            s = pattern.sub(f"[{label}]", s)
        for pattern, label in DATE_PATTERNS:
            s = pattern.sub("[DATE]", s)
        s = re.sub(r"(?i)(api[_-]?key|token|password|secret)(\s*[=:]\s*)\S+", r"\1\2[CREDENTIAL]", s)
        if len(command) > 100:
            return s[:97] + "..."
        return s

    def get_operation_chain(self) -> List[Dict]:
        """获取本次会话的完整操作链（用于调试）"""
        return self._operation_chain.copy()


# ============================================================================
# 全局单例
# ============================================================================

_GLOBAL_MONITOR = None

def get_ai_monitor() -> AIOperationMonitor:
    """获取全局AI操作监控器单例"""
    global _GLOBAL_MONITOR
    if _GLOBAL_MONITOR is None:
        _GLOBAL_MONITOR = AIOperationMonitor()
    return _GLOBAL_MONITOR


def check_tool_call(tool_name: str, args: Dict[str, Any],
                   context: Dict[str, Any] = None) -> OperationThreat:
    """便捷函数：检查工具调用

    所有工具调用必须先经过这个检查。

    Raises:
        DangerousOperationBlocked: 危险操作被阻断
    """
    monitor = get_ai_monitor()
    return monitor.check_tool_call(tool_name, args, context)


def check_bash(command: str, context: Dict[str, Any] = None) -> OperationThreat:
    """便捷函数：检查bash命令

    Raises:
        DangerousOperationBlocked: 危险命令被阻断
    """
    monitor = get_ai_monitor()
    return monitor.check_bash_command(command, context)


def check_python_code(code: str, context: Dict[str, Any] = None) -> OperationThreat:
    """便捷函数：检查Python代码

    Raises:
        DangerousOperationBlocked: 危险代码被阻断
    """
    monitor = get_ai_monitor()
    return monitor.check_python_code(code, context)

