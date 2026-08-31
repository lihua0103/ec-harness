"""FR-8 值遮蔽（2026-08-30 系统级重构）：构造期标注 + 归一化格式族匹配。

2026-08-29 用户终裁（绝对 0 泄露）保持不变：AI 经本地 Python 无限制执行，
回执出域前命中数据集单元格值的内容替换 ``[DATA]``；非模式扫描，只做精确
交集（含格式族归一化等价），未命中原样（零误伤）。

重构动机（浏览器真实 AI 实测证据，2026-08-30 用户裁决推倒）：

- **旧写死层全部删除**：PROTOCOL_KEYS 34 词中央白名单、outputs 表名层
  特例、``_source ∈ {spec-document, aux-excel}`` 豁免清单、SOFT_KEYS
  软通道键清单、len>=8 结构阈值——全是"复现一个 bug 堵一个场景"。
- **既漏又瞎**：漏——``repr`` 打印 ``np.float64(31.0)``、时间戳毫秒/
  微秒形态、pandas 渲染浮点尾零等**打印渲染格式 ≠ str(cell)** 的精确
  匹配失效逃逸；瞎——inspect 只有列名/dtype，AI 无法从数据获得语义
  （语义画像由 discovery.profile 另行供给，本层只管遮蔽）。

新架构三支柱：

1. **构造期源头标注**（单一真相源，取代一切中央清单）：只有回执构造点
   知道字符串来源——数据集派生/AI 回显字符串在构造点包 ``DataStr``
   （source_registry），协议词与白名单元数据（name/path/rowCount/…）
   保持 plain str。遮蔽规则唯一：**DataStr 叶子/键 → 遮蔽；plain str →
   永不遮蔽**。doc/ 子树内容全是 plain str——豁免由默认规则自动成立。
   新增回执字段忘标记 → 默认不遮（不安全方向），因此车道规则要求凡
   数据集派生字符串一律包 DataStr（AGENTS.md）。
2. **归一化格式族匹配**（修格式逃逸，规则作用于格式族而非场景）：值集
   每值生成规范形 + 变体族（datetime 的 iso/秒级/毫秒 3 位/日期-only
   显示形态、首尾空白折叠），匹配侧滑窗候选经同一归一化函数
   （``_canon``）后与规范集比对——时间戳微秒截断与 T/空格分隔对齐、
   浮点尾零剥离（31.0↔31、40.10↔40.1 等价）。**一条格式族规则覆盖
   任意项目任意列**，不是逐场景堵。
3. **统一滑窗遮蔽**（性能修复 2026-08-30 保持）：值集编译为
   ``值前 4 字符 -> 该桶值最大长度`` 前缀桶索引，全文 4 字符滑窗 +
   end 递减哈希探测——O(文本长度×桶深)，与值集规模无关；span 式替换
   （占位符自指不二次改写）+ 双侧包裹标点整 token 扩张（repr 形态
   ``'值'`` / ``['值']`` 整 token 换 ``[DATA]``，单侧残形标点保留）。

策略常量（集中声明，不再散落）：``MIN_VALUE_LEN``（len<4 短值豁免——
单字符/年份级噪声的误伤下限，2026-08-29 终裁口径保留）；``MAX_VALUE_SET``
（1M 上限，超限按频次/长度/首现确定性截取，高频短值必入集）。
开关关闭时本层由调用方（worker.dispatch）整体跳过，与 dataInterception
同一开关。

无 pandas 之外的新依赖。
"""
import datetime
import os
import re
from collections import Counter
from typing import Optional

import pandas as pd

from source_registry import DataStr

#: 命中替换占位符。
REPLACEMENT = "[DATA]"
#: 值集默认上限（BUG-R1 修复：50K→1M）。真实项目 distinct 值 5 万+不再
#: 常态触发降级；超限时按（频次降序, 长度降序, 首现顺序）确定性截取
#: ——高频值必入集（高频短值是 stdout 行值泄露的主体，不再被长值挤出）。
MAX_VALUE_SET = 1_000_000
#: 覆盖值集上限的环境变量（测试注入 / 现场调优）；
#: build_value_set 每次调用时读取，便于 monkeypatch 注入。
VALUE_SET_MAX_ENV = "DSH_VALUE_SET_MAX"
#: 【策略常量】单元格值入集的最小长度。len<4 的短值不入集：单字符、
#: 二三字符代码与两位年份级噪声的误伤面大于泄露面（2026-08-29 终裁
#: 口径保留；同时是滑窗最小宽度，短于此的窗口不存在）。
MIN_VALUE_LEN = 4

#: datetime/date 单元格类型（pd.Timestamp 是 datetime.datetime 子类）。
_DATETIME_TYPES = (pd.Timestamp, datetime.datetime, datetime.date)

#: token 两端可剥离的包裹标点（双侧成对包裹时整 token 换 [DATA]）。
_WRAPPED_PUNCT = ",.;:()[]'\""
_SEARCH_WS = re.compile(r"\s")

#: 归一化（``_canon``）只处理数字引导的候选；前缀稳定（归一化只动尾部：
#: 截断小数秒 / 剥尾零），故 4 字符前缀桶对原始/规范形通用。
_NUM_START = frozenset("0123456789-")
#: 时间戳族：``YYYY-MM-DD[T ]HH:MM:SS[.frac]`` → 秒级 + 空格分隔规范形
#: （微秒 6 位 / 毫秒 3 位 / 任意小数秒位 / isoformat 的 T 分隔在此对齐）。
_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?$")
#: 十进制浮点族（无科学计数）：剥尾部零与孤立尾点（31.0→31、40.10→40.1）。
_FLOAT_RE = re.compile(r"^-?\d+\.\d+$")
#: 数字引导成员的桶上限加宽：归一化等价窗可比原始成员**长**（文本
#: "1234.50"→成员 "1234.5"、"…:57.303456"→秒级成员），尾部富余覆盖
#: 追加尾零/小数秒位差——规范形命中仍受桶前缀约束，零误伤面不变。
_CANON_PAD = 6
#: token 边界扫描上限：包裹标点扩张只对短包裹有意义；无空白长文本
#（如 1MB 连续 "-"）里无限扫到文本末尾是 O(n²) 陷阱——超限视为不可
# 扩张（子串替换，值本身照遮）。
_TOKEN_SCAN_LIMIT = 64

#: 旧签名兼容缓存（按值集对象身份）：缓存持有强引用，身份比较安全；
#: 单槽——worker 单线程顺序调用且已改走显式 matcher 缓存，本槽只服务
#: mask_text/mask_receipt_strings 直传 frozenset 的调用方（测试/外部）。
_MATCHER_CACHE: Optional[tuple[frozenset, "ValueMatcher"]] = None


def _value_set_cap() -> int:
    """当前值集上限：``DSH_VALUE_SET_MAX`` 覆盖默认 ``MAX_VALUE_SET``。

    每次调用时读 env（测试可 monkeypatch 注入）；缺省 / 非整数 / 非正
    值一律回落默认，防误配置把值集清零。
    """
    raw = os.environ.get(VALUE_SET_MAX_ENV)
    if raw is None or not raw.strip():
        return MAX_VALUE_SET
    try:
        cap = int(raw)
    except ValueError:
        return MAX_VALUE_SET
    return cap if cap > 0 else MAX_VALUE_SET


def _canon(text: str) -> str:
    """格式族归一化：值集变体与文本匹配候选共用同一函数。

    - 时间戳族 → ``YYYY-MM-DD HH:MM:SS``（任意小数秒位截断、T/空格
      分隔对齐）——pandas 表格打印毫秒 3 位、``str(Timestamp)`` 微秒
      6 位、isoformat 的 ``T`` 分隔在此归一为一个规范形；
    - 十进制浮点族 → 剥尾部零（``31.0``→``31``、``40.10``→``40.1``）
      ——pandas/CSV 渲染浮点与 repr 的尾零差异在此对齐，int/float
      等价（``12345`` ↔ ``12345.0``）同时成立；
    - 其余原样返回（普通字符串零处理）。
    """
    match = _TS_RE.match(text)
    if match:
        return f"{match.group(1)} {match.group(2)}"
    if _FLOAT_RE.match(text):
        stripped = text.rstrip("0")
        return stripped[:-1] if stripped.endswith(".") else stripped
    return text


def _datetime_variants(value) -> list:
    """datetime/date 单元格的显示变体族（C1，2026-08-30 第四轮真实验证）。

    pandas 表格打印 datetime64 与 ``str(Timestamp)`` 不同形态：微秒非零
    时打印毫秒 3 位（".713" vs str 的 ".713000"）、整列零点时打印
    日期-only——变体直接入库（原始命中路径零归一化开销）；毫秒/微秒
    任意位差与 isoformat 的 ``T`` 分隔由 ``_canon`` 在匹配侧对齐。
    date 对象同构处理（无时间部分的变体退化为重复串，入集自然去重）。
    """
    variants = [value.isoformat()]
    try:
        base = f"{value:%Y-%m-%d %H:%M:%S}"
        variants.append(base)
        micro = getattr(value, "microsecond", 0)
        variants.append(f"{base}.{micro // 1000:03d}")
        variants.append(f"{value:%Y-%m-%d}")
    except (ValueError, TypeError):      # 非常规 datetime 形态：保留 isoformat 兜底
        pass
    return variants


def _family_variants(text: str, cell) -> list:
    """单元格值的变体族（仅与规范形不同的才返回）：datetime 显示形态 +
    首尾空白折叠（表格对齐填充、``str(cell)`` 带边白的形态）。"""
    variants: list = []
    stripped = text.strip()
    if stripped != text and len(stripped) >= MIN_VALUE_LEN:
        variants.append(stripped)
    if isinstance(cell, _DATETIME_TYPES):
        for variant in _datetime_variants(cell):
            if variant != text and len(variant) >= MIN_VALUE_LEN and variant not in variants:
                variants.append(variant)
    return variants


def _absorb_cell(text: str, cell, counts: dict, variants_by_value: dict) -> None:
    """单格吸收：len>=MIN_VALUE_LEN 入集计数；首现时挂变体族。"""
    if len(text) < MIN_VALUE_LEN:
        return
    if text not in counts:
        variants = _family_variants(text, cell)
        if variants:
            variants_by_value[text] = variants
    counts[text] = counts.get(text, 0) + 1


def build_value_set(datasets: dict) -> tuple[frozenset, dict]:
    """从会话数据集单元格构建精确值集（规范形 + 变体族 + dtype 快路径）。

    逐列按 dtype 分派：object 列逐格（str 原样 / 其余 str()，空值不入
    集——"None"/"<NA>"/"nan" 是伪值）；datetime 族逐格（变体需要
    Timestamp 对象，且 20% 日期列规模下逐格成本可控）；其余数值/布尔/
    类别列走向量化 ``notna→astype(str)→Counter`` 快路径（1M 级构建
    预算 4s 的前提；Counter 保持首现插入序，全局截取序与旧逐格实现
    一致）。**stats 按原始值口径**（变体不重复计数）；总数超上限
    （``MAX_VALUE_SET`` / ``DSH_VALUE_SET_MAX``）时按（频次降序, 长度
    降序, 首现顺序）确定性截取——高频值必入集（BUG-R1）；变体受同一
    截取约束：只有入选原始值的变体随行入集。返回 ``(frozenset[str],
    stats)``。
    """
    counts: dict[str, int] = {}
    variants_by_value: dict[str, list] = {}
    for frame in datasets.values():
        for column in frame.columns:
            series = frame[column]
            dtype = series.dtype
            if dtype == object or isinstance(dtype, pd.CategoricalDtype):
                for cell in series.tolist():
                    if cell is None or cell is pd.NA or (isinstance(cell, float) and cell != cell):
                        continue
                    text = cell if isinstance(cell, str) else str(cell)
                    _absorb_cell(text, cell, counts, variants_by_value)
            elif pd.api.types.is_datetime64_any_dtype(dtype):
                for cell in series.dropna().tolist():
                    _absorb_cell(str(cell), cell, counts, variants_by_value)
            else:
                try:
                    clean = series[series.notna()].astype(str)
                except (TypeError, ValueError):          # 罕见 dtype 兜底逐格
                    for cell in series.tolist():
                        if cell is None or (isinstance(cell, float) and cell != cell):
                            continue
                        _absorb_cell(str(cell), cell, counts, variants_by_value)
                else:
                    for text, count in Counter(clean.tolist()).items():
                        if len(text) >= MIN_VALUE_LEN:
                            counts[text] = counts.get(text, 0) + count
    total = len(counts)
    cap = _value_set_cap()
    degraded = total > cap
    if degraded:
        ordered = sorted(
            enumerate(counts.items()),
            key=lambda item: (-item[1][1], -len(item[1][0]), item[0]),
        )
        originals = frozenset(value for _, (value, _count) in ordered[:cap])
    else:
        originals = frozenset(counts)
    selected = originals
    if variants_by_value:
        extras = set()
        for value in originals:
            extras.update(variants_by_value.get(value, ()))
        if extras:
            selected = originals | frozenset(extras)
    return selected, {
        # stats 按原始值口径（变体不重复计数）：selected/dropped 与变体无关。
        "total": total,
        "selected": len(originals),
        "degraded": degraded,
        "dropped": total - len(originals),
    }


class ValueMatcher:
    """预编译值遮蔽匹配器（统一滑窗 + 归一化格式族）。

    把值集（规范形 + 变体族）一次性编译为：

    - ``values``：全成员 frozenset——滑窗候选的原始精确命中（O(1)）。
    - ``canon_forms``：成员的归一化形态中与自身不同者（时间戳秒级规范
      形 / 浮点尾零剥离形）——候选归一化后的等价命中（int/float 等价、
      微秒/毫秒位差、尾零差）。
    - ``windows``：``值前 4 字符 -> 该桶值最大长度`` 前缀桶。归一化只
      修改尾部，前缀稳定，规范形命中共享同桶；桶深上界 = 最长同前缀值。
    - ``stats``：values / canonForms / prefixBuckets 纯计数。

    构建一次 O(值数)；此后遮蔽任何文本 O(文本长度×桶深)，与值集规模
    无关——桶内探测是 end 递减哈希查 values/lookup（等价于对桶内全部
    完整值做精确比对，但每次探测 O(1)）。
    """

    __slots__ = ("values", "lookup", "windows", "canon_forms", "stats")

    def __init__(self, values):
        if not isinstance(values, frozenset):
            values = frozenset(values)
        windows: dict[str, int] = {}
        canon_forms: set = set()
        for value in values:
            length = len(value)
            key = value[:4]
            if value[0] in _NUM_START:
                length += _CANON_PAD              # 等价窗可比成员长（尾零/小数秒富余）
            if windows.get(key, 0) < length:
                windows[key] = length
            if value[0] in _NUM_START:
                canon = _canon(value)
                if canon != value:
                    canon_forms.add(canon)
        self.values = values
        self.canon_forms = frozenset(canon_forms)
        self.lookup = values | self.canon_forms      # 候选归一化命中的查表目标
        self.windows = windows
        self.stats = {
            "values": len(values),
            "canonForms": len(canon_forms),
            "prefixBuckets": len(windows),
        }

    def __bool__(self) -> bool:
        return bool(self.values)


def compile_matcher(values) -> ValueMatcher:
    """编译值集为 ValueMatcher（构建 O(值数)，遮蔽 O(文本) 与值数无关）。

    传入已是 ValueMatcher 时原样返回（幂等）；worker 按会话缓存本产物。
    """
    if isinstance(values, ValueMatcher):
        return values
    return ValueMatcher(values)


def _cached_matcher(values: frozenset) -> ValueMatcher:
    """旧签名兼容：按值集对象身份缓存编译结果（强引用钉住身份，防 id
    复用错配；单槽，同会话单值集）。"""
    global _MATCHER_CACHE
    cached = _MATCHER_CACHE
    if cached is not None and cached[0] is values:
        return cached[1]
    matcher = ValueMatcher(values)
    _MATCHER_CACHE = (values, matcher)
    return matcher


def _hit(candidate: str, values: frozenset, lookup: frozenset) -> bool:
    """候选命中判定：原始精确命中优先；数字引导候选归一化后查等价集。"""
    if candidate in values:
        return True
    if candidate[0] in _NUM_START and candidate[-1].isdigit():
        return _canon(candidate) in lookup
    return False


def mask_text(text: str, values) -> str:
    """统一滑窗遮蔽（DataStr 通道内容专用）；未命中原样返回（零误伤）。

    ``values`` 接受 ValueMatcher（推荐：worker 已按会话缓存，编译一次）
    或 frozenset（兼容旧签名：按值集对象身份缓存自动编译）。

    语义（统一规则，取代旧 hard/soft 双通道）：

    - **全文 4 字符前缀桶滑窗 + end 递减哈希探测**：len>=MIN_VALUE_LEN
      的全值（含短多词值与单 token 内嵌短值，如 repr 包裹形态）由同一
      滑窗覆盖；窗口含空白原样参与（跨 token 多词值如 "SITE 001" 整段
      命中）。每 start 取最长命中（长 datetime 形态优先于其日期-only
      前缀，防前缀先替换破坏长形态完整遮蔽）。
    - **归一化等价命中**：候选为原始精确命中，或数字引导候选经 ``_canon``
      归一化后命中规范集（时间戳任意小数秒位 / T 分隔、浮点尾零、
      int/float 等价）——同一值以 str/repr/pandas/datetime 截断等任意
      格式族形态出现均遮蔽。
    - **span 式替换**：按位置顺序拼接非重叠 span；命中值恰为 ``[DATA]``
      子串（如单元格值 'DATA'）时不会把已替换占位符再改写一遍。
    - **双侧包裹标点整 token 扩张**：命中两侧到 token 边界之间全是
      ``_WRAPPED_PUNCT``（repr 的 ``'值'`` / ``['值']``）时扩张为整
      token 替换；单侧残形标点（``{'值': 1}`` 的 ``{``、``x=12.5;`` 的
      尾 ``;``）保持子串替换、标点保留——双侧判定修复旧实现单侧吞
      标点的既知缺陷（2026-08-30 基线失败用例）。
    """
    if not text:
        return text
    matcher = values if isinstance(values, ValueMatcher) else _cached_matcher(values)
    if not matcher:
        return text
    windows = matcher.windows
    if not windows:
        return text
    values_set = matcher.values
    lookup = matcher.lookup
    length = len(text)
    spans: list[tuple[int, int]] = []
    for start in range(length - (MIN_VALUE_LEN - 1)):
        limit = windows.get(text[start:start + 4])
        if limit is None:
            continue
        ceiling = start + limit
        if ceiling > length:
            ceiling = length
        for end in range(ceiling, start + MIN_VALUE_LEN - 1, -1):
            if _hit(text[start:end], values_set, lookup):
                spans.append((start, end))   # 该 start 的最长命中
                break
    if not spans:
        return text
    pieces: list[str] = []
    cursor = 0
    for start, end in spans:                 # 外层循环天然按 start 升序
        if start < cursor:
            continue                         # 与已选 span 重叠：先到先得
        hit = text[start:end]
        left = start
        while left > cursor and not _SEARCH_WS.match(text[left - 1]):
            left -= 1                        # token 左边界（不越过上一 span）
        right = end
        right_limit = end + _TOKEN_SCAN_LIMIT
        if right_limit > length:
            right_limit = length
        while right < right_limit and not _SEARCH_WS.match(text[right]):
            right += 1                       # token 右边界（扫描上限防 O(n²)）
        token = text[left:right]
        core = token.strip(_WRAPPED_PUNCT)
        if core == hit and start > left and end < right:
            start, end = left, right         # 双侧纯包裹标点 → 整 token 替换
        pieces.append(text[cursor:start])
        pieces.append(REPLACEMENT)
        cursor = end
    pieces.append(text[cursor:])
    return "".join(pieces)


def _mask_walk(value, matcher: ValueMatcher, counter: list):
    """递归遮蔽 DataStr 叶子与 DataStr dict 键；未改动子树对象恒等返回。

    构造期标注架构（2026-08-30 系统级重构）下的唯一规则：

    - **DataStr 叶子 / DataStr dict 键** → mask_text 遮蔽（数据集派生 /
      AI 回显面；键遮蔽冲突按插入序后者覆盖——被覆盖条目的值不再出域，
      无信息残留）。
    - **plain str** → 永不遮蔽：协议词（ok/code/receipt/…）、白名单元数
      据（name/path/rowCount/dtypes 值/…）、doc/ 文档内容（spec 文本与
      Excel 单元格，ADR-0007 零拦截）——doc 子树豁免由默认规则自动成立
      （其内容构造时即 plain str），无豁免来源清单。
    - 协议词恰与单元格值碰撞：作 plain 键/叶子原样（协议词表固定，遮蔽
      协议词即破坏回执契约——既定残余口径，2026-08-29）。
    """
    if isinstance(value, str):
        if not isinstance(value, DataStr):
            return value                     # plain str：永不遮蔽
        masked = mask_text(value, matcher)
        if masked == value:
            return value
        counter[0] += masked.count(REPLACEMENT)
        return masked
    if isinstance(value, dict):
        entries: list = []
        changed = False
        for key, item in value.items():
            new_key = key
            if isinstance(key, DataStr):
                replaced = mask_text(key, matcher)
                if replaced != key:
                    counter[0] += replaced.count(REPLACEMENT)
                    new_key = replaced
            walked = _mask_walk(item, matcher, counter)
            if new_key is not key or walked is not item:
                changed = True
            entries.append((new_key, walked))
        if not changed:
            return value
        rebuilt: dict = {}
        for key, item in entries:
            rebuilt[key] = item            # 遮蔽冲突按插入序后者覆盖（同名互吞）
        return rebuilt
    if isinstance(value, list):
        result = value
        for index, item in enumerate(value):
            walked = _mask_walk(item, matcher, counter)
            if walked is not item:
                if result is value:
                    result = list(value)
                result[index] = walked
        return result
    return value


def mask_receipt_strings(receipt: dict, values, audit: Optional[dict] = None) -> dict:
    """回执级遮蔽入口：递归只处理 DataStr 叶子/键，plain str 恒等直通。

    ``values`` 接受 ValueMatcher（worker 会话缓存路径）或 frozenset
    （兼容旧签名，入口按身份缓存编译一次）。``audit`` 传入 dict 时写
    入 ``maskedCount``（纯计数，不含任何值内容）。
    """
    if isinstance(values, ValueMatcher):
        matcher = values
    elif values:
        matcher = _cached_matcher(values)
    else:
        return receipt
    if not matcher:
        return receipt
    counter = [0]
    masked = _mask_walk(receipt, matcher, counter)
    if audit is not None:
        audit["maskedCount"] = counter[0]
    return masked
