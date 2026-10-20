# 全链路踩坑清单（pitfalls）——每条都实测翻过车

## S0 调研与语言门禁

1. **先探菜单树再定覆盖清单**：不同账号/权限可见叶子不同——先知道有多少页再定
   「打开/只高亮」策略。`enterprise_demo_survey`（menu-tree-probe.mjs）递归展开
   accordion 输出菜单树；权限不足的模块要么换账号，要么在交付说明标注缺口。
2. **语言体检用「可见性过滤的中文计数」**：隐藏 tab 里的中文不上镜可不计；ECharts
   等 canvas 文本抓不到 → 记 optionUnreadable，交付说明标注「图表标签语言未程序化验证」。
   只输出计数与元素类型，不输出中文内容（回执红线）。walk 模板内置 `cjk()` 助手。
3. **中文数据换账号消不掉**（实测两类：①数据名本身是中文模板，全库皆然、列表不可
   排序、按名过滤也筛不出英文行；②稽查弹窗记录的是历史动作内容，与当前查看账号无关）。
   处置优先级：①经批准创建英文演示数据（写入前确认模块有无删除入口——无则不可逆，
   新记录通常排列表首页，视频零过滤即纯英文）→ ②换数据源 → ③保留并标注例外。
4. **账号被占用时登录会被拒**（登录后仍停在登录页）→ **不要循环重试**（永远不会
   成功）：换不互踢的专用账号，或请用户释放后再继续。模板 loginAndEnter 返回
   rejected 时 ensureCtx 立即停手。

## S1 录制

5. **cmd `set VAR=v && cmd` 把空格并入变量** → BASE 用前必须 `.trim()`；一律 `set "VAR=v"` 引号写法。
6. **URL 拼 hash**：无尾斜杠直接拼 `#/x` 是非法 URL，`page.goto` 抛 Protocol error 且被
   catch 吞掉、整段静默停在旧页。统一 `BASE = origin+path+'/'` 再拼。
7. **菜单在已激活路由上点击不重挂载**（点了没用）；目标模块嵌在折叠子菜单时
   （仪表盘页不可见）→ 点不到就展开 `.el-sub-menu__title`，仍不行 `location.hash` 直连路由。
8. **SVGElement 没有 `.click()`**（返回箭头、卡片 More 图标）→ `fire()` 已内置 dispatchEvent 兜底。
9. **Element Plus 三定律**：el-select 须真实 click input（页面多 select 时按 input.value 定位）；
   el-dropdown 默认 hover 触发 → 先 `doAim()` 滑虚拟光标再 `locator.hover()`；
   凡真实 click/hover 前必须先 doAim，否则画面箭头不动、UI 凭空弹出（=用户看到的"不连贯"）。
10. **双语判定用"概念对"**：`[['关键过程','CriticalProcess'],…].every(对 => 任一命中)`。
    把中英文名并进一个数组再 `every` 会永假（首例 v5 首跑 warmup 229s 即此坑）。
11. **表头文本空白不稳定**（如 'RACT 版本'/'RACTVersion'）→ 匹配一律先去全部空白再比较。
12. **FINDER 文本匹配区分大小写**：`norm()` 只去空白不去大小写；大小写不定处用
    页面内正则 `/^(dev|开发)$/i` 兜底。
13. **单点互踢随时发生** → `ensureCtx()` 每段前检测登录页 → 重登+翻页+重进研究+回位；
    但**登录被拒（停在登录页）时不重试**（见 #4）。录制完成后查回执 `recoverCount`：
    >0 时确认自愈段是否落在成片范围（flashWall 之后），是则重录。
14. **点击前重定位目标**：列表轮询/数据刷新会重建 DOM，直接点 430ms 前缓存的节点会落到
    已分离的旧元素上（表现为"点了没反应"）——重定位与点击分两次 evaluate。
15. **先验证按钮是否真的有效再录**：探针确认行为——点了无反应=死按钮 → 不录；
    非 button 文本（如某处 Edit）→ 只高亮。`btnState()` 已内置 disabled/missing 探测。
16. **evaluate 包装函数传参丢失**：`const E = fn => page.evaluate(fn)` 这类只接受一个
    参数的包装，`E(fn, arg)` 的 arg 会被丢弃 → 页面收到 undefined，表现为"选择器找不到
    元素"。要传参直接写 `page.evaluate(fn, arg)`。
17. **长页/懒渲染**：图表只在滚到视口时初始化 → **先 warmup 全页滚一遍**（模板
    `scrollSteps`，找最大可滚容器分步滚并回顶）再开录，否则片头扫视拍到空图；
    万像素级长页 4 屏起步，边滚边 aim 目标带出内容。
18. **预览服务必须带 `--outDir`**：漏掉会默认服务另一套产物目录（可能是另一套构建，
    其 API 基址指向别处）→ 登录全部 `ERR_CONNECTION_REFUSED`。判别法：抓失败请求的
    **完整 URL（含端口）**。重启预览用 TaskStop 停旧进程（勿 taskkill node.exe，会连带
    杀用户的 dev server）。
19. **弹层遮罩累积会把整支视频蒙黑**：带 `before-close` 确认的抽屉只按 Escape/点 X
    关不上，且每试一次再叠一层 rgba(0,0,0,.5)。关闭链三段式：Escape blur 下拉 →
    Cancel/X → before-close 确认框点主按钮 → 轮询「可见 `.el-overlay` 数」归零
    （判据是可见遮罩数，不是抽屉 height）。**红线守卫：主按钮只点关闭确认框；含
    删除/发布/提交等破坏性词的消息框绝不点主按钮（走取消）**。
20. **幽灵下拉**：抽屉内 el-select 的下拉 teleport 到 body，抽屉卸载不带走；即便先前
    Escape 关过，关抽屉时它仍会再冒出来 → `purgeStrayPoppers()`（弹层全关后清可见
    popper）+ 每段开始前 `assertClean(tag)`。只有"弹层内真实点开过 select 下拉"的片段
    会中招（页面级下拉安全，录前 grep `.locator('input').click(` 可预判）。

## S2 锚点

21. **webm 时钟漂移非线性**（实测一轮 -0.2s → +9.1s）→ 旁白锚点只能用黑条实测，
    禁用任何墙钟/拟合方案。黑条打点（顶边 120x6 黑条 110ms）+ 掐头闪光是唯二可靠锚。
22. **blackdetect 与场景分值口径均已弃用，逐帧 signalstats 是现行法**。三个实测失效
    场景：①VFR 静止段帧稀疏把 110ms 黑条的 black_end 拉长到 0.56s/1.16s（时长不可靠，
    "时长>0.2s=闪光"会误删黑条）；②闪光帧被虚拟光标压住几个像素，场景分值掉到阈值下；
    ③黑条打在深色侧边栏上，luma 恰在 pix_th 临界。现行口径：**闪光=全帧 YAVG<40 的
    最长连续段（≥0.15s），掐头=黑出+0.1s；黑条=顶边条带（crop=120:6:0:0）YMIN<20 的
    帧簇（帧间断 ≤0.2s 归并，只留 0.03–0.35s 簇），锚点=簇起点**；闪光与黑条按时刻
    窗口排除（flash 入/出 ±0.15s），绝不按时长。**黑条阈值取 20 不取 15**：limited-range
    YUV 的纯黑 Y=16（ffmpeg drawbox 夹具），full-range 是 0（Playwright 真实录像），
    阈值须同时容纳两种，仍低于深色侧边栏的 luma。
23. **signalstats 输出解析必须按 key 过滤**：metadata=print 每帧打印 YAVG/YMIN/YMAX/
    UMIN/VMIN 一堆指标行，不按 key 过滤会把别的指标混进序列（实测翻车）。
24. **ffmpeg 过滤器参数不能带盘符绝对路径**（冒号破坏解析）——flash.txt/blips.txt/srt
    等一律用 cwd 相对路径；`-i` 输入参数不受限。
25. **亮度剖面（遮罩累积的最后一道闸）**：闪光后按 5s 桶均值统计全帧 YAVG，连续
    ≥2 桶 <60 = 弹层遮罩累积（正常弹层打开 ~150–165）→ S2 回执 `brightness.ok=false`，
    成片作废重录，不带病进 S3。

## S3 配音

26. **edge-tts 输出 mp3** → 必须经 ffmpeg 转 44.1k mono s16 wav 再铺轨；
    铺轨校验格式不匹配会抛错（这是预期守卫，不是缺陷）。
27. **node -e 多行内联在本机静默无输出**（本插件开发时两次踩中）；PowerShell 改中文
    文件有 mojibake 风险 → 逻辑改动一律写成 .mjs 文件跑。
28. **首句 `t` 与掐头耦合**：换素材/掐头变了必须同步改首句 `t`（=掐头+1.3），否则
    anchor<0 被过滤（回执出现 "N-1/N 段" 与 droppedEarly>0）。

## S4 合成

29. **libass 的 force_style 值内含逗号，必须整体用单引号包住**
    （`subtitles=captions.srt:force_style='…'`）；drawbox 先盖住顶边黑条（122x8 白块）。
    **tpad 对 VFR webm 不生效**：尾留白补齐必须 `fps=25` 在链头先转恒定帧率。
30. **验收禁目测，字幕实证法**：首帧亮度用 `signalstats YAVG`（白底≈215，黑场≈16=
    掐头失败），音频用 `volumedetect`（max≈-2dB），时长=旁白结束+≥3s 尾；字幕真实
    烧录的实证=对源视频同一帧带/不带字幕各探一次 YAVG（半透明黑盒拉低整帧 1–3，
    门槛 ≥0.4）。字幕带落位距底 ~110–190px（SRT 默认 PlayRes 缩放），手工探测条带
    别只取底部 70px。任何"打开视频看一眼"都违反回执红线。
31. **字幕实证探针必须 `-copyts`**：`-ss` 输入寻址后 ffmpeg 默认把时间戳归零，
    `subtitles` 滤镜按 pts 命中字幕事件——归零后永远落在第一条字幕之前，差值恒 0
    （表现为"字幕疑似未烧录"的假象，实测差值 2.4 与 0 一线之隔）。带/不带字幕两个
    探针都要带 `-copyts`，保证取到同一帧。

## 工程惯例

32. **timings.json 是 S2/S3 的唯一契约**：flashWall（闪光墙钟秒）必须由 walk 脚本写入；
    缺失时 S2 只能靠旧版 'ract_list'-0.9s 时序回退（新脚本一律显式写 flashWall）。
33. **锚点 key 命名**：段落级 `tab_*`、动作级 `<前缀>_<动作>`（cp_/cd_/rd_…）；
    S3 旁白的 at 必须与 act('key') 完全一致，拼写错=该段被静默跳过（narrate 回执
    missingAnchors 会点名）。
34. **cmd 同行 `set FF=... && %FF% ...` 解析期展开为空** → 命令拆行或写完整路径；
    `findstr` 过滤会吞掉报错行、且过滤中文输出返回非零码（**假失败**）→ 失败排查
    必须无过滤重跑。
