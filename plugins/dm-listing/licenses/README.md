# 版本化许可正文（licenses/）

本目录存放进入 `THIRD-PARTY-NOTICES.txt` 的第三方许可**正文**，使候选包构建不再依赖可变的
`node_modules` 内容（重装依赖不会丢失许可修复，不同机器构建结果一致）。

- 命名：`<包名中的 / 替换为 +>@<精确版本>.txt`，例如 `@nodable+entities@3.1.0.txt`。
- 内容：对应精确版本上游包 LICENSE 正文的逐字节副本（`cmp` 校验一致）。
- 新增条件：安装包缺少许可正文文件时必须在此补齐；正文须人工审阅后方可入库，
  包元数据（`license` 字段等）不能替代正文。
- 冲突处理：若安装包正文与本目录版本不一致，构建在 release manifest 记录
  `LICENSE_TEXT_CONFLICT` 并保持 distribution 阻断，直至人工复核。
