# 临床 Listing 代码车道流程引导

引导 DSH agent 按**代码车道**完成临床 Listing：模型全权理解需求并编写 pandas 变换代码，本地执行，数据零出域。

## 触发条件

- 用户要求"生成/产出 listing"、"跑 listing 流程"、"做 Medical/RBQM Listing"
- 用户明确指向临床数据项目并要求数据处理

## 三阶段流程

### 阶段 1：Inspect（识别项目）

**目标**：识别 spec 需求、ALS 字段映射、数据集 schema

**操作**：
```
enterprise_listing_inspect(project="/path/to/project")
```

**返回内容**：
- `documents`: spec 文档列表（文本内容、ALS 映射）
- `schema`: 各数据集的列名（字典格式）
- `datasets`: 数据集清单（名称、路径、类型）
- `missing`: 缺失的凭据（如果有加密归档）
- `inferredScenario`: 推断的场景类型

**数据分类（重要）**：
- **rawdata**：`datasets` 中的 SAS/XPT/CSV 文件 - **这是要处理的数据**
- **spec**：`documents` 中的规格文档 - **这是处理规则**
- **template**：如果 doc/ 中有模板 Excel - **这是输出格式**

**AI 必须明确**：
- ✅ 正确：`datasets["AE"]` - 读取 AE 数据集
- ❌ 错误：`datasets["als"]` - ALS 不是数据集，是字段映射规则

### 阶段 2：Run Code（迭代开发）

**目标**：编写 pandas 代码处理数据，生成 listing

**操作**：
```python
# 可用变量
# datasets: dict[str, pd.DataFrame] - 按名称访问数据集
# pd: pandas 模块
# np: numpy 模块

# 示例：处理 AE 数据集
ae_df = datasets["AE"].copy()

# 数据处理逻辑
ae_df["AESTDTC"] = pd.to_datetime(ae_df["AESTDTC"])
ae_df = ae_df[ae_df["AESER"] == "Y"]  # 筛选严重 AE
ae_df = ae_df.sort_values(["USUBJID", "AESTDTC"])

# 输出必须定义 result 或 outputs
result = ae_df[["USUBJID", "AETERM", "AESTDTC", "AESER", "AEOUT"]]

# 或者多个 sheet
outputs = {
    "Serious AE": serious_ae_df,
    "Grade 3+ AE": grade3_ae_df,
}
```

**迭代流程**：
1. 编写代码 → `enterprise_listing_run_code(project, code)`
2. 检查返回的元数据（rowCount, columns）
3. 如不满意，调整代码，再次 run_code
4. 重复直到满意

**代码约束（白名单）**：
- ❌ 禁止：`import`、`from`、`open()`、`eval()`、`exec()`
- ❌ 禁止：下划线属性（`__`）、文件 IO
- ✅ 允许：pandas 操作、numpy 计算、math 函数

### 阶段 3：Publish（发布输出）

**目标**：将最近一次成功的结果发布到 Excel 文件

**操作**：
```
enterprise_listing_publish(project="/path/to/project", scenario="medical")
```

**输出内容**：
- Excel 文件位置：`.clinical-listing/output/{scenario}/{SCENARIO}_LISTINGS.xlsx`
- 自动生成 Contents sheet（列表所有 listings）
- Medical/RBQM 场景自动添加系统字段列

**系统字段识别规则**：
- EDC 系统字段 = SAS 数据集有但 ALS 映射中没有的字段
- 系统字段列置于前面
- 示例系统字段：`STUDYID`, `DOMAIN`, `USUBJID`, `SITEID`

**输出格式优先级**：
1. **有 template** → 按模板列顺序和样式输出
2. **无 template** → 按 ALS 表单字段顺序，前置系统字段列
3. **表头** → 显示字段 label（PreText），而非变量名

**Contents Sheet 格式**：
| No. | Listing | Description | Rows | Columns |
|-----|---------|-------------|------|---------|
| 1   | Serious AE | 严重不良事件 | 150  | 12      |
| 2   | Grade 3+ AE | 3级及以上AE | 45   | 10      |

## 完整示例

```
用户: "生成 Medical Listing"

Agent:
1. enterprise_listing_inspect(project="/data/study-001")
   → 返回：documents (ALS), schema (AE: 25列, VS: 18列), datasets (AE, VS, DM)

2. 分析 ALS 需求：需要严重 AE 列表，按受试者和日期排序

3. enterprise_listing_run_code(project="/data/study-001", code="""
ae_df = datasets["AE"].copy()
ae_df = ae_df[ae_df["AESER"] == "Y"]
ae_df["AESTDTC"] = pd.to_datetime(ae_df["AESTDTC"])
ae_df = ae_df.sort_values(["USUBJID", "AESTDTC"])

# 按 ALS 字段输出
result = ae_df[[
    "STUDYID", "SITEID", "USUBJID",  # 系统字段
    "AETERM", "AESTDTC", "AEENDT", "AESER", "AEOUT"  # ALS 字段
]]
""")
   → 返回：{rowCount: 150, columns: [...]}

4. enterprise_listing_publish(project="/data/study-001", scenario="medical")
   → 返回：{outputFile: ".clinical-listing/output/medical/MEDICAL_LISTINGS.xlsx"}

Agent 回复用户: "已生成 Medical Listing，包含 150 条严重 AE 记录，输出文件：..."
```

## 场景类型

| 场景 | 描述 | 系统字段 | 输出规范 |
|------|------|----------|----------|
| **medical** | 医学审核 Listing | ✅ 自动添加 | 按 ALS + 系统字段 |
| **rbqm** | 风险监控 Listing | ✅ 自动添加 | 按需求灵活输出 |
| **manual** | 手动临时 Listing | ❌ 不添加 | 完全自定义 |
| **report** | 报告附件 Listing | ✅ 自动添加 | 严格按模板 |

## ZIP 密码推导（自动）

如果数据集在加密 ZIP 中，系统自动按以下顺序尝试：

1. **credentialRef**（如果提供）
2. **项目名称**及其变体
3. **同目录 .txt 文件**内容
4. **归档文件名**及其变体
5. **项目内其他文件名**
6. **无密码**

**无需手动提供密码**，除非所有自动候选都失败。

## 常见错误避免

### ❌ 错误 1：把 spec 当数据
```python
# 错误！als 不是数据集
df = datasets["als"]
```

正确做法：
```python
# ALS 在 inspection.documents 中，用于理解字段映射
# rawdata 在 inspection.datasets 和 datasets dict 中
ae_df = datasets["AE"]
```

### ❌ 错误 2：程序去重
```python
# 错误！不要程序去重
df = df.drop_duplicates()
```

正确做法：
```python
# 按 spec 需求逻辑输出，完全不去重
# 数据完整性由源数据保证
df = df.sort_values(["USUBJID", "AESTDTC"])
```

### ❌ 错误 3：忽略系统字段
```python
# Medical 场景必须前置系统字段
result = ae_df[["AETERM", "AESTDTC"]]  # 错误！
```

正确做法：
```python
# 系统字段在前
result = ae_df[["STUDYID", "USUBJID", "AETERM", "AESTDTC"]]
```

## 失败码速查

| Code | 含义 | 处理方法 |
|------|------|----------|
| `PROJECT_NOT_FOUND` | 项目路径无效 | 检查项目路径 |
| `SANDBOX_CODE_REJECTED` | 代码违反白名单 | 移除 import/IO/下划线 |
| `NO_RESULT` | 代码未定义输出 | 添加 `result = ...` |
| `NO_SUCCESSFUL_RUN` | publish 前无成功 run | 先成功 run_code |
| `CODE_EXECUTION_ERROR` | 代码执行失败 | 检查语法、字段名 |

## 纪律（红线）

1. ✅ **rawdata 在 datasets 字典中**，不在 documents 中
2. ✅ **spec/ALS 在 documents 中**，用于理解需求，不是数据
3. ✅ **绝不程序去重**，数据按 spec 逻辑完整输出
4. ✅ **系统字段前置**（Medical/RBQM 场景）
5. ✅ **表头显示 label**，不是变量名
6. ✅ **迭代开发**，多次 run_code 直到满意，最后 publish

## 成功标准

- ✅ inspect 返回完整的 documents + schema + datasets
- ✅ run_code 成功执行并返回元数据
- ✅ 输出包含所有必需的系统字段（如适用）
- ✅ 输出按正确的列顺序（template 或 ALS）
- ✅ publish 生成 Excel 文件，包含 Contents sheet
