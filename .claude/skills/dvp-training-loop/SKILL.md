---
name: dvp-training-loop
description: 方案→DVP 蒸馏训练循环（桥接模型读全部文档，执行会话只看统计量）。新训练项目起跑/续跑/验收/复盘时使用。铁律：执行会话不读真实目录文档正文；一切读取由工作台桥接模型执行；goal 简洁、回复单行 done/blocked。通用标准正文对任何 agent（Claude Code / zcode 等）可执行。
user-invocable: true
---

# DVP 蒸馏训练循环

**规范正文（唯一事实源）：[docs/DVP-TRAINING-LOOP-STANDARD.md](../../../docs/DVP-TRAINING-LOOP-STANDARD.md)** —— 读取并严格照做；正文是通用版，对任何具备文件读写与 HTTP 能力的 agent（Claude Code、zcode 及其他编辑器）可执行。

执行前先做正文「4. 环境适配」的占位映射，再按「1. 前置检查」起跑。

## 三条不可绕过的铁律（摘要，以正文为准）

1. 【仅数据安全开关开启时】执行会话永不读取真实项目目录的临床文档正文（方案/ALS/DVP 规则内容、样例值、人名不入上下文）；只允许文件名、sheet 名、行列数、字节级表头/标签行、统计量。开关与模型无关：`node .runtime/data-boundary.cjs status` 查看（`.runtime/data-boundary.json` 的 `dataSecurity`）。开关关闭（2026-11-24 起的当前状态）时本条不适用，执行会话可直接读取。
2. 一切文档内容读取由工作台桥接模型执行，中间产物磁盘→磁盘；goal 回复必须单行 `done: <n>` / `blocked: <码>`，并禁止 ask_user_question。
3. 验收只认落盘文件与 runs 存储的机械对账（行数/多重集/字节），模型自报不可信；未全绿不得报合规。

本 skill 不复制正文内容；正文与本文件只允许一个写入负责人（改规则去改 docs 正文）。
