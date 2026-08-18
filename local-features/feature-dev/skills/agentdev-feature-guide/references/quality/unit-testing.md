# Feature 测试与验证

## 目录

- [测试层级](#测试层级)
- [Node 测试结构](#node-测试结构)
- [测试工具契约](#测试工具契约)
- [测试上下文注入](#测试上下文注入)
- [测试 Hooks](#测试-hooks)
- [测试配置](#测试配置)
- [测试状态恢复](#测试状态恢复)
- [测试资源生命周期](#测试资源生命周期)
- [测试异步发现](#测试异步发现)
- [测试执行语义](#测试执行语义)
- [发布前验证](#发布前验证)

## 测试层级

### 纯函数测试

验证配置解析、路径规范化、状态迁移、参数校验和结果转换。速度最快，优先覆盖边界。

### Feature 单元测试

直接实例化 Feature，调用工具、hooks、capture/restore 和生命周期方法。

### Agent 集成测试

将 Feature 装进带假 LLM 的 Agent，验证工具注册、hook 顺序、独占/并发、Context 和 continuation。

### 包验证

从构建产物 import Feature，检查模板、skills 和非 TS 资源都进入发布包。

## Node 测试结构

先检查目标项目采用的测试运行器、测试目录和构建脚本。AgentDevClaw 本地 Feature 使用 Node 内置测试工具：

```ts
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MyFeature } from '../src/index.js';

describe('MyFeature', () => {
  let feature: MyFeature;

  beforeEach(() => {
    feature = new MyFeature();
  });

  it('exposes its expected tools', () => {
    assert.deepEqual(feature.getTools().map(tool => tool.name), ['my_action']);
  });
});
```

不要把一个项目的测试框架或执行方式复制到另一个项目。AgentDevClaw 本地 Feature 不要引入 Vitest/Jest，也不要把测试文件写成自行启动的 `main().catch()` 脚本；独立 npm 包及框架内 Feature 应遵循各自项目的测试配置。

## 测试工具契约

```ts
it('defines a narrow schema and returns structured success', async () => {
  const tool = feature.getTools().find(item => item.name === 'my_action');
  assert.ok(tool);
  assert.match(tool.description, /何时/);
  assert.ok(tool.parameters?.required?.includes('value'));

  const result = await tool.execute({ value: 'x' });
  assert.deepEqual(result, { ok: true, value: 'x' });
});
```

至少验证：

- 工具名和数量；
- 必填参数；
- 成功结果；
- 可修正业务失败；
- 安全关键非法输入；
- `executionMode` / `parallelizable` 标记。

## 测试上下文注入

```ts
it('injects feature state for matching tools only', () => {
  const injectors = feature.getContextInjectors();
  const injector = injectors.get('my_action');

  assert.equal(typeof injector, 'function');
  assert.deepEqual(injector!({ id: '1', name: 'my_action', arguments: {} } as any),
    { myFeature: { enabled: true } });
});
```

正则注入器额外测试一个匹配名和一个不匹配名。工具测试中传入注入结果，验证工具读取同一字段结构。

## 测试 Hooks

通知 hook 可直接调用：

```ts
it('injects a reminder when pending work exists', async () => {
  feature.restoreState({ pending: ['a'] });
  const messages: unknown[] = [];

  await feature.injectReminder({
    step: 0,
    callIndex: 0,
    input: 'continue',
    context: { add: (message: unknown) => messages.push(message) },
  } as any);

  assert.equal(messages.length, 1);
});
```

决策 hook 覆盖每个出口：

```ts
it('denies blocked work', async () => {
  feature.setMode('blocked');
  assert.equal(await feature.decideNextStep(makeStepContext()), Decision.Deny);
});

it('approves pending work', async () => {
  feature.setMode('pending');
  assert.equal(await feature.decideNextStep(makeStepContext()), Decision.Approve);
});

it('continues when idle', async () => {
  feature.setMode('idle');
  assert.equal(await feature.decideNextStep(makeStepContext()), Decision.Continue);
});
```

还要检查类的装饰器元数据或通过 Agent 集成测试确认方法确实被 registry 收集。直接调用一个未装饰方法只能证明方法逻辑，不能证明装配正确。

## 测试配置

建立最小 `FeatureInitContext`：

```ts
function makeInitContext(featureConfig?: unknown): FeatureInitContext {
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
  return {
    agentId: 'test-agent',
    config: {
      llm: {} as any,
      workspaceDir: 'D:/workspace',
      features: { 'my-feature': featureConfig },
    },
    logger: logger as any,
    featureConfig,
    getFeature: () => undefined,
    registerTool() {},
  };
}
```

覆盖：

- undefined 配置；
- 完整配置；
- false、0、空数组等合法边界；
- 错误类型；
- 构造参数与 featureConfig 优先级；
- 相对路径基准。

## 测试状态恢复

### 往返

```ts
it('round-trips logical state', () => {
  const original = new MyFeature();
  original.restoreState({ enabled: false, items: ['a'] });

  const snapshot = structuredClone(original.captureState());
  const restored = new MyFeature();
  restored.restoreState(snapshot);

  assert.deepEqual(restored.captureState(), snapshot);
});
```

### 值快照

```ts
it('does not expose mutable state references', () => {
  const snapshot = feature.captureState() as { items: string[] };
  snapshot.items.push('outside');
  assert.notDeepEqual(feature.captureState(), snapshot);
});
```

### 幂等恢复

连续调用两次 restore，结果不应重复追加。

### 迁移输入

测试缺失字段、未知字段、旧 schema 和非法输入。

## 测试资源生命周期

使用假客户端：

```ts
it('connects and closes its client', async () => {
  let connectCalls = 0;
  let closeCalls = 0;
  const close = async () => { closeCalls++; };
  const connect = async () => { connectCalls++; return { close }; };
  const feature = new MyFeature({ connect });

  await feature.onInitiate(makeInitContext());
  await feature.onDestroy(makeFeatureContext());

  assert.equal(connectCalls, 1);
  assert.equal(closeCalls, 1);
});
```

额外验证：

- onDestroy 重复调用安全；
- 初始化失败时没有半初始化资源泄漏；
- AbortController 能停止后台循环；
- restoreState 不创建网络连接。

## 测试异步发现

```ts
it('maps discovered actions to deterministic tools', async () => {
  const feature = new MyFeature({
    connect: async () => ({
      listActions: async () => [
        { id: 'read', description: 'Read data' },
        { id: 'write', description: 'Write data' },
      ],
    }),
  });

  const tools = await feature.getAsyncTools(makeInitContext());
  assert.deepEqual(tools.map(tool => tool.name), ['domain_read', 'domain_write']);
});
```

测试发现失败、空列表、重复远端名称、非法名称和被过滤操作。

## 测试执行语义

单元测试先检查声明：

```ts
assert.equal(checkpointTool.executionMode, 'exclusive');
assert.equal(readTool.parallelizable, true);
assert.notEqual(writeTool.parallelizable, true);
```

集成测试再验证：

- 独占工具与其他调用同批出现时整批拒绝；
- 并发工具确实重叠执行；
- 串行工具按顺序执行；
- 结果按原始 tool call 顺序写入 Context；
- `interrupt()` 后工具收到 signal；
- continuation request 只能登记一个，并在消费后清空。

## 发布前验证

- `npm test` 或项目规定测试命令通过。
- TypeScript 构建通过。
- 从 `dist/index.js` 可成功 import Feature。
- 工具、hooks、manifest 和公开 API 符合预期。
- `dist/templates/` 包含所有模板。
- `dist/skills/` 包含所有 Feature skills。
- 非 TS 资源已复制。
- `package.json.files` 包含所需产物。
- 在一个最小消费项目中安装打包结果并完成 smoke test。
