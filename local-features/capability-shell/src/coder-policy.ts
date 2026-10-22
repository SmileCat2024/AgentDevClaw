/**
 * coder_shell 策略声明（ticket 034；new-session 动词 ticket 035）
 *
 * 领域 shell = 033 基座的一CapabilityShellPolicy + adapter map。
 * v1 动词表 9 个，adapter 直调 /protoclaw/threads* 与 /protoclaw/prebuilt_sessions
 * （无鉴权层，同机回环）。
 *
 * advance / resume 不入表：rotation_failed 场景输出结构化指引，人工介入
 * （与技能故障表一致）。send 后台监视，watch 登记一次性待命。
 */

import type { CapabilityShellPolicy } from './types.js';

export const CODER_SHELL_NAME = 'coder_shell';

export const CODER_SHELL_DESCRIPTION = [
  '调度智能编码工作空间中的 Coder 智能体（自主编码的子代理）：',
  '按工单创建线程、派发并后台监视、处理待投递命令、收口归档。send 快速返回，watch 表达待命，重要事件自动通知。',
  '首次使用或遇到拒绝报文时，先用 invoke_skill 激活 claw-coder-dispatch 技能——它是本工具的权威用法手册（动词用法、参数语义、调度纪律与故障处置）。',
  '核心不变量：一个工单一个线程；有文件交集的工单串行；发送成功不等于执行开始；',
  '以证据判定完成；绝不覆盖其他会话的工作（禁 reset/clean/checkout 覆盖）；默认不让 coder 自行 push。',
].join('\n');

/**
 * 动词表（v1，10 个）。send 的幂等键为必填位置参数（缺失在参数校验道拒绝）；
 * 超时唯一闸门 = Tool.timeout 契约，动词表不承载任何时间 flag。
 */
export function createCoderShellPolicy(): CapabilityShellPolicy {
  return {
    name: CODER_SHELL_NAME,
    description: CODER_SHELL_DESCRIPTION,
    verbs: {
      'new-session': {
        description: '创建 Coder 会话并自动建线（标准第一步，返回 sessionId + threadId）；目标工作目录必填（服务端禁止目录回退默认）。agentId 恒为 coder——coder 是独立 APP（ADR-0025），直接以 agentId=coder 寻址，不接受其它值',
        params: [
          { name: 'agentId', kind: 'literal' },
          { name: 'directory', kind: 'literal' },
          { name: 'title', kind: 'literal', required: false },
        ],
        usage: "new-session coder <目标工作目录> ['标题']",
        adapter: { key: 'threads:new-session' },
      },
      'create': {
        description: '为已存在的 Coder 会话创建工作线程（返回 threadId；无可用会话时先用 new-session）。agentId 恒为 coder（ADR-0025 独立 APP 寻址）',
        params: [
          { name: 'agentId', kind: 'literal' },
          { name: 'sessionId', kind: 'literal' },
          { name: 'title', kind: 'literal', required: false },
        ],
        usage: "create coder <sessionId> ['标题']",
        adapter: { key: 'threads:create' },
      },
      'send': {
        description: '提交指令并默认登记后台监视后返回；--dispatch-only 仅提交不监视。幂等键必填，提交成功不等于业务完成',
        params: [
          { name: 'threadId', kind: 'literal' },
          { name: 'idempotencyKey', kind: 'literal' },
          { name: 'text', kind: 'literal' },
        ],
        flags: ['--dispatch-only'],
        usage: "send <threadId> <idempotencyKey> '<指令文本>' [--dispatch-only]",
        adapter: { key: 'threads:send' },
      },
      'watch': {
        description: '默认观察每线程最近一次派发，登记一次性待命后快速返回；目标已结束则直接返回结果。--command 精确选择历史提交',
        params: [{ name: 'threadId', kind: 'literal', variadic: true }],
        flags: ['--command='],
        usage: 'watch <threadId> [threadId...] [--command=<commandId>]',
        adapter: { key: 'threads:watch' },
      },
      'result': {
        description: '取线程最新回复全文；多轮回复时附全部轮次索引，--turn=N 取指定轮最后一条回复全文',
        params: [{ name: 'threadId', kind: 'literal' }],
        flags: ['--turn='],
        usage: 'result <threadId> [--turn=N]',
        adapter: { key: 'threads:result' },
      },
      'list': {
        description: '列出工作线程：默认按最近活动倒序取 10 条非终态线程（归档/关闭不出现在默认结果）；--status / --dir / --title / --failed 过滤，-n 调整条数（0=不限），--all 含终态线程',
        params: [
          { name: 'agentId', kind: 'literal', required: false },
        ],
        flags: ['--all', '--failed', '--status=', '--dir=', '--title=', '-n=', '--limit='],
        usage: "list [agentId] [--status=executing,pending-commands,idle,archived,closed] [--dir=/项目目录] [--title=关键字] [-n=条数] [--all] [--failed]",
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
    // 不同线程的控制面操作允许并行；监视按指令身份隔离。
    parallelizable: true,
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
