# zip 密码自动推导规则（对齐 dsh listing 插件 archive_passwords.py）

来源：`packages/enterprise/listing/python/archive_passwords.py::password_candidates`。
骨架 `password_candidates()` 已按同一顺序实现，这里记录规则本身与注意事项。

## 候选顺序（去重后按序尝试）

1. **显式密码**（用户/credentialRef 给定；空则跳过）
2. **项目目录名** 及其分词：全名、去扩展名 stem、按 `_ / - . 空格` 切分的
   长度≥2 片段、stem 中的连续数字段（`\d{2,}`）
3. 项目名**相邻 token 组合**：相邻 2~N 个 token 用 `""` / `"_"` / `"-"` 连接
4. **zip 同目录所有 `*.txt` sidecar** 的内容（逐行 strip；ADR-0003 决策4 的
   `<归档名>.txt` 就是其中之一）
5. **zip 文件名** 及其分词、相邻组合
6. 项目目录下所有 `.txt / .xlsx / .xls` 文件的 **stem**
7. **无密码**（兜底放最后）

## 尝试与判定

- 每个候选用系统 `unzip -P <候选> -o <zip> -d <目录>`，返回码 0 **且** 解压出
  的 `.sas7bdat` 数 > 0 才算成功（防 ZipCrypto 误通过后拿到空结果）。
- 无密码候选放在最后：对未加密 zip 任何 `-P` 都会成功，顺序不影响；
  对加密 zip，前序候选失败后自然落到它并最终报错。
- 全部失败：报"Archive credential was not resolved"语义的中文错误，并列出
  已尝试候选数，提示用户确认密码或提供 sidecar txt。

## 注意

- 系统 `unzip` 只支持 **ZipCrypto**；**AES** 加密 zip 需 7-Zip 或
  Python `pyzipper`（插件原实现用 pyzipper）。遇到 AES 报错时提示用户
  转存为 ZipCrypto 或提供明文密码由服务器 7z 处理。
- Windows 本机无系统 unzip：加密包只能在服务器跑，骨架已做对应提示。
- 密码明文不出现在任何输出/日志中（只输出候选个数）。
