// ESM 装载入口：P2 第二波批次 3a「输入面状态所有者」。
//
// 静态 import 的求值顺序（深度优先、按声明顺序）就是本批的执行顺序：
//   1. p2-w2-3a-input-queue-state   —— 排队投影状态 owner（claim 吸收
//      persistent-input.js 在 classic 相注册的真初值）
//   2. p2-w2-3a-call-elapsed-state  —— 上次对话结束时间状态 owner（同上）
//   3. p2-w2-3a-voice-state         —— 跨文件语音状态 owner（claim 吸收
//      voice-input.js 的 classic 相注册）
//   4. p2-w2-3a-composer-state      —— composer 草稿缓存 owner（claim 吸收
//      input-composer.js 的 classic 相注册）
//   5. p2-w2-3a-queue-projection    —— 队列气泡渲染 / 后端与 SSE 队列快照同步
//      （迁出 persistent-input.js；behavior 桥键在本域已 claim 之后注册）
//   6. recap-hint                   —— 离开摘要域整体转 ESM（状态 owner 在其
//      依赖的 p2-w2-3a-recap-state.js，注册与 claim 同相完成）
//
// 本批保留唯一 classic 实现的部分（时序触线，见批次交付报告）：
//   - persistent-input.js：submitQueuedInput / 动作按钮 / 图片附件 /
//     `_renderLastCallElapsed`（1s tick 在 classic 相已运行）/
//     `rebindQueueProjectionForRuntime`（首屏同步链直接调用）/ interruptAgent
//   - voice-input.js：流式采集与 ASR 全链路（首屏
//     `_shouldPreserveVoiceInputForRender` 同步判定）
//   - input-composer.js：composer 组件与模式判定（首屏
//     `renderInputRequests` 的 hidden 分支同步调用）
import './p2-w2-3a-input-queue-state.js';
import './p2-w2-3a-call-elapsed-state.js';
import './p2-w2-3a-voice-state.js';
import './p2-w2-3a-composer-state.js';
import './p2-w2-3a-queue-projection.js';
import './recap-hint.js';
