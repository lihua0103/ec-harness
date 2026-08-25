# dsh-guard 缺陷修复计划

**制定日期**: 2026-08-22  
**目标**: 修复所有 P0/P1 缺陷，使系统达到可上线标准  
**验收标准**: 至少 1 个真实项目（RBQM_test 或 GQ1005-301）能完整跑通

---

## 一、修复范围确认

### P0 缺陷（必须修复，否则完全不可用）

| ID | 缺陷 | 影响 | 工作量 |
|---|---|---|---|
| B5 | pyreadstat/xlwt/pyzipper 缺失 | import 立即崩溃 | 5 分钟 |
| B10 | ZIP 512MB 限制 | 真实数据无法解压 | 10 分钟 |
| B11 | 临时目录清理失败 | 工作区污染 | 30 分钟 |
| B1 | ALS 解析 mappings=0 | listing 完全不可用 | 2 小时 |
| B12 | 错误信息被抹平 | 无法诊断 | 30 分钟 |
| B13 | ALS 只有表头被跳过 | 解析失败 | 1 小时 |

**小计**: 约 4.5 小时

### P1 缺陷（核心功能可用）

| ID | 缺陷 | 影响 | 工作量 |
|---|---|---|---|
| A2 | 文件级判断导致数据泄露 | 安全问题 | 3 小时 |
| A1 | listing 收据只给计数 | AI 无法理解需求 | 2 小时 |
| B3 | needs_input 无结构化说明 | 失败无从诊断 | 1 小时 |
| B2 | MAX_DEFINITIONS 截断无告警 | 字段丢失 | 30 分钟 |
| B6 | shadow 模式未激活 | 误报锁死会话 | 15 分钟 |

**小计**: 约 6.75 小时

**总工作量**: 约 11.25 小时（1.5 工作日）

---

## 二、修复任务清单

### 阶段 1: 基础依赖修复（P0-基础）

#### Task 1.1: 补齐 Python 依赖
- **文件**: `dsh-clinical-data-guard/requirements.txt`
- **修改**: 添加缺失的包
  ```
  pyreadstat>=1.2.0
  xlwt>=1.3.0
  pyzipper>=0.3.6
  ```
- **验证**: `pip install -r requirements.txt` 成功，无 ModuleNotFoundError

#### Task 1.2: 提高 ZIP 文件大小限制
- **文件**: `dsh-clinical-data-guard/security/path_policy.py`
- **修改**: L16-18
  ```python
  MAX_ARCHIVE_FILES = 10_000
  MAX_ARCHIVE_FILE_BYTES = 10 * 1024 * 1024 * 1024  # 10GB (真实临床数据规模)
  MAX_ARCHIVE_TOTAL_BYTES = 20 * 1024 * 1024 * 1024  # 20GB
  MAX_ARCHIVE_RATIO = 200
  ```
- **验证**: RBQM_test 的 7.1GB lab.sas7bdat 能成功解压

#### Task 1.3: 修复临时目录清理（Windows 权限兼容）
- **文件**: `dsh-clinical-data-guard/security/path_policy.py` L148-156
- **修改**: 增加权限重试逻辑
  ```python
  def _safe_rmtree(path):
      """跨平台安全删除，处理 Windows 权限映射问题"""
      try:
          shutil.rmtree(path)
      except PermissionError:
          # Windows 通过 WSL 访问时的权限映射问题
          # 先尝试修改权限再删除
          import stat
          for root, dirs, files in os.walk(path, topdown=False):
              for name in files:
                  try:
                      file_path = os.path.join(root, name)
                      os.chmod(file_path, stat.S_IWRITE)
                      os.unlink(file_path)
                  except:
                      pass
              for name in dirs:
                  try:
                      os.rmdir(os.path.join(root, name))
                  except:
                      pass
          try:
              os.rmdir(path)
          except:
              # 最后仍然失败则记录日志但不中断流程
              pass
  ```
- **验证**: 解压失败后临时目录能完全清理

### 阶段 2: ALS 解析修复（P0-核心）

#### Task 2.1: 支持只有表头的 sheet
- **文件**: `dsh-clinical-data-guard/security/spec_parser.py`
- **问题**: L199-574 只认 3 种布局，只有表头行被当作空 sheet 跳过
- **修改**: 
  1. 检测到表头但无数据行时，仍然解析表头结构
  2. `rowCount` 计算包含表头行
  3. 添加 `hasDataRows` 标志区分"有数据"和"只有表头"
- **验证**: GQ1005-301 Items sheet (rowCount=1) 能解析出字段结构

#### Task 2.2: 修复 mappings 解析逻辑
- **文件**: `dsh-clinical-data-guard/security/spec_parser.py`
- **问题**: 当前逻辑要求特定列名组合，真实 ALS 导出格式不匹配
- **修改**: 
  1. 放宽 mapping 识别条件：有 ItemOID/SASFieldName/SASLabel 即可
  2. 支持多种 ALS 导出格式（不同 EDC 系统）
  3. 添加详细日志记录为什么 mappings=0
- **验证**: GQ1005-301 和 RBQM ALS 解析出 mappings > 0

#### Task 2.3: MAX_DEFINITIONS 截断告警
- **文件**: `dsh-clinical-data-guard/security/spec_parser.py` L23-27
- **修改**: 
  ```python
  MAX_DEFINITIONS = 5000  # 提高上限
  # 截断时抛出警告而非静默
  if len(fields) >= MAX_DEFINITIONS:
      warnings.warn(f"字段定义超过 {MAX_DEFINITIONS}，已截断")
  ```
- **验证**: fields=2000 时有告警日志

### 阶段 3: 错误信息保留（P0-诊断）

#### Task 3.1: 保留原始错误信息
- **文件**: `dsh-clinical-data-guard/security/listing_workflow.py` L56-59
- **修改**: 
  ```python
  except Exception as exc:
      # 保留原始错误信息，不要通用包装抹平
      original_msg = str(exc)
      raise ListingWorkflowError(
          f"listing inspection failed: {original_msg}",
          code="LISTING_INSPECTION_FAILED") from exc
  ```
- **验证**: ZIP 超限时错误信息包含 "exceeds the size limit"

#### Task 3.2: needs_input 结构化说明
- **文件**: `dsh-clinical-data-guard/security/listing_workflow.py` L228-241
- **修改**: 
  ```python
  return {
      "status": "needs_input",
      "missing": {
          "als_mappings": len(mappings) == 0,
          "spec_requirements": len(requirements) == 0,
          "data_files": missing_data_files,
      },
      "details": "具体缺失项见 missing 字段"
  }
  ```
- **验证**: 失败收据包含结构化的 missing 字段

### 阶段 4: 数据泄露修复（P1-安全）

#### Task 4.1: Sheet 级数据检测
- **文件**: `dsh-clinical-data-guard/security/data_egress_guard.py`
- **新增函数**: `detect_data_sheet(sheet_name, first_n_rows)`
- **逻辑**:
  ```python
  def is_data_sheet(sheet_name: str, headers: list, sample_rows: list) -> bool:
      """Sheet 级判断是否为数据 sheet（而非需求说明）"""
      # 1. Sheet 名包含数据特征
      data_sheet_names = ['dm', 'ae', 'lab', 'sv', 'vs', 'subject', 'patient']
      if any(name in sheet_name.lower() for name in data_sheet_names):
          return True
      
      # 2. 表头包含 USUBJID/SUBJID 等受试者标识列
      if any(h in ['USUBJID', 'SUBJID', 'SITEID'] for h in headers):
          return True
      
      # 3. 数据行包含多个数值/日期/编号模式
      # （需要更精细的判断逻辑）
      return False
  ```
- **集成**: planes.js / tool-result-guard.js 调用此函数逐 sheet 判断
- **验证**: GQ1005-301 MM Listing要求.xlsx 的 SV sheet 被识别为数据 sheet，拒绝返回

#### Task 4.2: 修改 planeOf 为 sheet 级
- **文件**: `dsh-clinical-data-guard/src/planes.js`
- **修改**: 
  ```javascript
  export function planeOfSheet(filePath, sheetName, sheetHeaders) {
      // 先按文件级判断基础域
      const filePlane = planeOf(filePath);
      
      // spec/document plane 的文件需要逐 sheet 细化
      if (filePlane === 'spec' || filePlane === 'document') {
          if (isDataSheet(sheetName, sheetHeaders)) {
              return 'data';  // 降级为数据域
          }
      }
      
      return filePlane;
  }
  ```
- **验证**: SV sheet 返回 'data'，MM listing要求 sheet 返回 'document'

### 阶段 5: listing 工具链改进（P1-功能）

#### Task 5.1: listing 收据包含需求文本
- **文件**: `dsh-clinical-data-guard/security/listing_workflow.py` L132-140
- **修改**: 
  ```python
  receipt["requirements"] = {
      "documents": [{
          "name": doc_path.name,
          "kind": "specification",
          "summary": parsed,  # 保留计数
          "preview": {  # 新增：前 N 条需求的完整文本
              "requirements": requirements[:20],  # 受控数量
              "total": len(requirements)
          }
      }]
  }
  ```
- **验证**: AI 能看到前 20 条需求的完整文本

#### Task 5.2: 激活 shadow 模式
- **文件**: `dsh-clinical-data-guard/cordis.patch.yml`
- **修改**: L5
  ```yaml
  patch:
    - config:
        id: clinical-data-guard
        mode: shadow  # 误报不阻断，只记录
  ```
- **验证**: 误报时请求仍然放行，审计日志记录

### 阶段 6: 验证与测试

#### Task 6.1: 真实项目端到端测试
- **测试 1**: RBQM_test
  ```bash
  cd /path/to/Clinical-Data/RBQM_test
  # 调用 listing_inspect 操作
  # 预期: ok=true, mappings > 0
  ```
- **测试 2**: GQ1005-301
  ```bash
  cd /path/to/Clinical-Data/GQ1005-301
  # 调用 listing_inspect 操作
  # 预期: ok=true, mappings > 0, SV sheet 被拒绝
  ```

#### Task 6.2: 回归测试
- 运行全部现有测试用例
  ```bash
  cd dsh-clinical-data-guard
  python tests/run_all.py
  # 预期: 全绿，且不是静默跳过
  ```

#### Task 6.3: 临时目录清理验证
- 手动触发解压失败场景
- 检查 `.clinical-listing/` 目录能完全清空

---

## 三、执行顺序

```
Day 1 上午 (4 小时):
  Task 1.1: 补齐依赖 (5分钟)
  Task 1.2: ZIP 限制 (10分钟)
  Task 1.3: 临时目录清理 (30分钟)
  Task 2.1: 支持只有表头的 sheet (1小时)
  Task 2.2: 修复 mappings 解析 (2小时)

Day 1 下午 (4 小时):
  Task 2.3: MAX_DEFINITIONS 告警 (30分钟)
  Task 3.1: 保留错误信息 (30分钟)
  Task 3.2: needs_input 结构化 (1小时)
  Task 4.1: Sheet 级数据检测 (2小时)

Day 2 上午 (4 小时):
  Task 4.2: planeOfSheet 实现 (1小时)
  Task 5.1: listing 收据包含文本 (2小时)
  Task 5.2: 激活 shadow 模式 (15分钟)
  Task 6.1: 真实项目测试 (45分钟)

Day 2 下午 (2 小时):
  Task 6.2: 回归测试 (1小时)
  Task 6.3: 清理验证 (30分钟)
  最终审计 (30分钟)
```

---

## 四、验收标准

### 必须达成（上线门槛）

- [ ] 所有 P0 缺陷修复完成
- [ ] RBQM_test 或 GQ1005-301 至少一个能完整跑通
- [ ] 无依赖缺失（pip install 成功）
- [ ] 7.1GB 文件能成功解压
- [ ] ALS 解析 mappings > 0
- [ ] 临时目录能完全清理
- [ ] 回归测试全绿（无静默跳过）

### 应该达成（质量目标）

- [ ] GQ1005-301 SV sheet 数据不泄露
- [ ] listing 收据包含需求文本预览
- [ ] shadow 模式激活
- [ ] 错误信息包含根因
- [ ] needs_input 有结构化说明

### 可选达成（改进项）

- [ ] 所有 P1 缺陷修复
- [ ] 2 个真实项目都能跑通
- [ ] 增加真实数据规模测试用例

---

## 五、风险与应对

### 风险 1: ALS 解析逻辑复杂度高
- **概率**: 高
- **影响**: 可能需要更多时间理解真实 ALS 格式
- **应对**: 
  - 优先支持 GQ1005/RBQM 两种格式
  - 其他格式后续迭代
  - 添加详细日志辅助诊断

### 风险 2: Sheet 级判断误报率
- **概率**: 中
- **影响**: 可能误判需求 sheet 为数据 sheet
- **应对**: 
  - 保守策略：只拦截高置信度的数据 sheet
  - shadow 模式兜底
  - 用户可通过配置覆盖

### 风险 3: 临时目录清理仍然失败
- **概率**: 中（Windows 权限问题复杂）
- **影响**: 工作区污染
- **应对**: 
  - 最坏情况：记录日志但不中断流程
  - 提供手动清理工具
  - 文档说明清理方法

---

## 六、后续优化（P2/P3）

修复完 P0/P1 后，可考虑：

1. **P2 缺陷**: header_detect 白名单扩充、JS/Python 口径对齐
2. **真实数据测试套件**: 基于 Clinical-Data 的 10 个项目构建测试
3. **架构重构（P3）**: "计划-执行"两段式，彻底终结补丁竞赛

---

**执行开始时间**: 2026-08-22 23:30  
**预计完成时间**: 2026-08-24 12:00  
**执行人**: AI Agent (Kiro)
