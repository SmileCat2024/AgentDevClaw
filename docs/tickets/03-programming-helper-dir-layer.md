# Ticket 03 — 编程小助手目录层 + 会话注入队列位

- 依赖：01、02
- 仓库：Claw
- 涉及：`prebuilt-agents/official/programming-helper/agent.js`、
  `~/.agentdev/AgentDevClaw/workspaces/programming-helper/feature-config/`

## 背景

编程小助手已在多个项目目录工作（state.json 的 phProjects），但配置全局一份。
本 ticket 是队列模型的**首个装配侧消费方**：`[全局层, 目录层(cwd), 会话注入]`。

## 任务

1. **目录层文件**：`workspaces/programming-helper/feature-config/dir-<encoded>.json`
   - `<encoded>` = 目录绝对路径的短 hash + basename，如 `dir-a1b2c3d4-AgentDevClaw`
   - 内容为稀疏 FeatureConfig（顶层按 featureName 分桶，只存显式覆盖字段）
   - 文件不存在 = 该目录无覆盖（正常态，多数目录不会有文件）

2. **改造 agent.js 装配**（替换现有 readSystemFeatureConfig + spread）：
   ```js
   const queue = [
     readGlobalLayer(),                      // 清洗后的 feature-setup.json
     readDirLayer(workspaceDir),             // 按构造时 cwd 定位，不存在则 {}
     runtime.config.featureOverrides || {},  // 会话/调用方注入，不落盘（D12）
   ];
   const { merged } = resolveFeatureConfig(queue);   // @agentdev/core 导入
   super({ ...config, features: merged, skillConfig: /* 由 merged.skill 派生 */ });
   ```

3. **组装纪律**：
   - 队列在构造函数内组装（cwd 是构造参数），**禁止进程级缓存**——
     同进程多 session 可能对应不同 cwd
   - exploration 子代理走同一组装路径（构造参数一致，行为一致）
   - skillConfig 的现有派生逻辑保持，仅改为从 merged 读取

## 验收标准

- 目录层写入 `{ "lsp": { "typescript": { "mode": "runtime" } } }` 后新建会话，
  LspFeature 实际按 runtime 模式启动（行为验证，不只看日志）
- 删除该文件后新会话恢复继承全局/默认
- 全局层改动继续对无目录层覆盖的目录生效
- 会话注入（featureOverrides）出现时排在队列末尾且优先级最高，不落盘
- 现有 session 恢复不因无目录层文件而报错

## 边界说明

- 前端此时还没有编辑入口（06 之前），验证用手写 JSON 文件
- readSystemFeatureConfig 旧函数删除，不留 fallback 分支（D12：注入路径统一）
