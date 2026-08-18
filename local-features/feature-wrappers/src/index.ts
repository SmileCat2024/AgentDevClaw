/**
 * feature-wrappers — 基础包装层
 *
 * 对框架自带 feature 的薄包装（继承 + declareContinuity 高阶函数叠加 Claw 协议），
 * 能力本体仍在 `agentdev` 框架与 continuity-participant 协议层，本包不复制任何实现。
 * 消费方（prebuilt agent 装配入口、plain agent）统一 import dist 产物：
 * `local-features/dist/feature-wrappers/src/index.js`
 */
export { ControlledTodoFeature } from './controlled-todo-feature.js';
export { ContinuityAwareOpencodeBasic } from './continuity-aware-opencode-basic.js';
