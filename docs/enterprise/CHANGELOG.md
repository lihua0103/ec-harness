# 更新日志

## [2026-09-03 第二批] 红线加固与智能保持并行:窄版 pre-execute 拒绝恢复 + 专用扫描 Worker

### 决策(双重标准:数据不出域 ∧ 不降低 harness 智能)
- 恢复窄版 pre-execute 路径拒绝:只在通用工具参数**正向命中**数据集/归档/doc 外辅助 Excel 文件引用时拒绝并附改道指引;内容型参数(write/edit)、enterprise_* 车道、不可解析参数、doc 与系统输出引用全部放行——关闭 R-4 窗口的"显式读取"部分,同时不给模型增加任何误伤面
- 专用扫描 Worker(listing_scan_init):与主车道计算分进程,装载项目后只保留保护值哈希并释放全部 DataFrame(71 数据集项目实测常驻降到哈希级);通用结果扫描不再被 900 秒 run_code 阻塞(实测批量误拦根因),项目绑定成功即预热
- 值扫描补相邻 token bigram 匹配:多词值("New York" 类)按单 token 匹配必然漏报,双侧对称哈希补齐
- additionalContexts 旁路面纳入 post-execute 扫描

### 治理
- check-secrets 补真实密钥形态:智谱 32hex+尾缀、无引号 YAML/ENV 凭证赋值(键允许业务前缀);自测通过且全库无误报
- CI 落地:.github/workflows/ci.yml 在 push/PR 跑全量 check:all(含 submodule)
- `pnpm run clean:data`:opt-in 数据保留清理(会话转录/项目缓存/spill/listing 临时),--dry-run 预览、--yes 确认、--projects 清项目产物
- settings API 恢复 Origin 同源校验(纵深防御);A-1/审计欠账:ulimit 外 subprocess stdin=DEVNULL 已于第一批完成

### 回归猎杀修复(第二轮审计)
- junction/符号链接项目 PROJECT_SWITCH_DENIED 误报:TS realpathSync 与 Python Path.resolve() 对齐
- inspect 失败留粘滞封路态:绑定拆分为请求前校验+成功后提交
- 孤儿 runner 的 dsh-listing-* 残留纳入 6 小时回收
- back_link 正则补 Excel 双引号转义形态(合法排版不再 publish 失败)
- doc 文本回退链补 UTF-16 BOM 显式识别(GBK 兜底会把 UTF-16 解成乱码)
- conftest 会话状态对称性补 _session_sources

### 验证
- pytest 173 通过;listing TS 30 通过;tool-audit TS 17 通过;ui-settings TS 5 通过;lint 0 错误;check-secrets/architecture 通过

## [2026-09-03] 全系统审计收口:通用车道值级扫描立档 + doc 防洗白 + 健壮性加固

### 背景与决策
- 全系统审计发现"代码、ADR-0010、系统提示词"三方口径失配:通用车道防线实际已改为 listing 宿主 post-execute 值扫描,但 ADR/提示词仍宣称 pre-execute 路径拒绝(P0)。本次如实立档(ADR-0010 修订记录 + 决策 7 重写),不改变"两类数据值红线、其余全权交给 harness"的口径
- 新增 doc 防洗白(决策 10):会话建立时登记 doc/ 文件指纹基线,项目原始输入直接信任;会话期间新增/改写的 doc 文件出域前做保护值精确匹配,命中拒绝(PROTECTED_DOCUMENT_CONTENT)
- 红线口径不变:开关开启只拦数据集行值与 doc 外辅助 Excel 单元格值;关闭零处理;默认开启

### 安全收口
- `project` 参数 host 侧锚定:必须是存在目录的绝对路径,一个 Agent 会话绑定一个项目,拒绝换绑(PROJECT_SWITCH_DENIED)
- 内部控制工具豁免改精确名单(plan/todo_write),子串匹配曾把任意同名 MCP 工具豁免出值扫描
- Worker 崩溃/协议损坏的 stderr 片段只进宿主日志,模型侧替换为稳定码 WORKER_UNAVAILABLE
- run_code runner:stdin=DEVNULL(模型代码 input() 曾可吞掉 NDJSON 协议行)+ 840s 自杀超时(防孤儿进程与 %TEMP% PHI 残留)
- code_runner 不再透传 `_source` 属性:源头标记不可由模型重贴
- back_link 公式收紧为两参数字面量形态:=HYPERLINK(WEBSERVICE(...)) 前缀穿透已封
- ZIP 解压预算(总量 + 单成员压缩比)+ 顶层归档数量上限(200);SpreadsheetML ss:Index 列上限与文件大小上限。预算实测校准:RBQM 真实归档解压 10.2GB(72 数据集),总量上限定为 64GB,爆炸特征由压缩比检查承担
- ui-settings:恢复设置页开关与 GET/POST API(写操作须 X-DSH-Settings: 1 头,V-6 口径);开关加载即审计(event: load),落盘篡改下次启动留痕
- read_spec_files 失败回执在开关开启时不再携带异常文本;doc 文本 UTF-8 失败回退 GBK(与 CSV 一致);归档发现大小写不敏感(POSIX)

### 实测补充(2026-09-03 八项目真实链路验证后)
- SyntaxError 诊断放行:编译期错误消息只含模型自己的源码行,经白名单进入 failure() 诊断(syntax 字段)——实测大代码块无行号盲修不可行
- read_metadata 新增 compact=true 目录模式(name/path/columns/rowCount):实测大项目元数据页被宿主截断迫使模型多轮补读,compact 让全目录一页读完
- 上游 spill 落地治理(ADR-0010 R-7):listing 插件启动时回收 %TEMP%/dsh-spill-* 中超过 6 小时的目录(spill 含 doc 全量业务值,上游无清理机制)

### 缺陷修复
- run_code 冷启动时数据集部分失败被静默清零:失败清单与 inspect 口径聚合,datasetFailureCount 如实上报
- _write_audit 失败现在真正记 stderr;worker 协议层异常写 stderr 而非静默吞掉
- Excel autofilter ref 越界钳制(1,048,576 行 / 16,384 列),不再产出需修复的工作簿
- check_deps 最低版本强制生效(此前声明版本从不比对)
- tool-audit 路径分类工具预修 Windows 边角:NTFS ADS、尾点/尾空格

### 文档
- ADR-0010:决策 7 重写为值级扫描口径,新增决策 10 与修订记录(残余风险 R-4 初始化窗口/R-5 匹配精度/R-6 执行自由+出域组合);README §6、listing AGENTS.md、tool-audit docblock 同步
- .gitignore 补 /artifacts/、/tmp/、/.pytest_cache/;仓库根冒烟产物已清理

### 验证
- Python listing:173 通过(新增 doc 防洗白与 back_link 回归);listing TS:30 通过;tool-audit TS:16 通过

## [2026-08-28 终版] ADR-0010:宿主开关硬数据边界与 doc 全量分片

### 决策
- 数据安全开关由宿主设置页控制:默认开启;关闭后 listing 与通用工具均不做任何形式拦截;模型请求不能伪造
- 开启时固定两类数据值红线:SAS/XPT/CSV 数据集原始行值(含归档解出)与 `doc/` 外 spec 需求辅助 Excel 业务单元格值
- `project/doc/**` 为需求理解域:所有文件经 canonical JSON 分片按顺序完整读取,未知/二进制文件 base64 完整承载,不摘要、不截断
- 开启时 `run_code` 回执不构建 stdout/stderr、动态异常文本、输出名或列名;关闭时原始载荷照常回执;listing Python 执行面保持全开
- tool-audit 改用官方 monotonic `tools.guard()`,按路径与文件系统元数据分类;开启且受保护项目内通用 shell/terminal/code/job 通道 fail-closed,关闭后零拦截
- ui-settings 恢复 `.data-security.json` 布尔开关与设置页 toggle;扩展名配置不恢复,两类拦截对象固定

### 验证
- Python listing:148 通过;listing TS:24 通过;tool-audit TS:16 通过;ui-settings TS:5 通过
- 全仓收口门禁:`CI=true corepack pnpm run check:all` 已通过(lint、typecheck、workspace/root 测试、architecture、secrets、Python dependencies、upstream、profile verify)

## [2026-08-28 第三轮] ADR-0009:出域单点——执行面全量放开

### 决策
- 用户终裁"任何一层都不限制 harness AI 的代码执行面,唯一红线=数据行值出域"
- sandbox 删除 AST 禁用表/GuardedModule/import 白名单/builtins 白名单:标准 Python 全量可用(import os/open/eval、pd read_*/to_*)
- 出域控制点不变:sanitize_receipt 投影、dataset-guard 车道护栏、回执 120 字符上限;开关仍只管出域
- 保留:V-2 Excel 公式中和、V-3 环境白名单、V-7a 捕获上限、V-8 back_link 白名单;V-1 形态入库 commit 61dc8a9 可 revert
- 风险 R-1~R-3(宿主破坏面/stdout 行值/网络出域)显式接受,登记于 ADR-0009

### 验证
- pytest 143 全绿(160→143:24 条封堵用例退役、7 条执行自由用例新增);四包 tsc 零错误
- 同批:CHANGELOG 清除 NUL 字节(grep 恢复文本检索)

## [2026-08-28 深夜二批] FP 收口:全部修复且不误伤(ADR-0008 修订)

### 防变蠢(误伤修复)
- FP-1:to_* 前缀改枚举写出器——pd.to_datetime/to_numeric/to_list/to_numpy/to_dict 放行;to_csv 等 18 写出器仍封
- FP-3:safe_import 白名单导入器——修复 numpy/pandas C 层惰性导入断路(ndarray.sum() 实战复现);模型可正常 import re/statistics 等 17 纯计算库
- FP-2:注入 rng/datetime/json
- FP-4:dataset-guard 豁免纯写出型工具(写文档提及数据集名不再误拦)

### 记录项闭合(V-4/6/7/8)
- 回执名称 120 字符上限;设置 API X-DSH-Settings 头;捕获流 1MB 上限+truncated;stat 竞态跳过;back_link =HYPERLINK 白名单
- 勘误:V-5 带空格文件名其实命中(测试钉死);通配符刻意不拦(ls *.csv 会误伤)

### 验证
- pytest 160 全绿;四包 tsc 零错误;5 攻击链全灭 + 3 合法链全通

## [2026-08-28 深夜] ADR-0008:安全漏洞扫描批修(沙箱逃逸 RCE/公式注入/环境收敛)

### V-1【P0】沙箱 AST 黑名单被下钻链绕过(实战复现 RCE)
- 复现:`pd.io.common.os.system`(任意命令)、`pd.io.common.urlopen/get_handle`、`np.lib.npyio.DataSource`(任意读)、`os.environ`(摸环境)
- 修复:GuardedModule 运行时护栏——双下划线/read_/to_/IO 名单 + **module 类型属性整体封死**;ExcelWriter/DataSource 补入双层名单
- 复验:六条攻击链全灭;DataFrame/merge/groupby/isinstance/df.sample 零损耗

### V-2【P1】交付 Excel 公式注入
- '=' 开头模型串被 openpyxl 当公式(=WEBSERVICE 打开即外联);表名引号可逃逸 HYPERLINK
- 修复:literal_cell 铺满九处写入点 + hyperlink_formula 引号双写;设计内公式由测试精确钉死

### V-3【P1】worker 继承宿主全部环境变量
- 修复:minimalSpawnEnv 白名单(win32 11 键/POSIX 5 键)+ 强制 UTF-8

### 记录在案未改(V-4~V-9)
- 元数据隐蔽信道/护栏通配符残余/设置 API 本机无鉴权/健壮性/back_link 设计内公式/子模块封死的能力折损
- 详见 SECURITY_SCAN_20260828.md;决策记录 ADR-0008

### 验证
- pytest 153 全绿(新增逃逸链回归+公式中和 9 用例);listing tsc 零错误

## [2026-08-28] ADR-0007：数据集单规则红线 + 通用车道护栏 + 系统性缺陷修复

### 数据拦截口径（ADR-0007，用户裁决"doc/ 零拦截 + 防住真实泄露"）
- doc/ 整目录零拦截：文本与 Excel 单元格值恒全量回执（截断上限只作协议护栏并显式标记 truncated）
- 红线收敛为单规则：仅数据集（sas7bdat/xpt/csv）行值不出域（元数据白名单）
- **tool-audit 复活为通用车道护栏**：tools/pre-execute 按路径引用拒绝 shell/文件工具触碰数据集文件（防 2026-08-28 实战的 pwsh 系统 Python 绕过）；enterprise_* 车道豁免；开关感知 fail-closed；拒绝理由引导回 listing 车道
- datasetExtensions 配置单源化：ui-settings → listing worker + tool-audit 护栏（修审计 B-3 死接线）；auxExcelExtensions 废除

### 缺陷修复（PLUGIN_SYSTEM_AUDIT_20260828.md B 组）
- B-1：spawn 强制 PYTHONUTF8/PYTHONIOENCODING（中文错误不再 GBK 乱码）+ 解释器候选链 DSH_PYTHON→python3/python、Windows python→py -3（P1-4 闭合）+ windowsHide
- B-2：sandbox builtins 补异常类/dir/repr/map/filter；AST 补双下划线属性封堵（堵 pd.__dict__['read_sas'] 绕过）与 numpy/Excel 文件 IO 构造器；run_code 失败回执附 environmentHint（环境自描述）
- B-4：ui-settings 路由 disposer 收集、stop() 拆除（可卸载）
- B-5：审计写失败记日志不再静默吞
- B-6：branding 兑现 ADR-0002——validateBrandingConfig（长度/尖括号/env 兜底）、HTML 转义、结构化注入行（index-inject）、/favicon.svg 与 /manifest.webmanifest 路由（原 404）；修复客户端脚本 \b 正则在模板字面量中被转义为退格符导致短名替换失效的隐藏 bug
- B-7：设置页文案改为 ADR-0007 口径
- C-5：.data-security.json/.data-audit.jsonl 入 .gitignore
- C-6：四包 tsconfig 排除测试 + vitest --exclude lib（不再 src/lib 双跑）
- C-9：report Cover 申办方文案（"康德弘翼/WuXi"）挪 cordis.patch.yml reportCoverLabels 配置，代码内只留中性默认

### 文档
- 新增 ADR-0007；ADR-0004/0005/0006 与 DATA_GUARD_PLUGIN_DESIGN/INTERCEPTION_AUDIT 加取代/修订横幅

### 验证
- pytest 143 通过（含新增 doc/ 直通、截断标记、sandbox 封堵用例）；四包 tsc -b 零错误；Windows 侧待跑 pnpm run check:all 收口

## [2026-08-27] Multi-Sheet Excel 输出 + 自动 Submodule 初始化

### 新功能

#### 1. 临床 Listing 多 Sheet 输出规范化
- ✅ 实现多 Sheet Excel 生成（所有 listings 合并到一个文件）
- ✅ 自动 Contents 目录页（包含统计信息）
- ✅ 四种场景统一样式（manual/medical/rbqm/report）
- ✅ 系统字段自动添加（Flag, Update Details, Review Comments 等）
- ✅ 版本间变化追踪
- ✅ 现有单文件合并工具
- ✅ 一键部署脚本（支持备份回滚）

**核心文件**:
- packages/enterprise/listing/python/styles/ (样式模块)
- packages/enterprise/listing/python/worker_new.py
- packages/enterprise/listing/src/index_new.ts
- packages/enterprise/listing/deploy_multi_sheet.py

**文档**:
- docs/enterprise/LISTING_MULTI_SHEET_SPEC.md
- packages/enterprise/listing/SWITCH_PC_TESTING.md
- packages/enterprise/listing/TESTING_GUIDE.md

#### 2. 启动脚本自动 Submodule 初始化
- ✅ start.bat 现在会自动检测并初始化 upstream/deepseek-harness
- ✅ 新电脑无需手动执行 'git submodule update --init'
- ✅ 修复"官方CLI不存在"错误

**改进文件**:
- scripts/start.mjs

### 使用方法

#### 新电脑快速开始（现在更简单了！）

\\\ash
# 1. 克隆仓库
git clone https://github.com/lihua0103/ec-harness.git
cd ec-harness
git checkout feat/clinical/harness

# 2. 直接启动（会自动处理一切）
start.bat
\\\

#### 测试 Multi-Sheet 功能

\\\ash
# 生成示例模板
cd packages/enterprise/listing/python
python generate_templates.py
\\\

### 提交记录

- \d919cc\ - feat: Auto-initialize git submodule in startup script
- \36fcd85\ - docs(listing): Add testing guides for multi-sheet feature
- \787ef96\ - feat(listing): Add multi-sheet Excel output with unified styling

### 统计

- **新增代码**: ~1,400 行
- **新增文档**: ~10,000 字
- **新增文件**: 18 个
- **改进文件**: 1 个 (start.mjs)

### 下一步

1. ✅ 代码已提交到 feat/clinical/harness 分支
2. ⏳ 在新电脑上测试
3. ⏳ 完整测试四种场景
4. ⏳ 性能测试
5. ⏳ 用户验收测试
6. ⏳ 合并到主分支

### 参考文档

- **快速开始**: docs/enterprise/QUICK_START_NEW_PC.md
- **完整规范**: docs/enterprise/LISTING_MULTI_SHEET_SPEC.md
- **测试指南**: packages/enterprise/listing/TESTING_GUIDE.md

---

**分支**: feat/clinical/harness  
**最新提交**: 0d919cc
