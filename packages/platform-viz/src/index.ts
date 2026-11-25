/**
 * 平台图表管线公共包：规格/目录/选项/样式/布局/渲染/验收、设计稿运行态提取与配对、
 * 设计稿编译、说明文字画布重绘、配置存储、工作表导入、交付封存、文本测宽、
 * RBQM 落位执行通道（HTTP 客户端，transport 可注入做本地合同测试）、
 * 最小 xlsx 写入（给外部系统建表用）。
 *
 * 纯核心：不含宿主工具注册与页面业务；共享代码按「公共包拆分时机」条款在出现
 * 第二个消费插件时平移进来。业务插件按仓库约定以相对路径引入本包（esbuild 内联），
 * 不引入其他插件源码。
 */
export * from './errors.js';
export * from './spec.js';
export * from './catalog.js';
export * from './option.js';
export * from './style.js';
export * from './plan.js';
export * from './render.js';
export * from './accept.js';
export * from './design.js';
export * from './design-compile.js';
export * from './design-notes.js';
export * from './store.js';
export * from './xlsx.js';
export * from './deliver.js';
export * from './text.js';
export * from './rbqm-http.js';
export * from './xlsx-write.js';
