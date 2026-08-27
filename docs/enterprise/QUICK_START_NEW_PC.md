# 新电脑快速开始指南

## 一键启动（推荐）

现在启动脚本已经支持**自动初始化 submodule**，你只需要：

\\\ash
# 1. 克隆仓库
git clone https://github.com/lihua0103/ec-harness.git
cd ec-harness
git checkout feat/clinical/harness

# 2. 直接启动（会自动处理 submodule 和依赖）
start.bat
\\\

启动脚本会自动：
✅ 检测并初始化 upstream/deepseek-harness submodule
✅ 安装所有依赖
✅ 构建企业插件
✅ 构建官方 Harness
✅ 启动 WebUI (http://127.0.0.1:3080)

## 环境要求

- **Node.js**: >= 22.19.0 或 >= 24.0.0
- **pnpm**: >= 11.0.0
- **Git**: 任意版本

\\\ash
# 检查环境
node --version
pnpm --version

# 如果未安装 pnpm
npm install -g pnpm
\\\

## 测试 Multi-Sheet 功能

\\\ash
# 生成示例 Excel 文件
cd packages/enterprise/listing/python
python generate_templates.py

# 查看生成的 4 个模板文件
# - template_manual.xlsx
# - template_medical.xlsx
# - template_rbqm.xlsx
# - template_report.xlsx
\\\

## 完整测试文档

- **切换电脑测试**: packages/enterprise/listing/SWITCH_PC_TESTING.md
- **完整测试清单**: packages/enterprise/listing/TESTING_GUIDE.md
- **功能概述**: packages/enterprise/listing/MULTI_SHEET_README.md

## 常见问题

### Q: 网络问题导致 submodule 初始化失败

\\\ash
# 手动初始化
git submodule update --init --depth 1
\\\

### Q: 端口 3080 被占用

\\\ash
# 使用不同端口
set DSH_PORT=3081
start.bat
\\\

### Q: 构建失败

\\\ash
# 清理重建
pnpm run clean
pnpm install
pnpm run build
\\\

---

**最后更新**: 2026-08-27  
**分支**: feat/clinical/harness (0d919cc)  
**改进**: 现在支持自动 submodule 初始化！
