# 切换电脑测试 - 快速指南

## 提交信息

✅ **代码已提交到远程仓库**

- **分支**: \eat/clinical/harness\
- **Commit**: \787ef96\
- **远程仓库**: \https://github.com/lihua0103/ec-harness.git\
- **提交时间**: 2026-08-27

## 在新电脑上的操作步骤

### 1. 拉取代码

\\\ash
# 克隆仓库（如果是新电脑）
git clone https://github.com/lihua0103/ec-harness.git
cd ec-harness

# 或者在已有仓库中拉取
cd /path/to/dsh-guard
git fetch origin
git checkout feat/clinical/harness
git pull origin feat/clinical/harness
\\\

### 2. 验证文件

确认以下文件已存在：

\\\ash
cd packages/enterprise/listing

# 核心代码
ls python/styles/                  # 应该有 4 个文件
ls python/worker_new.py
ls src/index_new.ts

# 工具和文档
ls deploy_multi_sheet.py
ls python/generate_templates.py
ls TESTING_GUIDE.md
ls MULTI_SHEET_README.md
\\\

### 3. 快速测试（不部署）

生成示例模板，查看输出效果：

\\\ash
cd python
python generate_templates.py
\\\

这会在当前目录生成 4 个示例 Excel 文件：
- \	emplate_manual.xlsx\
- \	emplate_medical.xlsx\
- \	emplate_rbqm.xlsx\
- \	emplate_report.xlsx\

**打开这些文件，检查：**
- ✅ Contents 页存在且格式正确
- ✅ 数据页有正确的颜色主题
- ✅ 系统字段列已添加
- ✅ 冻结窗格在 A2
- ✅ 自动过滤器已启用

### 4. 完整测试（部署后）

#### 4.1 部署功能

\\\ash
cd packages/enterprise/listing

# 预览部署（干运行）
python deploy_multi_sheet.py --dry-run

# 确认无误后，执行部署
python deploy_multi_sheet.py

# 编译 TypeScript
pnpm build
\\\

#### 4.2 运行实际测试

\\\ash
# 使用测试项目
dsh run /path/to/test/clinical/project
\\\

在 AI 会话中执行：

\\\python
# 1. Inspect 项目
result = enterprise_listing_inspect(
    project="/path/to/project"
)

# 2. 准备测试数据
import pandas as pd

ae_df = pd.DataFrame({
    'Subject_ID': ['001', '002', '003'],
    'AE_Term': ['Headache', 'Nausea', 'Fatigue'],
    'Severity': ['Mild', 'Moderate', 'Mild']
})

vs_df = pd.DataFrame({
    'Subject_ID': ['001', '002', '003'],
    'BP_Systolic': [120, 125, 130],
    'Heart_Rate': [72, 75, 78]
})

# 3. 定义 outputs
outputs = {
    'Adverse_Events': ae_df,
    'Vital_Signs': vs_df
}

# 4. 发布（测试 medical 场景）
result = enterprise_listing_publish(
    project="/path/to/project",
    scenario="medical",
    trackChanges=True
)
\\\

#### 4.3 验证输出

检查生成的文件：
\\\
.clinical-listing/output/medical/MEDICAL_LISTINGS.xlsx
\\\

**应包含：**
- Contents 页（目录）
- Adverse_Events 页（绿色主题）
- Vital_Signs 页（绿色主题）
- 系统字段列（Flag, Update Details, Review Comments, Initial_Date, Reviewer）

### 5. 测试其他场景

重复步骤 4.2-4.3，测试：
- scenario="manual"（蓝色主题）
- scenario="rbqm"（橙色主题）
- scenario="report"（蓝色主题）

### 6. 测试合并工具

如果有现有的单文件输出：

\\\python
result = enterprise_listing_merge(
    project="/path/to/project",
    scenario="manual"
)
\\\

### 7. 测试变化追踪

\\\python
# 第一次发布
outputs = {'Test': pd.DataFrame({'A': [1, 2, 3]})}
enterprise_listing_publish(project="...", scenario="manual")

# 修改数据后再次发布
outputs = {'Test': pd.DataFrame({'A': [1, 2, 3, 4, 5]})}
enterprise_listing_publish(project="...", scenario="manual")

# 查看 Contents 页的 Description 列，应显示变化信息
\\\

## 完整测试清单

参考 \TESTING_GUIDE.md\ 中的详细测试清单。

### 必测项（5 项）
- [ ] 生成模板文件并检查格式
- [ ] 测试 manual 场景
- [ ] 测试 medical 场景
- [ ] 测试多 sheet 输出
- [ ] 测试变化追踪

### 建议测试（3 项）
- [ ] 测试 rbqm 场景
- [ ] 测试 report 场景
- [ ] 测试合并工具

## 遇到问题时

### 回滚部署

\\\ash
cd packages/enterprise/listing
python deploy_multi_sheet.py --rollback
pnpm build
\\\

### 查看日志

\\\ash
# 查看 Python 执行日志
# 通常在 dsh 输出中

# 查看生成的变化日志
cat .clinical-listing/output/{scenario}/*_changes.json
\\\

### 检查依赖

\\\ash
pip show pandas openpyxl
# 确保 openpyxl >= 3.0.0
\\\

## 文档参考

所有文档位于 \packages/enterprise/listing/\：

1. **快速开始**: \MULTI_SHEET_README.md\
2. **完整规范**: \docs/enterprise/LISTING_MULTI_SHEET_SPEC.md\
3. **快速指南**: \docs/enterprise/LISTING_MULTI_SHEET_QUICKSTART.md\
4. **测试指南**: \TESTING_GUIDE.md\
5. **实现清单**: \IMPLEMENTATION_CHECKLIST.md\
6. **交付清单**: \DELIVERY_CHECKLIST.md\

## 测试完成后

### 报告结果

创建测试报告，包含：
- 测试日期和环境
- 通过/失败的测试项
- 发现的问题（如有）
- 性能数据
- 截图（可选）

### 下一步

- ✅ 所有测试通过 → 可以准备生产部署
- ❌ 有测试失败 → 记录问题，回到开发电脑修复

## 联系方式

- **文档位置**: packages/enterprise/listing/
- **提交历史**: \git log --oneline | head -5\
- **最新提交**: 787ef96

---

**祝测试顺利！** 🚀

如有问题，查看文档或在 GitHub 提 issue。
