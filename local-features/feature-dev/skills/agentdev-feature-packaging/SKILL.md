---
name: agentdev-feature-packaging
description: AgentDev Feature的npm打包规范和模板引用系统。涵盖Feature作为独立npm包的完整流程：tsup构建配置、资源自动复制、模板URL生成规则、scope包处理、以及viewer-worker路由解析。当需要创建新的Feature包、调试模板404问题、或理解Feature加载机制时使用此技能。
---

# AgentDev Feature 打包与模板引用规范

本文档详细说明AgentDev Feature作为独立npm包的完整规范，基于当前框架实现总结。

## 核心原则

1. **Feature即npm包** - 每个Feature应该是一个独立的npm包
2. **依赖隔离** - Feature特有的依赖（如openai、sharp）属于Feature包，不属于消费项目
3. **tsup + copy-assets 构建** - tsup 编译所有 .ts 文件（包括 `src/templates/*.render.ts`），copy-assets 复制非 TS 资源（如 `.py`, `.mp3`, `.json`）
4. **URL统一** - 模板URL格式区分独立npm包和内置Feature

## 目录结构规范

### 独立 npm 包

```
@agentdev/my-feature/
├── package.json          # npm包配置（包含tsup配置）
├── tsconfig.json
├── src/
│   ├── index.ts          # Feature主入口
│   ├── types.ts          # 类型定义
│   ├── tools.ts          # 工具创建
│   ├── templates/        # 模板源码(.render.ts)
│   │   └── my-tool.render.ts
│   └── python/           # Python脚本或其他非TS资源
│       └── script.py
└── dist/                 # tsup构建输出
    ├── index.js
    ├── index.d.ts
    ├── templates/
    │   └── my-tool.render.js  # 编译后的模板
    └── python/            # 自动复制的资源
        └── script.py
```

### 框架内置 Feature

```
agentdev/
├── src/
│   └── features/
│       └── my-feature/
│           ├── index.ts
│           ├── types.ts
│           ├── tools.ts
│           ├── templates/
│           │   └── *.render.ts
│           └── python/       # 非TS资源
└── dist/
    └── features/
        └── my-feature/
            ├── index.js
            ├── templates/
            │   └── *.render.js
            └── python/
                └── *.py
```

## tsup 构建配置

### 独立 npm 包 package.json

```json
{
  "name": "@agentdev/my-feature",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsup && npm run copy-assets",
    "dev": "tsup --watch",
    "copy-assets": "node scripts/copy-assets.mjs",
    "prepublishOnly": "npm run build"
  },
  "tsup": {
    "entry": ["src/index.ts", "src/templates/*.render.ts"],
    "format": "esm",
    "dts": true,
    "clean": true,
    "sourcemap": true
  },
  "peerDependencies": {
    "agentdev": ">=0.1.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsup": "^8.3.5",
    "typescript": "^5.3.3"
  }
}
```

### 框架主项目 package.json

```json
{
  "scripts": {
    "build": "tsup && node scripts/generate-bin-cmds.mjs",
    "dev": "tsup --watch",
    "prepublishOnly": "npm run build",
    "create-feature": "node dist/create-feature-cli.js",
    "copy-example": "node scripts/copy-example-feature.mjs",
    "server": "node dist/cli/server.js"
  },
  "tsup": {
    "entry": [
      "src/index.ts",
      "src/cli/viewer.ts",
      "src/cli/server.ts",
      "src/features/*/templates/*.render.ts"
    ],
    "format": "esm",
    "dts": true,
    "clean": true,
    "sourcemap": true
  }
}
```

## 非 TS 资源文件处理

**重要**：tsup **不支持** `assets` 配置选项。对于需要复制非 TS 资源文件（如 `.py`, `.mp3`, `.json` 等）的 feature，需要使用 Node.js 脚本。

### 配置方式

```json
{
  "scripts": {
    "build": "tsup && npm run copy-assets",
    "copy-assets": "node scripts/copy-assets.mjs"
  }
}
```

### copy-assets.mjs 脚本

```javascript
#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src');
const distDir = join(rootDir, 'dist');

const ASSET_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac',  // Audio
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',  // Images
  '.json',  // Config files
  '.py', '.sh', '.bash', '.zsh',  // Scripts
  '.txt', '.md', '.rst',  // Docs
  '.yml', '.yaml', '.toml', '.ini',  // Config
  '.sql', '.graphql', '.gql',  // Data
  '.html', '.css', '.scss', '.less',  // Styles
  '.wasm', '.bin',  // Binary
]);

function isAssetFile(filename) {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 && ASSET_EXTENSIONS.has(filename.slice(idx).toLowerCase());
}

function copyDirectory(src, dest) {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isFile() && isAssetFile(entry.name)) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      console.log(`Copied: ${relative(rootDir, srcPath)}`);
    }
  }
}

copyDirectory(srcDir, distDir);
```

## 快速开始

### 方式1：使用 CLI 创建基础骨架

```bash
# 从任意已安装 agentdev 的项目（推荐）
npx agentdev-create-feature my-feature

# 或在 AgentDev 源码仓库内
npm run create-feature my-feature
```

生成的项目包含：
- `package.json`（已配置 tsup entry 和 copy-assets）
- `tsconfig.json`
- `src/index.ts`（基础 Feature 类框架）
- `src/templates/`（空目录，用于放置 `.render.ts` 模板）
- `scripts/copy-assets.mjs`（非 TS 资源复制脚本）
- `README.md`

**特点**：最小化骨架，需要手动填充实现

### 方式2：复制 example-feature 作为参考

```bash
# 在任何目录下
npm run copy-example ../my-features

# 完整复制 example-feature，包含：
# - 完整的 Feature 实现
# - 工具、类型定义、模板
# - 示例代码
```

**特点**：完整示例，可直接修改使用

### 方式3：在框架内直接开发

```bash
# 在 src/features/ 下创建新 feature
# 随框架一起构建，无需额外配置
```

## Feature 类实现规范

### 必需属性

```typescript
export class MyFeature implements AgentFeature {
  readonly name = 'my-feature';           // Feature名称
  readonly dependencies: string[] = [];    // 依赖的其他Feature
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = 'Feature描述';
```

### 包信息方法（必需）

```typescript
private _packageInfo: PackageInfo | null = null;

getPackageInfo(): PackageInfo | null {
  if (!this._packageInfo) {
    this._packageInfo = getPackageInfoFromSource(this.source);
  }
  return this._packageInfo;
}
```

**返回值示例**：
```typescript
{
  name: '@agentdev/my-feature',
  version: '0.1.0',
  root: 'D:/code/AgentDev/packages/my-feature'
}
```

### 模板名称方法（必需）

```typescript
getTemplateNames(): string[] {
  return ['my-tool'];  // 返回模板名称数组（不含.render.js后缀）
}
```

**无模板的 Feature**：
```typescript
getTemplateNames(): string[] {
  return [];  // Feature 没有模板
}
```

### 工具方法

```typescript
getTools(): Tool[] {
  return [createMyTool()];
}

async getAsyncTools(ctx: FeatureInitContext): Promise<Tool[]> {
  return [await createAsyncTool()];
}
```

### 生命周期钩子（可选）

```typescript
async onInitiate(ctx: FeatureInitContext): Promise<void> {
  // 初始化逻辑
}

async onDestroy(ctx: FeatureContext): Promise<void> {
  // 清理逻辑
}
```

## 模板URL生成规则

### Agent自动生成URL

在`agent.ts`中，根据`getPackageInfo()`和`getTemplateNames()`自动生成模板URL：

```typescript
const isStandalonePackage = pkgInfo.name.startsWith('@agentdev/') && pkgInfo.name !== 'agentdev';
const url = isStandalonePackage
  ? `/template/${pkgInfo.name}/${templateName}.render.js`
  : `/template/${pkgInfo.name}/${feature.name}/${templateName}.render.js`;
```

### URL格式对照

| Feature类型 | 包名示例 | 生成的URL |
|------------|----------|-----------|
| 独立npm包 | @agentdev/visual-feature | /template/@agentdev/visual-feature/capture.render.js |
| 框架内置 | agentdev | /template/agentdev/visual/capture.render.js |

**关键差异**：
- 独立npm包：不包含feature.name（因为一个包只有一个feature）
- 内置feature：包含feature.name（因为一个包有多个feature）

## viewer-worker路由解析

### 路由注册

在`viewer-worker.ts`中：

```typescript
if (url.startsWith('/template/')) {
  this.handleUnifiedTemplate(req, res, url);
  return;
}
```

### URL解析正则

```typescript
const match = url.match(/^\/template\/((?:@[^/]+\/)?[^/]+)\/(.+\.render\.js)$/);
```

**正则解释**：
- `((?:@[^/]+\/)?[^/]+)` - 匹配包名（支持scope包@scope/name）
- `(.+\.render\.js)` - 匹配模板文件名

### 解析结果示例

| URL | packageName | templateFile |
|-----|-------------|--------------|
| /template/@agentdev/visual-feature/capture.render.js | @agentdev/visual-feature | capture.render.js |
| /template/agentdev/visual/capture.render.js | agentdev | visual/capture.render.js |

### 文件查找路径

**Scope包（@agentdev/*）**：
```
{projectRoot}/node_modules/@agentdev/visual-feature/dist/templates/capture.render.js
```

**框架内置（agentdev）**：
```
{projectRoot}/dist/features/visual/templates/capture.render.js
{projectRoot}/node_modules/agentdev/dist/features/visual/templates/capture.render.js
```

## 构建和发布流程

### 开发工作流

```bash
# 1. 创建 Feature
npx agentdev-create-feature my-feature

# 2. 进入目录
cd my-feature

# 3. 安装依赖
npm install

# 4. 开发（可选：监听模式）
npm run dev

# 5. 构建
npm run build

# 6. 发布（如果需要）
npm publish
```

### 本地测试

```bash
# 在消费项目中
cd ../my-project
npm install ../my-feature

# 使用
import { MyFeature } from '@agentdev/my-feature';
```

## 常见问题排查

### 模板404错误

**检查清单**：

1. **确认 dist/templates 存在**
   ```bash
   ls -la dist/templates/
   ```
   应该只看到 .render.js、.d.ts、.js.map 文件

2. **确认 node_modules 链接正确**
   ```bash
   ls -la node_modules/@agentdev/
   ```
   应该看到符号链接指向 feature 包

3. **确认 URL 格式**
   - 独立npm包：`/template/@agentdev/my-feature/tool.render.js`
   - 内置feature：`/template/agentdev/my-feature/tool.render.js`

4. **确认模板文件存在**
   ```bash
   ls -la node_modules/@agentdev/my-feature/dist/templates/
   ```

### 资源文件没有被复制

**问题**：tsup 不自动复制非 TS 文件（如 `.py`, `.mp3`, `.json` 等）

**解决方案**：
1. 确认 `package.json` 中有 `copy-assets` 脚本
2. 确认 `scripts/copy-assets.mjs` 存在且可执行
3. 确认文件在 `src/` 目录下
4. 检查文件扩展名是否在 `ASSET_EXTENSIONS` 集合中

### 模板 .render.ts 没有编译到 dist

**问题**：`dist/templates/` 下没有 `.render.js` 文件

**原因**：tsup 只编译 entry 中声明的文件。`.render.ts` 不在静态 import 链中，必须显式加入 entry。

**检查清单**：
1. 确认 `package.json` 中 tsup entry 包含 `"src/templates/*.render.ts"`
2. 确认模板文件在 `src/templates/` 目录下且以 `.render.ts` 结尾
3. 重新构建：`npm run build`
4. 验证：`ls dist/templates/` 应看到 `.render.js` 文件

### tsup 构建失败

**常见原因**：
1. 依赖冲突 - 使用 `npm install --legacy-peer-deps`
2. TypeScript 类型错误 - 检查 agentdev 依赖路径

## 参考实现

### 独立 npm 包
- `packages/websearch-feature/` - 完整示例（含模板 + 非TS资源）
- `packages/visual-feature/` - 含模板 + Python 脚本
- `packages/shell-feature/` - 含模板（纯 TS，无 copy-assets）
- `packages/audio-feedback-feature/` - 含非TS资源（mp3，无模板）

### 框架内置 Feature
- `src/features/example-feature/` - 完整示例参考
- `src/features/websearch/` - 内置 feature 示例

### 相关源码
- `src/core/agent.ts` - URL生成逻辑
- `src/core/viewer-worker.ts` - 路由解析逻辑
- `packages/create-feature/` - CLI 工具源码（构建后打包进 agentdist/）

## 工具命令速查

| 命令 | 功能 |
|------|------|
| `npx agentdev-create-feature <name>` | 创建 Feature 骨架（任意项目） |
| `npm run create-feature <name>` | 同上（AgentDev 源码仓库内） |
| `npm run copy-example <path>` | 复制 example-feature |
| `npm run build` | 构建（主项目或独立包） |
| `npm run dev` | 监听模式构建 |
