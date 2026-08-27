# 企业插件参数定义修复报告

## 修复时间
2026-08-26 15:00

## 问题描述

### UI 异常现象
- AI 调用 \nterprise_listing_inspect\ 工具时持续报错："project is required"
- 参数明明已传递，但工具无法接收

### 根本原因
工具参数定义不符合 **JSON Schema** 标准格式，导致 Cordis 框架无法正确解析参数。

## 修复内容

### 文件：packages/enterprise/listing/src/index.ts

#### 修复前（❌ 错误格式）
\\\	ypescript
const parameters = {
  project: { type: 'string', required: true, description: '...' },
  scenario: { type: 'string', description: '...' }
}
\\\

**问题点**：
1. 缺少顶层 \	ype: 'object'\
2. 缺少 \properties\ 包装层
3. \equired\ 错误地定义在字段内部
4. 不符合 JSON Schema 对象规范

#### 修复后（✅ 正确格式）
\\\	ypescript
const parameters = {
  type: 'object',
  properties: {
    project: { 
      type: 'string', 
      description: '当前会话工作区内的相对项目目录' 
    },
    scenario: {
      type: 'string',
      description: '可选；medical / rbqm / manual / report，省略时由规格文档文件名自动推断'
    }
  },
  required: ['project']
}
\\\

### 受影响的工具
1. ✅ \nterprise_listing_inspect\ - 已修复
2. ✅ \nterprise_listing_run_code\ - 同步修复

## 代码扫描结果

对所有企业插件进行了全面扫描：

| 插件名 | 状态 | 说明 |
|--------|------|------|
| listing | ✅ 已修复 | 工具参数定义已更正 |
| auth | ✅ 正常 | 无工具注册 |
| branding | ✅ 正常 | 无工具注册 |
| tool-audit | ✅ 正常 | 无工具注册 |
| ui-settings | ✅ 正常 | 无工具注册 |

**结论**：无其他类似问题

## 验证步骤

1. ✅ 修改源代码 (src/index.ts)
2. ✅ 重新编译 (\
pm run build\)
3. ✅ 验证编译产物 (lib/index.js)
4. ✅ 停止旧服务进程 (PID 20412)
5. ✅ 重启 harness 服务 (新 PID 12996)
6. ✅ 扫描所有企业插件代码

## 服务状态

- **服务地址**: http://127.0.0.1:3080
- **进程 PID**: 12996
- **状态**: ✅ 运行中，已加载修复后的代码

## 后续操作

请在浏览器中：
1. **刷新页面** (F5 或 Ctrl+R)
2. **重新测试** \nterprise_listing_inspect\ 工具
3. **预期结果**: project 参数能正确传递，不再报错

## 技术要点

### JSON Schema 对象类型标准格式

\\\	ypescript
{
  type: 'object',              // 1. 声明对象类型
  properties: {                // 2. 属性定义容器
    field1: {
      type: 'string',
      description: '...'
    },
    field2: {
      type: 'number',
      description: '...'
    }
  },
  required: ['field1']         // 3. 必填字段数组
}
\\\

### 关键规则
- \	ype\ 必须在顶层声明
- 所有字段定义必须在 \properties\ 内
- \equired\ 是顶层数组，包含必填字段名列表
- 字段定义内不写 \equired: true\

---
**修复完成** ✅
