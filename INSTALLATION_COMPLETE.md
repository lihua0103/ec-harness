# 🎉 DSH Guard 安装完成！

## ✅ 安装成功

完整的 DeepSeek Harness 已成功安装到项目中！

### 已安装的核心包

- ✅ `@deepseek-ai/dsh@0.1.1-rc.2` - DSH 完整框架
- ✅ `@deepseek-ai/cordis@4.0.1` - Cordis 插件框架
- ✅ `typescript@6.0.3` - TypeScript 编译器
- ✅ `vitest@4.1.11` - 测试框架

### 安装统计

- **总包数**: 490 个
- **安装时间**: 约 1 分钟
- **磁盘占用**: 约 200 MB

## 🚀 如何运行

### 方式一：使用 npm scripts（推荐）

```bash
# 启动 Web UI
pnpm start

# 或无界面模式
pnpm start:headless
```

### 方式二：使用批处理脚本（Windows）

```bash
# 双击运行
start.bat

# 或命令行
.\start.bat
```

### 方式三：直接运行

```bash
node node_modules/@deepseek-ai/dsh/lib/bin.js web
```

## ⚙️ 配置要求

### 1. 设置 API Key（必需）

编辑 `.env` 文件：

```bash
# 复制模板
cp .env.example .env
```

在 `.env` 中设置：
```env
DEEPSEEK_API_KEY=sk-your-api-key-here
```

### 2. 编辑 Cordis 配置（可选）

编辑 `configs/cordis.yml` 启用企业插件。

## 📝 下一步

### 1. 配置环境变量

```bash
# 复制并编辑 .env
cp .env.example .env
notepad .env
```

### 2. 构建企业插件

```bash
pnpm build
```

### 3. 启动服务

```bash
pnpm start
```

默认访问地址：`http://127.0.0.1:3080`

## 🔧 开发企业插件

### 创建新插件

```bash
# 创建插件目录
mkdir -p packages/enterprise/my-plugin/src

# 参考 auth 插件示例
cd packages/enterprise/auth
```

### 编译插件

```bash
# 编译所有插件
pnpm build

# 监听模式（自动重新编译）
pnpm -r run build --watch
```

## 📚 可用命令

```bash
# 启动 Web UI
pnpm start

# 启动无界面模式
pnpm start:headless

# 构建所有插件
pnpm build

# 运行测试
pnpm test

# 监听模式测试
pnpm test:watch

# 类型检查
pnpm typecheck

# 清理构建产物
pnpm clean
```

## 🎯 DSH 命令行选项

```bash
# 查看帮助
node node_modules/@deepseek-ai/dsh/lib/bin.js --help

# 启动 Web UI
node node_modules/@deepseek-ai/dsh/lib/bin.js web

# 使用自定义配置
node node_modules/@deepseek-ai/dsh/lib/bin.js web --config configs/cordis.yml

# 指定端口
node node_modules/@deepseek-ai/dsh/lib/bin.js web --port 8080

# 无界面模式
node node_modules/@deepseek-ai/dsh/lib/bin.js headless "你的任务"
```

## 🐛 常见问题

### Q: 提示缺少 API Key？

A: 编辑 `.env` 文件，设置 `DEEPSEEK_API_KEY`

### Q: 端口 3080 被占用？

A: 使用 `--port` 参数指定其他端口：
```bash
pnpm start -- --port 8080
```

### Q: 企业插件没有加载？

A: 检查：
1. `configs/cordis.yml` 中插件是否启用（`disabled: false`）
2. 插件是否已构建（`pnpm build`）
3. 查看控制台日志

### Q: TypeScript 编译错误？

A: 确保依赖已安装：
```bash
pnpm install
```

## 📖 文档索引

- [README.md](README.md) - 项目总览
- [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) - 项目摘要
- [docs/enterprise/QUICK_START.md](docs/enterprise/QUICK_START.md) - 快速开始
- [docs/enterprise/PLUGIN_GUIDE.md](docs/enterprise/PLUGIN_GUIDE.md) - 插件开发
- [docs/enterprise/DEVELOPMENT_STANDARDS.md](docs/enterprise/DEVELOPMENT_STANDARDS.md) - 开发规范

## 🎓 学习路径

1. ✅ **已完成**: 安装依赖
2. ⏭️ **下一步**: 配置 API Key
3. 📖 阅读快速开始指南
4. 🔧 开发第一个企业插件
5. 🚀 部署到生产环境

## 📞 获取帮助

- 📖 查看文档：`docs/enterprise/`
- 🐛 提交问题：GitHub Issues
- 💬 技术支持：[待补充]

---

**恭喜！你现在可以开始使用 DSH Guard 了！** 🎊

下一步：
1. 运行 `cp .env.example .env` 配置环境变量
2. 运行 `pnpm start` 启动服务
3. 访问 `http://127.0.0.1:3080`

**祝你开发愉快！** 🚀
