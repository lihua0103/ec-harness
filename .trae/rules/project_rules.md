# dsh-guard 项目规则

## 代码修改权限（最高优先级）

**AI 严格禁止自动修改以下系统流程代码：**

- `dsh-clinical-data-guard/security/**` 全部文件（沙箱、数据目录、执行器、路径策略、出域检查点）
- `src/index.js`（Node 宿主与 worker 生命周期管理）
- `dsh-clinical-data-guard/security/worker.py`（常驻 Python worker 进程）
- 任何承载核心业务流程或安全边界的模块

**禁止的配套动作：**

- 禁止 kill / restart worker 或宿主进程来强制模块重载
- 禁止申请 `danger-full-access` 等提权来绕过上述限制
- 禁止用 `git checkout` / `git restore` 等方式掩盖已发生的改动

**理由：**

1. 这些文件承载系统核心安全边界与执行流程，改错即造成数据出域或流程失效
2. worker 是常驻进程且 `sys.modules` 缓存已加载模块，磁盘打补丁不会立即生效，容易让 AI 误判"修复无效"而反复加码修改
3. 试探性打补丁在临床数据系统中不可接受，必须由人类评审后落地

**AI 遇到系统代码缺陷时的正确做法：**

1. **立即停止修改**，不要动手改文件
2. 说明问题根因：报错文案、涉及文件与行号、调用链
3. 给出建议方案的 diff 或代码片段，**只展示不执行**
4. 等待用户明确授权后，才在用户监督下实施

**例外（需用户当次明确授权）：**

- 用户明确说"修改系统代码" / "我授权改 security/" / "按你的方案落地"
- 已批准的架构重构或安全修复任务

## 临床数据归属原则

- 项目 SAS zip 的解压目录固定在**项目内** `_work/listing-*` 子目录，与项目 data 同域
- 不得解压到系统临时区（`.cache/tmp`、`%TEMP%` 等）——那是系统临时文件区，项目数据放进去即丢失归属
- 解压目录天然落在沙箱项目白名单内，`_allowed_data_dirs` 只需返回项目目录本身
- `IGNORED_DIRECTORIES` 已含 `_work`，扫描时不会把解压产物当原始输入重复索引
- 实现位置：`security/listing_data_catalog.py` 的 `DatasetCatalog.__enter__`

## 沙箱数据白名单契约

链路：`run_sandbox(allowed_data_dirs=[...])` → `job["allowedDataDirs"]` → `DatasetRegistry.set_allowed_dirs()`

- fail-closed：键缺失报 `no allowed data directories provided`；空列表或全空白报 `allowed data directories are empty or invalid`
- 数据集路径不在白名单内报 `path outside allowed directories: <name>`
- `catalog` 必须持有到 `run_sandbox` 返回后再 `close()`，否则 `rmtree` 会删掉解压数据，子进程拿到悬空路径

## 测试与验证

代码修改后运行：

```powershell
python -m pytest dsh-clinical-data-guard/tests/unit/ -v
python dsh-clinical-data-guard/tests/run_all.py
```

若命令有误，询问用户后更新本文件。
