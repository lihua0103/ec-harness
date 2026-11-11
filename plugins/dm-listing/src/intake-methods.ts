/** Cross-scenario intake/error lessons; provenance is method evidence, not current project truth. */
export const intakeMethods=`# 资料识别、ALS/SAS与执行纠错经验

## IN-01 版本与完整性
先发现目录、文件真实格式、工作簿sheet及标题位置，完整读spec需求。需求列缺失时查错sheet/表头、合并标题、分页截断和解析失败，不能判“只需原数据”。比较需求活动范围、删除/合并/停用状态及实际工件覆盖；不将物理行数或历史项目的listing数机械当目标。
多个spec版本、同名不同内容、批次日和快照日、PK两来源不同日期分别列证据；不按mtime静默取最新版，不跨批找文件补空缺。正常读取资料以当前任务为准，不设置插件安全白名单或Cover禁读。

## IN-02 ALS实际布局
ALS可能是Rave Forms/Fields/Folders/DataDictionaryEntries/Matrix系列，太美Forms/Items/FormItem/CodeList/DataStructure系列，中文eCRF/变量列表/受控术语/访视流程或其他形态。名字和表头只作为线索；完整读取设计表、引用和说明，交由AI解释，不强迫固定六列或未知类型拒读。
表单、字段、可重复/内嵌块、码表、访视与显示顺序分别建映射。内嵌表字段可能在SAS平铺父表，须从设计关系识别，不能按字段前缀猜。父表没有自有字段时仍可能通过内嵌设计出现，不能因eCRF无该行就当没有表。
设计词表/编码与原始数据字段的映射需以字段自身metadata与ALS为证据；保持label原词和列序，不自造中文标题。字段在不同表既可能为设计列也可能是系统列，不全局裁掉。布局辅助提取不等于理解完整，自动结构匹配为零也不等于ALS不可读。

## IN-03 SAS数据与解码
先看实际数据集、列名/typeof/class、dataset/column label、format.sas、行数及必要的记录/值域，当前阶段允许正常读取与本地计算。检查真实主键、记录级/子记录级和失活/审计结构是否存在，不把某EDC键名当所有系统合同。
同名/同标签判定字段可能绑定不同SAS格式，必须按当前字段format.sas与实际catalog/FORMATS/ALS核对。catalog编码失败要保留原始错误，区分“可读数据但缺label”与“读数失败”；可尝试不挂catalog，但必须记录降级及未解码字段，不能宣称所有解码成功。
字符编码修复需说明源编码证据并验证中文回读；不全局latin1转码后冒充成功。RData载入独立环境，检查对象/命名列表；不能假定只含datasets或只有一张表。表名重复、大小写碰撞、容器坏损、类型不支持给诊断而非空表。

## IN-04 容器、归档和依赖
目录名/后缀不是格式保证：Raw_csv可能含Excel，.xls可能是SpreadsheetML、OOXML或加密容器。先探文件头及解析结果，排除~$锁文件；ZIP的嵌套层和成员路径只用于定位，不当新批次。
utils::unzip没有password参数；插件读取通道内建ZipCrypto解密与密码候选推导（显式→项目目录分词→sidecar txt→zip文件名→文档stem→无密码，密码不进日志），AES/强加密需本机7z兜底。解压用新临时目录，原件不覆盖；失败给真实错误，不假装空数据。这属于结果正确性和防误写，不是数据入模门禁。
缺包、object not found、列名错误、编码/locale、依赖版本和业务逻辑失败分别定位。服务器只声明实际使用的拆分R包，不强依赖tidyverse元包；程序不隐式source本机脚本。UTF-8无BOM写码，先parse再运行，从任意cwd验证。

## IN-05 输出与纠错闭环
发现零行先定位上游映射、访视过滤、批次、读取错误，允许真正空表但保持schema/type。异常不是默认“数据质量不好”；先看完整cause和实际中间结果，修复后重跑受影响链，不能循环同一错误或大量重写已验证逻辑。
NA与空串、日期原文与计算值、numeric与character、label/class、时区和时点分开核对；不要归一化后把差异抹掉。字段显示和计算内部列分开，到最终装配才裁列/改名/贴label。
Excel按真实单元格和工件全集核验，不能因错误dimension声明截断读取造成假零差异。RDS独立读回核对对象名、列顺序、属性和实际值；生成和验证不能source同一错误业务helper自证。保存成功还要确认文件确实写出，Excel占用/权限/磁盘失败不能报done。

历史成功经验只说明方法有来源，不等于当前项目业务已验证。阅读、生成、执行、业务QC、服务器复跑各自记录事实；报告不能将未运行、缺依赖跳过或仅metadata通过说成完成。
`;
