/**
 * hello — 最小 plain agent 示例
 *
 * Plain agent 约定：
 * - 只需导出一个 Agent 类（extends BasicAgent 即可）
 * - 不需要 metadata.json 的 ui 声明，不进入 workspace 列表
 * - 通过 `claw run hello --goal "..."` 启动
 */

import { BasicAgent } from 'agentdev';

export default class HelloAgent extends BasicAgent {
}
