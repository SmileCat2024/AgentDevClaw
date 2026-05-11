# AgentDev Feature 打包实现详解

## 1. 模板URL生成完整流程

### 1.1 Agent端URL生成

位置：`src/core/agent.ts` 第395-446行

```typescript
// 收集 Feature 模板信息（使用新的统一方式）
const featureTemplates: Record<string, string> = {};

for (const feature of this.features.values()) {
  // 优先使用新的 getPackageInfo() + getTemplateNames() 方式
  if (feature.getPackageInfo && feature.getTemplateNames) {
    const pkgInfo = feature.getPackageInfo();
    const templateNames = feature.getTemplateNames();

    if (pkgInfo && templateNames.length > 0) {
      for (const templateName of templateNames) {
        // 构建统一的 URL 格式
        // 独立 npm 包（@agentdev/*）不包含 feature.name
        // 内置 feature 使用 /template/{packageName}/{featureName}/{templateName}.render.js
        const isStandalonePackage = pkgInfo.name.startsWith('@agentdev/') && pkgInfo.name !== 'agentdev';
        const url = isStandalonePackage
          ? `/template/${pkgInfo.name}/${templateName}.render.js`
          : `/template/${pkgInfo.name}/${feature.name}/${templateName}.render.js`;
        featureTemplates[templateName] = url;
      }
    }
  }
  // 回退到旧的 getTemplatePaths() 方式（向后兼容）
  else if (feature.getTemplatePaths) {
    // ... 旧的路径解析逻辑
  }
}
```

**关键判断条件**：
- `pkgInfo.name.startsWith('@agentdev/')` - scope包前缀
- `pkgInfo.name !== 'agentdev'` - 排除框架主包

### 1.2 featureTemplates传递给DebugHub

```typescript
this.agentId = this.debugHub.registerAgent(
  this,
  name || this.constructor.name,
  featureTemplates,  // 模板URL映射
  this.buildHookInspectorSnapshot(),
  this.buildOverviewSnapshot()
);
```

### 1.3 前端获取模板URL

前端通过DebugHub MCP或Web UI获取featureTemplates，格式：

```typescript
{
  "capture": "/template/@agentdev/visual-feature/capture.render.js",
  "bash": "/template/@agentdev/shell-feature/bash.render.js"
}
```

## 2. viewer-worker路由解析

### 2.1 路由分发

位置：`src/core/viewer-worker.ts` 第285-289行

```typescript
// 统一的 Feature 模板路由（新格式：/template/{packageName}/{templateName}.render.js）
if (url.startsWith('/template/')) {
  this.handleUnifiedTemplate(req, res, url);
  return;
}
```

### 2.2 handleUnifiedTemplate实现

位置：`src/core/viewer-worker.ts` 第1645-1719行

```typescript
public handleUnifiedTemplate(req: IncomingMessage, res: ServerResponse, url: string): void {
  try {
    // 解析 URL: /template/{packageName}/{templateName}.render.js
    // 支持普通包名和 scope 包名（@scope/name）
    const match = url.match(/^\/template\/((?:@[^/]+\/)?[^/]+)\/(.+\.render\.js)$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid template path format');
      return;
    }

    const [, packageName, templateFile] = match;
    const templateFileTs = templateFile.replace('.render.js', '.render.ts');

    // 获取当前 Agent 的项目根目录
    const currentSession = this.currentAgentId ? this.agentSessions.get(this.currentAgentId) : undefined;
    const projectRoot = currentSession?.projectRoot || process.cwd();

    // 构建可能的文件路径（按优先级）
    const searchPaths: string[] = [];

    // 1. 外部 npm 包（包括 scope 包）
    if (packageName.startsWith('@')) {
      // scoped package: @scope/name
      searchPaths.push(
        join(projectRoot, 'node_modules', packageName, 'dist', 'templates', templateFile),
        join(projectRoot, 'node_modules', packageName, 'dist', 'templates', templateFileTs),
      );
    } else if (packageName === 'agentdev') {
      // 2. 框架内置 Feature（agentdev 包）
      const templateParts = templateFile.split('/');
      if (templateParts.length === 2) {
        const featureName = templateParts[0];
        const templateName = templateParts[1];

        searchPaths.push(
          join(projectRoot, 'dist', 'features', featureName, 'templates', templateName),
          join(projectRoot, 'dist', 'features', featureName, 'templates', templateName.replace('.js', '.ts')),
          join(projectRoot, 'src', 'features', featureName, 'templates', templateName.replace('.js', '.ts')),
          join(projectRoot, 'node_modules', 'agentdev', 'dist', 'features', featureName, 'templates', templateName),
        );
      }
    } else {
      // 3. 用户本地 Feature
      searchPaths.push(
        join(projectRoot, 'dist', 'templates', templateFile),
        join(projectRoot, 'dist', 'templates', templateFileTs),
      );
    }

    // 按顺序尝试每个路径
    this.tryReadFile(searchPaths, 0, res, url);
  } catch (err: any) {
    console.error('[Viewer Worker] Unified template handler error:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error');
  }
}
```

### 2.3 tryReadFile递归查找

```typescript
private tryReadFile(
  paths: string[],
  index: number,
  res: ServerResponse,
  originalUrl: string
): void {
  if (index >= paths.length) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(`Template not found: ${originalUrl}`);
    return;
  }

  const filePath = paths[index];
  readFile(filePath, (err, data) => {
    if (err) {
      // 尝试下一个路径
      this.tryReadFile(paths, index + 1, res, originalUrl);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(data);
    }
  });
}
```

## 3. getPackageInfoFromSource实现

位置：`src/core/feature.ts`

```typescript
export function getPackageInfoFromSource(sourcePath: string): PackageInfo | null {
  try {
    // 从sourcePath向上查找package.json
    const packagePath = findPackageJson(sourcePath);
    if (!packagePath) return null;

    const packageDir = dirname(packagePath);
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));

    return {
      name: packageJson.name,
      version: packageJson.version,
      root: packageDir,
    };
  } catch {
    return null;
  }
}
```

## 4. 调试检查清单

### 4.1 Feature端检查

```bash
# 1. 检查Feature是否正确实现getPackageInfo
node -e "
import { MyFeature } from './dist/index.js';
const f = new MyFeature();
console.log('PackageInfo:', f.getPackageInfo());
console.log('TemplateNames:', f.getTemplateNames());
"

# 2. 检查模板文件是否编译
ls -la dist/templates/

# 3. 检查是否有多余的.ts文件
find dist/templates/ -name "*.ts" | grep -v ".d.ts"
```

### 4.2 消费项目端检查

```bash
# 1. 检查node_modules链接
ls -la node_modules/@agentdev/

# 2. 检查模板文件是否可访问
ls -la node_modules/@agentdev/my-feature/dist/templates/

# 3. 检查完整路径
readlink -f node_modules/@agentdev/my-feature/dist/templates/my-tool.render.js
```

### 4.3 运行时检查

```javascript
// 在浏览器控制台或通过DebugHub MCP
const templates = agentSession.featureTemplates;
console.log('Template URLs:', templates);

// 检查URL格式
for (const [name, url] of Object.entries(templates)) {
  console.log(`${name}: ${url}`);
}
```

## 5. 常见错误及解决方案

### 错误1：模板URL包含feature.name

**症状**：
```
/template/@agentdev/visual-feature/visual/capture.render.js
                    ^^^^^^^ 多余
```

**原因**：agent.ts中isStandalonePackage判断条件错误

**修复**：确保判断条件为
```typescript
const isStandalonePackage = pkgInfo.name.startsWith('@agentdev/') && pkgInfo.name !== 'agentdev';
```

### 错误2：scope包URL解析失败

**症状**：packageName只有@agentdev，缺少/visual-feature

**原因**：正则表达式不支持scope包

**修复**：使用支持scope包的正则
```typescript
/^\/template\/((?:@[^/]+\/)?[^/]+)\/(.+\.render\.js)$/
```

### 错误3：dist/templates/包含.ts文件

**症状**：
```
dist/templates/
├── capture.render.ts    ← 源文件，不应存在
├── capture.render.js    ✓ 正确
└── capture.render.d.ts  ✓ 正确
```

**原因**：copy-assets.mjs复制了templates目录

**修复**：从assets中移除templates项
```javascript
const assets = [
  { src: 'src/python', dest: 'dist/python' },
  // 不要复制templates！
];
```

## 6. 开发工作流

### 6.1 创建新Feature

```bash
# 1. 创建包目录
mkdir -p packages/my-feature/src/{templates,python}

# 2. 初始化package.json
cd packages/my-feature
npm init -y

# 3. 安装依赖
npm install --save openai sharp
npm install --save-dev typescript @types/node

# 4. 配置tsconfig.json
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "sourceMap": true,
    "strict": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

# 5. 创建copy-assets.mjs
# (参考SKILL.md中的示例)

# 6. 构建测试
npm run build
ls -la dist/templates/
```

### 6.2 在消费项目中使用

```bash
# 1. 添加依赖
cd ../my-project
npm install file:../packages/my-feature

# 2. 在代码中使用
import { MyFeature } from '@agentdev/my-feature';

const agent = new Agent({
  features: [new MyFeature()]
});
```

### 6.3 调试模板加载

```bash
# 1. 启动Agent项目
npm run dev

# 2. 打开浏览器调试工具
# 访问 http://localhost:2026

# 3. 检查Network面板
# 查看模板请求的URL和响应

# 4. 检查Console面板
# 查看模板加载错误信息
```
