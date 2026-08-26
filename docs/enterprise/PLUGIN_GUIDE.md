# DSH Guard 企业插件开发指南

## 插件结构

```
packages/enterprise/<plugin>/
├── package.json
├── tsconfig.json
├── cordis.patch.yml
└── src/
    └── index.ts
```

## package.json 要点

- `type`: `module`
- `name`: `@dsh-guard/<plugin>`
- `dependencies`: 按需引入 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-*`

## src/index.ts 模板

```ts
import { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context) {
  ctx.effect(() => {
    const dispose = ctx.set('myService', {
      hello() { return 'world' }
    })
    return () => dispose()
  })
}
```

## 注册插件

在 `configs/cordis.yml` 中：

```yaml
plugins:
  - id: my-plugin
    name: '@dsh-guard/my-plugin'
```

## 构建与验证

```sh
pnpm run build
pnpm start
```
