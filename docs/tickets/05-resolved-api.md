# Ticket 05 — resolved API（scope→queue 注册表 + provenance 暴露）

- 依赖：01、03（需要至少一个真实 scope 消费方做验证）
- 仓库：Claw
- 涉及：`server/routes/`（建议新 `feature-config.js` 路由模块）、`server.js` 挂载

## 背景

前端三态渲染（默认/继承/覆盖）需要：各层稀疏内容、合并结果、每字段来源。
现状 `system_feature_config` 只返回扁平全局对象，信息量不足。provenance 必须
查询时动态计算、永不落盘（D7），且与 merge 同源（调用框架
`resolveFeatureConfig`，不自建对比逻辑）。

## 任务

1. **scope→queue 解析注册表**（server 侧内存结构）：
   ```js
   // 每个 agent 注册自己的队列组装函数，与 agent.js 装配逻辑共用读取实现
   registerScopeResolver('programming-helper', ({ dir }) => ({
     layers: [
       { id: 'global', label: '全局', path: GLOBAL_PATH },
       { id: `dir:${dir}`, label: basename(dir), path: dirLayerPath(dir) },
     ],
   }));
   ```
   - 层的 id/label/顺序由注册方声明，server 不解释语义
   - 读取层文件与 agent 侧共用同一实现（抽公共函数，避免两套读取漂移）

2. **GET /protoclaw/feature_config/resolved**
   - 入参：`agentId`（必填）、`dir`（可选，目录 scope 定位）
   - 返回：
     ```json
     {
       "layers": [{ "id": "global", "label": "全局", "sparse": {...} },
                  { "id": "dir:/x/y", "label": "y", "sparse": {...} }],
       "merged": {...},
       "provenance": { "lsp.typescript.mode": { "value": "runtime", "sourceIndex": 1 } },
       "warnings": [...]
     }
     ```
   - manifest defaults 不在此重复返回，前端继续用现有
     `system_feature_manifests`（虚拟第 0 层）

3. **PUT /protoclaw/feature_config/layer**
   - 入参：`agentId` + `layerId` + 稀疏内容（整层替换该层文件）
   - diff 责任在前端（06）：前端只提交"该层应有的完整稀疏内容"，
     server 只做写入与基本校验（对象、顶层 key 合法性、null 拒绝）
   - 写 `global` 层等价于现状全局编辑，保持兼容路径

4. **敏感字段**：第一版沿用现状行为（原样返回），但在返回体加
   `sensitiveFields: ['github.token', ...]` 字段清单，为后续脱敏 ticket
   留锚点，不在本 ticket 实现脱敏。

## 验收标准

- 编程小助手 + 某目录的 resolved 返回：两层稀疏、merged、provenance 三者
  互相一致（merged 字段值 = provenance.value；sourceIndex 指向的层 sparse
  里确实有该字段）
- PUT 层文件后 GET 反映变化；PUT 含 null 的层返回 400
- 未注册 scope 的 agentId 返回明确 404 错误信息
- server-smoke 测试补路由注册断言；新增路由纯逻辑测试进 `test/`

## 边界说明

- 注册表是 server 进程内存态，agent 启动/注册时机对齐现有
  prebuilt-agents 扫描流程即可；本 ticket 不做热更新
