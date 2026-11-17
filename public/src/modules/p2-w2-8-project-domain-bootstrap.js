// ESM 装载入口：P2 批次 W2-8「编程小助手项目域」。
//
// 本入口的职责只是让本批六个模块被求值，**不承诺 import 书写顺序等于业务执行顺序**：
// 原生 ESM 的求值顺序由模块图依赖边决定（post-order DFS），批内模块之间只在调用时
// 取用对方导出，没有顶层求值依赖（各自顶层仅注册 KernelState 桥键 / action-dispatcher
// 动作、初始化本域命名空间对象并定义函数）。因此把它们放进同一入口即可：
//   - project-data.js        项目 / 目录数据层（浏览目标、项目实体、workspace state
//                            与记录写入口、侧栏子条目分组身份）
//   - ph-session-list.js     会话列表 UI 交互（话题缓存、搜索状态机 `_phSearch`）
//   - ph-settings.js         工作空间设置面板（装配 / Coder 策略 / 通知 / 运行环境）
//   - ph-project-actions.js  项目操作与模型配置动作（打开 / 切换 / 新建 / 管理 / 分页）
//   - ph-session-move.js     会话移动（多选状态 + 归属解析 + 弹窗）
//   - ph-search-locate.js    搜索结果 → 聊天消息定位与返回
//
// 未转换（本批零残余 classic 文件的说明见各文件头与交付报告）：本批六个文件全部转
// ESM；随各文件末尾 KernelState.defineKey/claim 提供 classic 兼容面，逐键消费证据与
// 注销条件见各文件尾注释。
//
// 静态循环说明（不在本批改动面，仅记录）：本批经 session-list-render / workspace-blocks /
// assembly-data 进入组装域既有 SCC（assembly-actions ↔ assembly-data ↔ feature-config ↔
// fw-config-panel ↔ workspace-blocks）。SCC 内模块只在调用时取用导出，无顶层求值依赖。
// 本批自身不新增循环：ph-project-actions 与 ph-settings、ph-session-move 之间的互需入口
// 走既有 window 晚绑定 + 兼容桥（见各文件头注释），不引入静态环。
import './project-data.js';
import './ph-session-list.js';
import './ph-settings.js';
import './ph-project-actions.js';
import './ph-session-move.js';
import './ph-search-locate.js';
