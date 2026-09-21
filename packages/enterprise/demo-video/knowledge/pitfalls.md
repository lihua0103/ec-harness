# 全链路踩坑清单（pitfalls）——每条都实测翻过车

## S1 录制

1. **cmd `set VAR=v && cmd` 把空格并入变量** → BASE 用前必须 `.trim()`；一律 `set "VAR=v"` 引号写法。
2. **URL 拼 hash**：无尾斜杠直接拼 `#/x` 是非法 URL，`page.goto` 抛 Protocol error 且被
   catch 吞掉、整段静默停在旧页。统一 `BASE = origin+path+'/'` 再拼。
3. **菜单在已激活路由上点击不重挂载**（点了没用）；目标模块嵌在折叠子菜单时
   （仪表盘页不可见）→ 点不到就展开 `.el-sub-menu__title`，仍不行 `location.hash` 直连路由。
4. **SVGElement 没有 `.click()`**（返回箭头、卡片 More 图标）→ `fire()` 已内置 dispatchEvent 兜底。
5. **Element Plus 三定律**：el-select 须真实 click input（页面多 select 时按 input.value 定位）；
   el-dropdown 默认 hover 触发 → 先 `doAim()` 滑虚拟光标再 `locator.hover()`；
   凡真实 click/hover 前必须先 doAim，否则画面箭头不动、UI 凭空弹出（=用户看到的"不连贯"）。
6. **双语判定用"概念对"**：`[['关键过程','CriticalProcess'],…].every(对 => 任一命中)`。
   把中英文名并进一个数组再 `every` 会永假（首例 v5 首跑 warmup 229s 即此坑）。
7. **表头文本空白不稳定**（如 'RACT 版本'/'RACT版本'）→ 匹配一律先去全部空白再比较。
8. **单点互踢随时发生** → `ensureCtx()` 每段前检测登录页 → 重登+翻页+重进研究+回位。
9. **点击前重定位目标**：列表轮询/数据刷新会重建 DOM，直接点 430ms 前缓存的节点会落到
   已分离的旧元素上（表现为"点了没反应"）——重定位与点击分两次 evaluate。

## S2 锚点

10. **webm 时钟漂移非线性**（实测一轮 -0.2s → +9.1s）→ 旁白锚点只能用黑条实测，
    禁用任何墙钟/拟合方案。黑条打点（顶边 120x6 黑条 110ms）+ 掐头闪光是唯二可靠锚。
11. **blackdetect 日志格式**是 `black_start:` 而非 `picture_black_start:`；
    **ffmpeg 过滤器参数不能带盘符绝对路径**（冒号破坏解析）——flash.txt/srt 等一律用
    cwd 相对路径；`-i` 输入参数不受限。
12. **闪光与打点黑条都表现为顶边黑色事件，但时长不可靠**：VFR（可变帧率）webm 在
    画面静止段帧稀疏，black_end 会被拉到下一个变化帧——实测一条 110ms 黑条被记成
    0.56s/1.16s 事件。因此**不能按"时长 >0.2s=闪光"排除**（会把被拉长的黑条一起丢掉），
    必须按时刻排除：用场景检测得到的闪光入/出时刻做窗口过滤；锚点取 black_start
    （首个黑帧时刻，可靠），不取中点。

## S3 配音

13. **edge-tts 输出 mp3** → 必须经 ffmpeg 转 44.1k mono s16 wav 再铺轨；
    铺轨校验格式不匹配会抛错（这是预期守卫，不是缺陷）。
14. **node -e 多行内联在本机静默无输出**；PowerShell 改中文文件有 mojibake 风险 →
    逻辑改动一律写成 .mjs 文件跑。

## S4 合成

15. **烧字幕**：libass 的 force_style 值内含逗号，必须整体用单引号包住
    （`subtitles=captions.srt:force_style='…'`）；drawbox 先盖住顶边黑条（122x8 白块）。
16. **验收禁目测**：首帧亮度用 `signalstats YAVG`（白底≈215，黑场≈16=掐头失败），
    音频用 `volumedetect`（max≈-2dB），时长=旁白结束+≥3s 尾。任何"打开视频看一眼"
    都违反回执红线。

## 工程惯例

17. **timings.json 是 S2/S3 的唯一契约**：flashWall（闪光墙钟秒）必须由 walk 脚本写入；
    缺失时 S2 只能靠旧版 'ract_list'-0.9s 时序回退（新脚本一律显式写 flashWall）。
18. **锚点 key 命名**：段落级 `tab_*`、动作级 `<前缀>_<动作>`（cp_/cd_/rd_…）；
    S3 旁白的 at 必须与 act('key') 完全一致，拼写错=该段被静默跳过（narrate 回执
    missingAnchors 会点名）。
