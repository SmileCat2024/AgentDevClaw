/**
 * P2 bootstrap 消费接口适配 —— 选择卡片输入草稿。
 *
 * classic 唯一实现：public/src/app-core.js 的
 * createP2BootstrapChoiceInputHost()。state 是只读引用：classic 侧按 requestId
 * 就地读写（创建 / 删除），不整体替换；消费方同样按 requestId 键操作。
 *
 * 消费方（P2 转换后 import）：choice-input。
 *
 * 撤除（P3）：choice-input 迁移、草稿状态 owner 迁入 ESM 后，删除本模块与
 * classic 工厂。
 */
export const choiceInput = window.createP2BootstrapChoiceInputHost();
