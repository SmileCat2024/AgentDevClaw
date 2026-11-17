// ESM 装载入口：P2 批次 2「右栏注册表与插件底座」。
//
// 本批只迁出三处无同步交互依赖的模块（静态 import 的求值顺序即执行顺序）：
//   1. feature-catalog     —— Features 面板 catalog / 装配事实缓存（纯数据 + 请求，
//                             语言与 activeFeaturePanel 直接 import 已迁移状态域）
//   2. git-graph           —— 泳道算法纯函数 + window.GitGraph 协议挂载点
//   3. feature-ui-registry —— server 动态面板声明拉取与轮询（异步拉取，无 classic 相消费）
//
// 未迁出（保持唯一 classic 原实现，接线时保留其 script 标签）：
//   - right-panel-registry.js（window.ClawPanels）：app-ui 顶层 registerFeaturePanel
//     在 classic 相消费它（R1 触线）
//   - panel-plugins.js：静态懒面板声明必须在 classic 加载相生效（原首屏即可见）
//   - rail-customize.js：首屏同步 rail 配置应用、按钮点击/拖拽/语言更新等同步交互
import './feature-catalog.js';
import './git-graph.js';
import './feature-ui-registry.js';
