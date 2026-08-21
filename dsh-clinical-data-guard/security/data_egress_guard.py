"""数据出域智能防护系统 (Data Egress Guard)

红线 1 合规：多层防御 + 智能检测 + 用户参与决策

设计原则：
1. 边读边检（流式扫描，不等完整构建）
2. 上下文感知（区分元数据/需求文本/数据行）
3. 分级处置（脱敏/提示/拒绝，不是一刀切）
4. 可解释性（告诉用户为什么拦、拦在哪）
5. 保底脱敏（fail-closed：不确定时脱敏，绝不裸放）
"""

import re
from typing import List, Dict, Any, Optional, Tuple, Set
from enum import IntEnum
from dataclasses import dataclass

from security.patterns import (
    CLINICAL_TERMS,
    DATE_PATTERNS,
    SUBJECT_ID_PATTERNS,
    is_document_version_number,
    ends_with_alpha_segment,
    operational_spans,
    strip_uuids,
)
from security.tokenizer import token_for, token_sub, tokenize_clinical_text


class DataRiskLevel(IntEnum):
    """数据风险等级（数字越大风险越高）"""
    METADATA = 0        # 元数据（列名、sheet 名）→ 放行
    SUSPICIOUS_LOW = 1  # 疑似数据（低置信）→ 脱敏放行 + warning
    SUSPICIOUS_HIGH = 2 # 确定数据（高置信）→ 提示用户确认
    SENSITIVE = 3       # 敏感数据（受试者ID+日期+医学术语组合）→ 拒绝或强审计


@dataclass
class DetectionResult:
    """检测结果"""
    risk_level: DataRiskLevel
    confidence: float  # 0.0-1.0
    patterns_matched: List[str]  # 命中的模式名
    evidence: str  # 证据摘要（已脱敏）
    location: str  # 位置描述
    recommendation: str  # 处置建议


class ClinicalDataDetector:
    """临床数据智能检测器

    边读边检，上下文感知，分级识别：
    - 表头模式（列名组合判断"这是数据表"）
    - 数据行模式（单元格值特征）
    - 上下文线索（sheet 名、前后行）
    """

    # 表头关键词（临床数据表的常见列名）
    _CLINICAL_HEADER_KEYWORDS = {
        # 受试者标识类
        "subject", "subj", "usubjid", "subjid", "patient", "ptid",
        "participant", "screening", "screen",
        # 访视/时间类
        "visit", "visitnum", "visitdy", "day", "date", "dt", "dtc",
        "time", "timestamp", "rfstdtc", "rfendtc",
        # 状态/事件类
        "status", "state", "aestdat", "aeendat", "cm", "ae", "lb",
        # 测量值类
        "value", "result", "lborres", "lbstresc", "measure",
        # 站点类
        "site", "siteid", "center", "country",
    }

    # 受试者编号模式（各种格式）
    _SUBJECT_ID_PATTERNS = SUBJECT_ID_PATTERNS
    _DATE_PATTERNS = DATE_PATTERNS
    _MEDICAL_TERMS = CLINICAL_TERMS

    def __init__(self):
        self._context_window: List[str] = []  # 上下文窗口（最近5行）
        self._detected_headers: Set[str] = set()  # 已识别的表头列

    def detect_table_header(self, row_cells: List[str]) -> Tuple[bool, float, List[str]]:
        """检测一行是否是临床数据表的表头

        Returns:
            (is_header, confidence, matched_keywords)
        """
        if not row_cells or len(row_cells) < 2:
            return False, 0.0, []

        # 标准化：小写、去空格
        normalized = [c.lower().strip() for c in row_cells if c and c.strip()]

        # 统计命中的表头关键词
        matched = []
        for cell in normalized:
            for keyword in self._CLINICAL_HEADER_KEYWORDS:
                if keyword in cell:
                    matched.append(keyword)

        if len(matched) == 0:
            return False, 0.0, []

        # 置信度计算：命中关键词数 / 总列数，但上限 0.95
        confidence = min(0.95, len(matched) / len(normalized))

        # 高置信判据：≥3个关键词，或≥2个且包含 subject/visit
        critical_hit = any(k in matched for k in ["subject", "subj", "usubjid", "visit"])
        is_header = len(matched) >= 3 or (len(matched) >= 2 and critical_hit)

        if is_header:
            self._detected_headers.update(matched)

        return is_header, confidence, matched

    def detect_data_row(self, row_cells: List[str],
                       after_header: bool = False) -> DetectionResult:
        """检测一行是否包含临床数据

        Args:
            row_cells: 单元格列表（已转为字符串）
            after_header: 是否在已识别的表头之后（上下文线索）

        Returns:
            DetectionResult
        """
        if not row_cells:
            return DetectionResult(
                risk_level=DataRiskLevel.METADATA,
                confidence=0.0,
                patterns_matched=[],
                evidence="空行",
                location="",
                recommendation="放行"
            )

        # 过滤空单元格
        cells_text = [str(c).strip() for c in row_cells if c is not None and str(c).strip()]
        if not cells_text:
            return DetectionResult(
                risk_level=DataRiskLevel.METADATA,
                confidence=0.0,
                patterns_matched=[],
                evidence="空行",
                location="",
                recommendation="放行"
            )

        # 检测各类模式
        patterns_hit = []
        evidence_parts = []

        # 1. 受试者编号模式（先剥离 UUID 技术标识，与出域车道口径一致）
        subj_count = 0
        for cell in (strip_uuids(c) for c in cells_text):
            for pattern, desc in self._SUBJECT_ID_PATTERNS:
                match = pattern.search(cell)
                if match:
                    # 与出域车道同一口径：'标识+YYYYMMDD' 文档版本号不是受试者编号
                    # （纯格式判据，无关键词豁免）。日期形态仍由下方日期模式计数。
                    if desc == "字母前缀编号" and is_document_version_number(match.group(0)):
                        continue
                    # 与出域车道同一口径：字母末段的文档/项目编号不计受试者信号
                    # （token 化仍由 _light_scrub 统一覆盖，用户保底规则）。
                    if desc == "USUBJID格式" and ends_with_alpha_segment(match.group(0)):
                        continue
                    subj_count += 1
                    patterns_hit.append(f"受试者编号({desc})")
                    evidence_parts.append(f"[SUBJ]")
                    break

        # 2. 日期模式
        date_count = 0
        for cell in cells_text:
            for pattern, desc in self._DATE_PATTERNS:
                if pattern.search(cell):
                    date_count += 1
                    patterns_hit.append(f"日期({desc})")
                    evidence_parts.append(f"[DATE]")
                    break

        # 3. 医学术语
        medical_count = 0
        for cell in cells_text:
            cell_lower = cell.lower()
            for term in self._MEDICAL_TERMS:
                if term.lower() in cell_lower:
                    medical_count += 1
                    patterns_hit.append(f"医学术语({term})")
                    evidence_parts.append(f"[{term}]")
                    break

        # 风险等级判定（组合逻辑）
        total_signals = subj_count + date_count + medical_count

        # Level 3: 敏感数据（受试者ID + 日期 + 医学术语组合）
        if subj_count >= 1 and date_count >= 1 and medical_count >= 1:
            return DetectionResult(
                risk_level=DataRiskLevel.SENSITIVE,
                confidence=0.95,
                patterns_matched=list(set(patterns_hit)),
                evidence=" | ".join(evidence_parts[:5]),  # 最多展示5个
                location="数据行",
                recommendation="拒绝或要求用户确认"
            )

        # Level 2: 确定数据（受试者ID + 日期，或多个强信号）
        if (subj_count >= 1 and date_count >= 1) or total_signals >= 3:
            return DetectionResult(
                risk_level=DataRiskLevel.SUSPICIOUS_HIGH,
                confidence=0.80,
                patterns_matched=list(set(patterns_hit)),
                evidence=" | ".join(evidence_parts[:5]),
                location="数据行",
                recommendation="提示用户确认或自动脱敏"
            )

        # Level 1: 疑似数据（单一信号，或在表头后的数值行）
        if total_signals >= 1 or (after_header and len(cells_text) >= 3):
            # 表头后的多列数值行很可能是数据
            confidence = 0.60 if total_signals >= 1 else 0.40
            return DetectionResult(
                risk_level=DataRiskLevel.SUSPICIOUS_LOW,
                confidence=confidence,
                patterns_matched=list(set(patterns_hit)) if patterns_hit else ["表头后多列行"],
                evidence=" | ".join(evidence_parts[:5]) if evidence_parts else f"{len(cells_text)}列数据",
                location="数据行",
                recommendation="自动脱敏后放行"
            )

        # Level 0: 元数据/需求文本
        # FIX-9 (R-6): METADATA 行 evidence 不含原始单元格文本。
        return DetectionResult(
            risk_level=DataRiskLevel.METADATA,
            confidence=0.9,
            patterns_matched=["需求文本"],
            evidence=f"[METADATA:{len(cells_text)}列]",
            location="文本行",
            recommendation="放行"
        )

    def detect_sheet_risk(self, sheet_name: str) -> Tuple[DataRiskLevel, str]:
        """检测整个 sheet 的风险等级（根据命名）

        Returns:
            (risk_level, reason)
        """
        name_lower = sheet_name.lower()

        # 高风险 sheet 名模式
        high_risk_keywords = [
            "subject", "patient", "受试者", "participant",
            "listing", "数据", "data", "raw", "source",
            "visit", "访视", "ae", "不良事件", "adverse",
        ]

        # 低风险 sheet 名模式
        low_risk_keywords = [
            "spec", "需求", "requirement", "说明", "instruction",
            "metadata", "元数据", "legend", "图例", "note", "备注",
            "toc", "目录", "cover", "封面",
        ]

        # 优先匹配低风险（需求类）
        for keyword in low_risk_keywords:
            if keyword in name_lower:
                return DataRiskLevel.METADATA, f"Sheet名含'{keyword}'(需求类)"

        # 匹配高风险（数据类）
        for keyword in high_risk_keywords:
            if keyword in name_lower:
                return DataRiskLevel.SUSPICIOUS_HIGH, f"Sheet名含'{keyword}'(数据类)"

        # 默认：中等风险
        return DataRiskLevel.SUSPICIOUS_LOW, "Sheet名不确定"


class StreamingScrubber:
    """流式脱敏器：边读边脱敏，不等完整构建"""

    def __init__(self, detector: ClinicalDataDetector):
        self.detector = detector
        self.audit_log: List[Dict[str, Any]] = []  # 审计日志

    def scrub_row(self, row_cells: List[Any],
                  row_index: int,
                  after_header: bool = False) -> Tuple[List[str], DetectionResult]:
        """脱敏单行

        Returns:
            (scrubbed_cells, detection_result)
        """
        # 转为字符串
        cells_str = [str(c) if c is not None else "" for c in row_cells]

        # 操作性标识保护（用户规则：路径/文件名是辅助读取的操作数据，绝不改写
        # ——否则模型拿 [SUBJ:..] 假路径读文件直接 not found 断掉工作流）。
        # 检测在"路径掩蔽后"的文本上做（路径形态不推高风险等级，区间外文本
        # 不被连带重脱敏）；脱敏按原文分段做（区间内原样保留）。
        segs_list = [self._operational_segments(c) for c in cells_str]
        masked_cells = [
            "".join(seg if not is_op else f"\x00P{i}\x00"
                    for i, (is_op, seg) in enumerate(segs))
            for segs in segs_list
        ]

        # 检测
        result = self.detector.detect_data_row(masked_cells, after_header)

        # 根据风险等级决定处置（区间段原样，区间外按级别脱敏）
        def _scrub_row_segments(scrub_segment):
            return [
                "".join(seg if is_op else scrub_segment(seg)
                        for is_op, seg in segs)
                for segs in segs_list
            ]

        if result.risk_level <= DataRiskLevel.SUSPICIOUS_LOW:
            # 低风险：轻度脱敏（掩盖明显的ID/日期，保留结构）
            scrubbed = _scrub_row_segments(tokenize_clinical_text)
        elif result.risk_level == DataRiskLevel.SUSPICIOUS_HIGH:
            # 高风险：重度脱敏（区间外整段类型化 token）
            scrubbed = _scrub_row_segments(self._heavy_token)
        else:  # SENSITIVE
            # 敏感：区间外拒绝占位，路径/文件名仍保留（操作性）
            scrubbed = _scrub_row_segments(lambda seg: "[已隐去敏感数据]")

        # 记录审计日志
        if result.risk_level >= DataRiskLevel.SUSPICIOUS_LOW:
            self.audit_log.append({
                "row": row_index,
                "risk_level": result.risk_level.name,
                "confidence": result.confidence,
                "patterns": result.patterns_matched,
                "action": "scrubbed" if scrubbed else "blocked",
            })

        return scrubbed, result

    @staticmethod
    def _operational_segments(cell: str):
        """把单元格切成 [(是否操作性区间, 文本段), ...]。

        区间 = 路径/文件名（排序合并重叠——路径与其内嵌文件名 token 重叠是
        常态，不合并则重叠区之间的缝隙会被误判为数据段而错误脱敏）。
        掩蔽占位符 \x00P{i}\x00 不含任何数据模式形态，不会污染检测。
        """
        merged = []
        for a, b in sorted(operational_spans(cell)):
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        segs, last = [], 0
        for a, b in merged:
            if a > last:
                segs.append((False, cell[last:a]))
            segs.append((True, cell[a:b]))
            last = b
        if last < len(cell):
            segs.append((False, cell[last:]))
        return segs

    @staticmethod
    def _heavy_token(segment: str) -> str:
        """重度脱敏的单段版本（原 _heavy_scrub 的每段逻辑）。"""
        seg = segment.strip()
        if not seg:
            return ""
        if seg.isdigit():
            return token_for(seg, 'NUM')
        if any(pat.search(seg) for pat, _ in ClinicalDataDetector._DATE_PATTERNS):
            return token_for(seg, 'DATE')
        return token_for(seg, 'TEXT')

    def _light_scrub(self, cells: List[str]) -> List[str]:
        """轻度脱敏：数据值 → 不可逆 HMAC token（同值同 token，保留 LLM 可推理性）。

        用户方案（hash 无逆向）：不再用固定占位 [SUBJ]/[DATE] 抹平所有值——那样
        LLM 无法区分/关联行。改用会话级 HMAC token：受试者 101-001 → [SUBJ:a3f9c2b1]，
        同一受试者在别处仍是同一 token，LLM 可 join/去重/计数，但无密钥不可反查。

        实现收敛到 tokenizer.tokenize_clinical_text（单一来源）：出域车道
        （egress_checkpoint）保底脱敏与本车道必须同一口径，否则再次出现
        "写入车道宽、读出车道严"的不对称，会话被历史误报永久钉死。
        """
        return [tokenize_clinical_text(c) for c in cells]

    def _heavy_scrub(self, cells: List[str]) -> List[str]:
        """重度脱敏：整格值 → 类型化 token（同值同 token，保留结构与可关联性）。"""
        result = []
        for c in cells:
            if not c or not c.strip():
                result.append("")
            elif c.strip().isdigit():
                result.append(token_for(c.strip(), 'NUM'))
            elif any(pat.search(c) for pat, _ in ClinicalDataDetector._DATE_PATTERNS):
                result.append(token_for(c.strip(), 'DATE'))
            else:
                result.append(token_for(c.strip(), 'TEXT'))
        return result


def scan_xlsx_sheet_safe(worksheet, sheet_name: str, max_rows: int = 200) -> Dict[str, Any]:
    """安全扫描 Excel sheet（智能检测 + 动态脱敏）

    用于替代 tool_read_spec 中的 xlsx 读取逻辑。

    Args:
        worksheet: openpyxl worksheet 对象
        sheet_name: sheet 名称
        max_rows: 最大扫描行数（防御纵深，即使检测失效也不读海量数据）

    Returns:
        {
            "sheet_name": str,
            "content": str,  # 脱敏后的文本（或拒绝消息）
            "risk_summary": {
                "max_risk_level": str,
                "data_rows_detected": int,
                "action_taken": str,  # "allowed" | "scrubbed" | "blocked" | "user_prompted"
            },
            "audit_log": List[Dict],  # 详细检测记录
            "user_prompt": Optional[Dict],  # 如果需要用户决策，这里有提示内容
        }
    """
    detector = ClinicalDataDetector()
    scrubber = StreamingScrubber(detector)

    # 1. 检测 sheet 级风险
    sheet_risk, sheet_reason = detector.detect_sheet_risk(sheet_name)

    # 如果 sheet 名就是高风险，立即提示
    if sheet_risk == DataRiskLevel.SUSPICIOUS_HIGH:
        return {
            "sheet_name": sheet_name,
            "content": f"[Sheet '{sheet_name}' 疑似包含数据，已跳过]",
            "risk_summary": {
                "max_risk_level": "SUSPICIOUS_HIGH",
                "data_rows_detected": 0,
                "action_taken": "blocked_by_sheet_name",
                "reason": sheet_reason,
            },
            "audit_log": [],
            "user_prompt": {
                "message": f"⚠️ Sheet '{sheet_name}' 命名疑似数据表({sheet_reason})，建议跳过",
                "options": ["跳过此sheet", "脱敏后读取", "强制读取(需审计)"],
            }
        }

    # 2. 逐行扫描
    rows_txt = []
    max_risk_seen = DataRiskLevel.METADATA
    data_rows_count = 0
    header_detected_at = None

    row_iter = worksheet.iter_rows(min_row=1, values_only=True)
    try:
        for row_idx, row in enumerate(row_iter, start=1):
            if row_idx > max_rows:
                rows_txt.append(f"\n[... 剩余 {worksheet.max_row - max_rows} 行未扫描（防御上限）]")
                break

            if not any(cell is not None and str(cell).strip() for cell in row):
                continue  # 跳过空行

            # 先检测是否表头
            is_header, header_conf, header_kw = detector.detect_table_header(
                [str(c) if c is not None else "" for c in row]
            )

            if is_header:
                header_detected_at = row_idx
                rows_txt.append(f"[表头行 {row_idx}]: " + " | ".join(header_kw))
                continue

            # 检测并脱敏数据行
            after_header = (header_detected_at is not None and row_idx > header_detected_at)
            scrubbed_cells, result = scrubber.scrub_row(row, row_idx, after_header)

            # 更新最高风险等级
            if result.risk_level > max_risk_seen:
                max_risk_seen = result.risk_level

            if result.risk_level >= DataRiskLevel.SUSPICIOUS_LOW:
                data_rows_count += 1

            # 敏感数据：停止扫描，提示用户
            if result.risk_level == DataRiskLevel.SENSITIVE:
                rows_txt.append(f"\n[第 {row_idx} 行检测到敏感数据组合，已停止扫描]")
                return {
                    "sheet_name": sheet_name,
                    "content": "\n".join(rows_txt),
                    "risk_summary": {
                        "max_risk_level": "SENSITIVE",
                        "data_rows_detected": data_rows_count,
                        "action_taken": "user_prompted",
                        "stopped_at_row": row_idx,
                    },
                    "audit_log": scrubber.audit_log,
                    "user_prompt": {
                        "message": (
                            f"⚠️ 数据安全检查\n"
                            f"位置: {sheet_name} / 第 {row_idx} 行\n"
                            f"检测到: {', '.join(result.patterns_matched)}\n"
                            f"示例: {result.evidence}（已脱敏）\n\n"
                            f"建议:\n"
                            f"  1. 跳过此 sheet（推荐）\n"
                            f"  2. 脱敏后继续读取\n"
                            f"  3. 允许读取（需审计授权）"
                        ),
                        "options": ["跳过", "脱敏继续", "允许(需授权)"],
                        "default": "跳过",
                    },
                }

            # 拼接脱敏后的行
            if scrubbed_cells:
                line = " | ".join(scrubbed_cells)
                if len(line) > 300:
                    line = line[:297] + "..."
                rows_txt.append(line)
    finally:
        # 提前 return / break 时显式关闭惰性迭代器，释放底层 zip 文件句柄
        # （Windows 上否则文件占用导致外层清理失败）。
        row_iter.close()

    # 3. 决定最终动作
    action = "allowed"
    if max_risk_seen >= DataRiskLevel.SUSPICIOUS_HIGH:
        action = "scrubbed"
    elif max_risk_seen == DataRiskLevel.SUSPICIOUS_LOW:
        action = "scrubbed"

    return {
        "sheet_name": sheet_name,
        "content": f"已自动脱敏 {data_rows_count} 行疑似数据\n" + "\n".join(rows_txt),
        "risk_summary": {
            "max_risk_level": max_risk_seen.name,
            "data_rows_detected": data_rows_count,
            "action_taken": action,
            "total_rows_scanned": min(row_idx, max_rows),
        },
        "audit_log": scrubber.audit_log,
        "user_prompt": None,  # 无需提示（已自动脱敏）
    }
