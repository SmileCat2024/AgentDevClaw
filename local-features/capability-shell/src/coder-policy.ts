/**
 * coder_shell 策略声明（ticket 034）
 *
 * 领域 shell = 033 基座的一CapabilityShellPolicy + adapter map。
 * v1 动词表 8 个，adapter 直调 /protoclaw/threads*（无鉴权层，同机回环）。
 *
 * advance / resume 不入表：rotation_failed 场景输出结构化指引，人工介入
 * （与技能故障表一致）。watch 是只读续挂监视（send 已内置阻塞等落定，
 * watch 用于超时续挂与纯监视已运行线程）。
 */

import type { CapabilityShellPolicy } from './types.js';

export const CODER_SHELL_NAME = 'coder_shell';

export const CODER_SHELL_DESCRIPTION = [
  '调度智能编码工作空间中的 Coder 智能体（自主编码的子代理）：',
  '按工单创建线程、派发指令（阻塞等本轮落定）、监视执行、处理超时/待投递命令、收口归档。',
  '首次使用或遇到拒绝报文时，先用 invoke_skill 激活 claw-coder-dispatch 技能——它是本工具的权威用法手册（动词用法、参数语义、调度纪律与故障处置）。',
  '核心不变量：一个工单一个线程；有文件交集的工单串行；发送成功不等于执行开始；',
  '以证据判定完成；绝不覆盖其他会话的工作（禁 reset/clean/checkout 覆盖）；默认不让 coder 自行 push。',
].join('\n');

/**
 * 动词表（v1）。send 的幂等键为必填位置参数（缺失在参数校验道拒绝）；
 * 超时唯一闸门 = Tool.timeout 契约，动词表不承载任何时间 flag。
 */
export function createCoderShellPolicy(): CapabilityShellPolicy {
  return {
    name: CODER_SHELL_NAME,
    description: CODER_SHELL_DESCRIPTION,
    verbs: {
      'create': {
        description: '创建 coder 工作线程（建会话+线程，返回 threadId）',
        params: [
          { name: 'agentId', kind: 'literal' },
          { name: 'sessionId', kind: 'literal' },
          { name: 'title', kind: 'literal' },
        ],
        usage: "create <agentId> <sessionId> ['标题']",
        adapter: { key: 'threads:create' },
      },
      'send': {
        description: '向线程派发指令并阻塞等本轮落定（幂等键必填）',
        params: [
          { name: 'threadId', kind: 'literal' },
          { name: 'idempotencyKey', kind: 'literal' },
          { name: 'text', kind: 'literal' },
        ],
        usage: "send <threadId> <idempotencyKey> '<指令文本>'",
        adapter: { key: 'threads:send' },
      },
      'watch': {
        description: '续挂监视线程，本轮落定即返（超时返回结构化 done reason=timeout）',
        params: [{ name: 'threadId', kind: 'literal' }],
        usage: 'watch <threadId>',
        adapter: { key: 'threads:watch' },
      },
      'list': {
        description: '列出工作线程',
        params: [
          { name: 'agentId', kind: 'literal' },
        ],
        usage: 'list [agentId]',
        adapter: { key: 'threads:list' },
      },
      'show': {
        description: '查看线程详情（含事件尾摘要）',
        params: [
          { name: 'threadId', kind: 'literal' },
        ],
        usage: 'show <threadId>',
        adapter: { key: 'threads:show' },
      },
      'archive': {
        description: '归档线程（归档即打断收纳；已归档拒绝新指令）',
        params: [
          { name: 'threadId', kind: 'literal' },
        ],
        usage: 'archive <threadId>',
        adapter: { key: 'threads:archive' },
      },
      'unarchive': {
        description: '取消归档（runtime 不会自动启动，需重新投递指令唤醒）',
        params: [
          { name: 'threadId', kind: 'literal' },
        ],
        usage: 'unarchive <threadId>',
        adapter: { key: 'threads:unarchive' },
      },
      'deliver': {
        description: '恢复闸重投 pending 指令（runtime 不在时自动唤起再投）',
        params: [
          { name: 'threadId', kind: 'literal' },
        ],
        usage: 'deliver <threadId>',
        adapter: { key: 'threads:deliver' },
      },
    },
    // 显式排除动词的结构化指引（rotation_failed 残局需人工介入，与技能故障表一致）
    unknownVerbHints: {
      'advance': 'advance / resume 不在 coder_shell 动词表内：会话接力（head 推进）失败'
        + '（rotation_failed）的残局需人工介入——先 show 查看当前 head 与 pending 指令，'
        + '按技能故障表的 rotation_failed 行恢复；恢复前不要重发施工指令。',
      'resume': 'advance / resume 不在 coder_shell 动词表内：rotation_failed 场景的'
        + '接力恢复需人工介入（与技能故障表一致），不要在 shell 内重试。',
    },
  };
}
