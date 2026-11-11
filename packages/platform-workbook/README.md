# @ec-clinical/platform-workbook

业务插件共用的 OOXML/Excel 读取基础包，不含 Listing/DVP 的任何业务分类、读取拒绝或输出合同。

- `Workbook.open(buffer, observe?)`：按需读取 zip 条目；发现 sheet 时不打开 worksheet/sharedStrings。
- `listSheets`、`readWorksheet`、`readSheet`、`readRegion`、`readOutputTable`。
- 错误统一为 `WorkbookError(code)`；调用方按 code 处理，不依赖业务插件错误类。
- 资源上限、路径遍历/外部引用/公式缓存值等正确性规则保留；数据安全授权由平台与 IT 入口承担。

业务插件通过相对源码路径引用，由 esbuild 捆绑进各自 host bundle；发布清单须包含本包源码摘要。

```bash
cd packages/platform-workbook && pnpm install
```

```bash
cd packages/platform-workbook && PATH="/d/package/Nvm/nvm/v24.9.0:$PATH" npm run typecheck
```