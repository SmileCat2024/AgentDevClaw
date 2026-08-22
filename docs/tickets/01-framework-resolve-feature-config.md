# Ticket 01 — 框架 resolveFeatureConfig 纯函数

- 依赖：无（本批的前置）
- 仓库：**AgentDev**（框架仓库，权威源码位置，不是 Claw）
- 涉及：`AgentDev/packages/core/src/`（建议新模块 `core/feature-config.ts`），
  从 `@agentdev/core` 导出；构建后 Claw 侧消费需重启整个服务

## 背景

见 [00 总纲](./00-feature-config-queue-overview.md)。框架需要提供队列 merge 与
provenance 的唯一权威实现，作为纯函数，不感知任何层语义。

## 任务

新增并导出：

```ts
export type FeatureConfig = Record<string, unknown>;
// 顶层 key = featureName（如 'lsp'、'shell'），值为该 feature 的配置对象

export interface ConfigProvenanceEntry {
  value: unknown;        // 该字段最终生效值
  sourceIndex: number;   // 队列中最后写入该字段的元素索引
}

export interface ConfigWarning {
  fieldPath: string;     // 点路径，如 'lsp.typescript.mode'
  layerIndex: number;
  kind: 'null-removed'; // 第一版只有这一种；扩展时补充
  message: string;
}

export function resolveFeatureConfig(
  queue: FeatureConfig[],
): {
  merged: FeatureConfig;                                  // 最终合并配置
  provenance: Record<string, ConfigProvenanceEntry>;      // key = 点路径
  warnings: ConfigWarning[];
};
```

**merge 规范（D5，实现与测试都不得有例外）**：
1. 对象：递归合并（同 key 且两侧均为普通对象时深入）
2. 标量：替换（后层胜）
3. 数组：整体替换，绝不按索引/按 key 合并
4. null：视为"删除该字段"，从合并结果移除并产生 warning
5. 未出现的 key：继承（不写入即不覆盖）
6. 空队列返回 `{ merged: {}, provenance: {}, warnings: [] }`

**纯函数纪律**：无 IO、无 logger、无进程状态；warning 以返回值交付，由调用方
决定记日志方式。provenance 的 key 是完整点路径（含 featureName 前缀）。

## 验收标准

- `node --test` / vitest 单测覆盖：空队列、单层透传、多层标量覆盖、嵌套对象
  递归合并、数组替换（含长度不同的数组）、null 删除 + warning、值相同的 pin
  （sourceIndex 指向后层）、多级嵌套 provenance 路径正确性
- `@agentdev/core` 导出该函数；`AgentDev` 根目录 `npm run build` 通过
- 类型定义进 dist 的 .d.ts

## 边界说明

- 不给 Agent 构造函数加任何语法糖（D3），不加层概念（D1）
- 第一版不做指令系统（$set/$unset 等），不合并 null 之外的警告类型
