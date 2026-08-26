# 企业设置 UI 插件

Host 侧服务与 Client 侧视图必须分离：

- Host 侧负责设置数据、权限和 RPC。
- Client 侧负责渲染，通过官方 `ui-renderer`/`ui-slots` 扩展。
- 持久化设置使用官方 settings 服务，不直接写文件。
- 影响模型可见内容的设置必须进入 Session Log 或明确标注为运行时配置。
