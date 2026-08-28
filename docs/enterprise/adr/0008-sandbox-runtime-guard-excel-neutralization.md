# ADR-0008: 沙箱运行时护栏、Excel 公式中和与 worker 环境收敛

- 状态:已实施(2026-08-28;同日深夜修订见文末)
- 日期:2026-08-28
- 负责人:企业插件组
- 影响范围:listing python(sandbox/excel 层)、listing TS(worker.ts)
- 关联:ADR-0007(单规则红线与车道护栏)、SECURITY_SCAN_20260828.md(漏洞证据与复验)

## 背景

ADR-0007 当晚的颗粒级漏洞扫描(实战探针复现)发现:AST 黑名单式的执行安全
挡不住"逐个属性都合法"的下钻链——`pd.io.common.os.system` 达成任意命令
执行、`pd.io.common.urlopen/get_handle` 与 `np.lib.npyio.DataSource` 达成
项目根外任意文件读、`pd.io.common.os.environ` 可摸宿主环境变量;worker 进
程还整份继承了宿主环境(凭据暴露面)。另发现交付 Excel 存在公式注入面:
'=' 开头的模型串被 openpyxl 推断为公式,outputs 键名中的引号可打破
Content 页 HYPERLINK 字符串。

## 决策

1. **GuardedModule 运行时护栏**(sandbox.py):pd/np 经包装类进入命名空间——
   双下划线属性、read_/to_ 前缀、IO 名单(ExcelWriter/ExcelFile/DataSource/
   get_handle/urlopen/...)拒绝;**一切 module 类型的属性一律拒绝**
   (pd.io/np.lib/pd.compat 等子模块树是全部已知逃逸链的公共入口;
   listing 计算只需顶层 API)。AST 编译期检查保留为第一层。
2. **Excel 字面量写入**(excel 层):`literal_cell()` 铺满九处模型/数据可
   控写入点('=' 开头强制 data_type='s');`hyperlink_formula()` 对表名引号
   双写转义;Content 跳转与业务页返回链接两个设计内公式由测试精确断言。
3. **worker 环境白名单**(worker.ts):spawn 只继承解释器启动刚需变量
   (win32: PATH/SYSTEMROOT/SYSTEMDRIVE/COMSPEC/PATHEXT/WINDIR/TEMP/TMP/
   APPDATA/LOCALAPPDATA/USERPROFILE;POSIX: PATH/LANG/LC_ALL/TMPDIR/HOME)
   + PYTHONUTF8/PYTHONIOENCODING。
4. 接受并记录(不改代码):元数据隐蔽信道 V-4、护栏正则残余 V-5、设置 API
   本机无鉴权 V-6、健壮性 V-7、设计内 back_link 公式通道 V-8——见
   SECURITY_SCAN_20260828.md §二。

## 不采用的方案

- **继续枚举属性黑名单**:V-1 证明枚举不可收敛;封死"module 类型属性"这一
  逃逸公共入口比追名单可靠。
- **对 pd/np 做顶层 API 白名单**:穷举合法科学计算面违背"别把 AI 变蠢"
  (ADR-0007 精神),黑名单+子模块封死已达成同等强度且零能力损耗
  (DataFrame/merge/groupby/isinstance/df.sample 探针全过)。
- **进程级隔离(seccomp/容器)替代**:属 harness 部署层能力,插件层保持
  当前纵深即可。

## 数据与安全

- 执行安全护栏(本 ADR)与数据红线(ADR-0007)相互独立、恒生效、不受开关影响。
- 能力折损(记录):np.random/pd.errors 等子模块被封;`df.sample()` 等
  DataFrame 方法面不受影响。

## 升级影响

纯 listing 包内变更;lib/ 自动重建;装配与 profile 不动。

## 验证

pytest 153 全绿(新增六条逃逸链回归、护栏零损耗、公式中和三用例);
全部攻击探针修复后复验全灭(SECURITY_SCAN_20260828.md §一/§四);
Windows 侧以 check:all 收口。


---

## 修订(2026-08-28 深夜):FP 收口与剩余项闭合

用户指令:"全部修复,且不要误操作拦截导致 harness AI 变蠢。"据此:

1. **FP-1 写出器枚举化**:AST/运行时的 `to_` 前缀阻断改为枚举写出器名单(18 个)——`pd.to_datetime/to_numeric/to_list/to_numpy/to_dict` 等纯转换函数放行;`read_` 前缀保留(无合法需求)。
2. **FP-3 白名单安全导入器**:`SANDBOX_BUILTINS["__import__"] = safe_import`。动因:实战复现 numpy/pandas 的 C 层惰性导入(如 `numpy._core._methods`)取**当前帧 builtins** 的 `__import__`,缺失即 KeyError 断合法 API。白名单 = numpy/pandas 家族(返回 GuardedModule,子模块/IO 面照拦)+ 17 个纯计算标准库;其余清晰 ImportError。
3. **FP-2 能力注入**:`rng`(Generator 实例)、`datetime`、`json` 进命名空间。
4. **FP-4 护栏豁免**:dataset-guard 对纯写出型工具(write/edit/apply_patch 等)豁免——参数是模型→磁盘方向,提及数据集文件名不构成泄露;读取型与未知名保持拦截。
5. **V-4/6/7/8 闭合**:回执名称 120 字符机械上限;POST 加 X-DSH-Settings 头;捕获流 1MB 上限+truncated 标记;list_files stat 竞态跳过;back_link 白名单 =HYPERLINK 形态。V-5 勘误:带空格文件名其实命中正则(已测试钉死);通配符刻意不拦(ls *.csv 会误伤)。
6. **刻意不做**:run_code 进程内墙钟(重计算合法需要分钟级,加了必误伤,TS 900s 兜底已够)。

验证:pytest 160 全绿;双面探针(5 攻击链灭 + 3 合法链通)复验。详见 SECURITY_SCAN_20260828.md §五。
