# 渲染模板指南

## 模板系统的目的

模板主要服务于调试查看器，让工具调用和结果以更适合 agent / 人类排查的方式展示。

对当前 AgentDev 来说，模板不是锦上添花；如果一个 Feature 会长期使用，模板通常值得一起补上。

## 两类模板

| 类型 | 位置 | 导出方式 |
|------|------|----------|
| Feature 模板 | `src/features/*/templates/*.render.ts` | `export default` |
| 系统模板 | `src/tools/**` 下的集中模板文件 | `export const TEMPLATES` |

Feature 开发时，优先关注第一类。

## Feature 模板示例

```typescript
// 内置 Feature 中使用相对路径：
import type { InlineRenderTemplate } from '../../../core/types.js';
// 独立 npm 包中改为：
// import type { InlineRenderTemplate } from 'agentdev';

function escapeHtml(text: unknown): string {
  const str = String(text ?? '');
  return str.replace(/[&<>\"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\"': '&quot;',
    '\'': '&#39;',
  }[ch]!));
}

const myToolRender = {
  call: (args: { input?: string }) => `
    <div class="tool-call">
      <strong>输入:</strong> ${escapeHtml(args.input)}
    </div>
  `,
  result: (data: unknown, success?: boolean) => `
    <div class="${success ? 'tool-result' : 'error'}">
      ${escapeHtml(typeof data === 'string' ? data : JSON.stringify(data))}
    </div>
  `,
} as const satisfies InlineRenderTemplate;

export default myToolRender;
```

## 在 Feature 里注册模板

```typescript
import type { PackageInfo } from 'agentdev';
import { getPackageInfoFromSource } from 'agentdev';
import { fileURLToPath } from 'url';

const source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

private _packageInfo: PackageInfo | null = null;

getPackageInfo(): PackageInfo | null {
  if (!this._packageInfo) {
    this._packageInfo = getPackageInfoFromSource(this.source);
  }
  return this._packageInfo;
}

getTemplateNames(): string[] {
  return ['my-tool'];
}
```

注意：

- 只返回模板名称数组（不含 `.render.js` 后缀）
- 框架根据 `getPackageInfo()` 自动生成完整的 URL
- 独立 npm 包和内置 feature 的 URL 格式不同

## 工具里引用模板

```typescript
render: { call: 'my-tool', result: 'my-tool' }
```

## 当前模板加载认知

对 Feature 开发来说，真正需要记住的只有两件事：

1. `getTemplateNames()` 返回模板名称数组
2. 框架根据包信息自动生成 URL 并由 viewer 加载

模板 URL 格式：
- 独立 npm 包：`/template/@agentdev/my-feature/tool.render.js`
- 内置 feature：`/template/agentdev/my-feature/tool.render.js`

不必把 skill 写成 viewer 内部实现手册，但要知道排错时可沿着这条链找。

## 模板命名建议

推荐：

- 工具名：`my_tool`
- 模板名：`my-tool`
- 模板文件：`my-tool.render.ts`

这是约定，不是自动转换机制。

## 什么时候值得拆两个模板

适合拆成不同 call/result 模板：

- 调用参数和结果结构明显不同
- 结果展示需要更强格式化

如果只是普通工具，call/result 共用同一模板名通常就够了。

## 常见坑

### 1. 模板文件没编译

先确认 tsup entry 包含 `"src/templates/*.render.ts"`，再确认是否执行过 `npm run build`。如果前端回退成 JSON，通常是模板未进入 dist。

### 2. `getTemplateNames()` 返回了错误的名称

模板名必须和工具的 `render` 配置一致（不含 `.render.js` 后缀）。

### 3. 导出格式错了

Feature 模板要 `export default`，不是 `TEMPLATES`。

### 4. URL 404

检查：
- 独立 npm 包的 dist/templates/ 目录是否存在
- node_modules 链接是否正确
- URL 格式是否符合包类型（scope 包 vs 普通包）

### 5. 模板里假定了错误的数据结构

模板的 `call` 读的是工具参数，`result` 读的是工具结果。先看真实返回值，再写字段名。

## 调试时怎么想

如果渲染异常，优先按这个顺序查：

1. 工具 `render` 配置是否正确
2. `getTemplateNames()` 是否返回了对应模板名
3. `getPackageInfo()` 是否正确返回包信息
4. 编译产物是否存在（dist/templates/）
5. 模板导出格式是否正确
6. 模板函数访问的数据字段是否真的存在
