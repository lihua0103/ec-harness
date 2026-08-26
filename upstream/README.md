# Official Upstream

该目录预留给 Git submodule：`upstream/deepseek-harness`。

初始化：

```sh
git submodule update --init --depth 1
```

企业代码不得写入该目录。企业插件必须通过以下方式之一进入官方运行时：

1. 企业私有 npm registry 发布 `@dsh-enterprise/*` 包；
2. 将企业插件 workspace 显式链接到官方 Profile 的插件目录；
3. 使用官方支持的 `dsh plugin` 机制安装到企业 Profile。
