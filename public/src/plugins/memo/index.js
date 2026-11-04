/**
 * index.js — memo 前端插件入口
 *
 * 形态：memo APP 的界面以插件形式挂到宿主，不再依赖 index.html 静态标签。
 * 装载时注册三个 block 渲染器与对应 action，卸载时全部摘除。
 *
 * 插件协议（ClawHost.loadPlugin 消费）：
 *   id       插件标识，用于卸载时按 owner 精确摘除自己的 block
 *   blocks   { type: renderer }，渲染器签名 (agent, block) => html
 *   mount(host)    装载后调用，注入宿主能力并注册 action
 *   unmount()      卸载前调用，注销 action 与状态
 */
import MemoNotes from './notes.js';
import MemoReminders from './reminders.js';
import MemoOverview from './overview.js';
import { MemoNotesUI } from './notes.js';
import { MemoRemindersUI } from './reminders.js';
import { MemoOverviewUI } from './overview.js';

let host = null;

export default {
  id: 'memo',

  blocks: {
    'memo-notes': () => MemoNotesUI.render(),
    'memo-reminders': () => MemoRemindersUI.render(),
    'memo-overview': () => MemoOverviewUI.render(),
  },

  actions: {
    'memo.openNote': (el) => MemoNotesUI.openNote(el.dataset.noteFilename),
    'memo.closeNote': () => MemoNotesUI.closeNote(),
    'memo.onEditorInput': (el) => MemoNotesUI.onEditorInput(el),
    'memo.commitEditBlock': () => MemoNotesUI.commitEditBlock(),
    'memo.onEditorKeydown': (el, ev) => MemoNotesUI.onEditorKeydown(ev),
    'memo.startEditBlock': (el, ev, blockIndex) => MemoNotesUI.startEditBlock(blockIndex, ev),
    'memo.goReminders': () => MemoOverviewUI.goReminders(),
    'memo.workspaceAction': (el) => host.workspace.runAction(el.dataset.workspaceAction, el),
    'memo.overviewOpenNote': (el, ev, filename) => MemoOverviewUI.openNote(filename),
    'memo.completeReminder': (el, ev, id) => MemoRemindersUI.complete(id),
    'memo.removeReminder': (el, ev, id) => MemoRemindersUI.remove(id),
  },

  mount(api) {
    host = api;
    // 插件只依赖注入的宿主能力（host.env），不直接触碰经典脚本全局。
    const presenter = {
      getLanguage: () => api.env.language,
      escapeHtml: (value) => api.env.escapeHtml(value),
      markdown: {
        renderMarkdown: (text) => api.env.markdown.render(text),
        splitMarkdownBlocks: (text) => api.env.markdown.splitBlocks(text),
        isEditableMarkdownBlock: (block) => api.env.markdown.isEditableBlock(block),
        replaceMarkdownBlock: (src, idx, text) => api.env.markdown.replaceBlock(src, idx, text),
      },
      // 子模块经 presenter 转调宿主能力，不各自持有 host 实例
      workspace: api.workspace,
    };
    MemoNotes.mount(presenter);
    MemoReminders.mount(presenter);
    MemoOverview.mount(presenter);
  },

  unmount() {
    MemoNotes.unmount();
    MemoReminders.unmount();
    MemoOverview.unmount();
    host = null;
  },

  // 供宿主刷新分发使用（app-ui 的 WORKSPACE_PANEL_REFRESHERS）
  refreshers: {
    'memo-notes': () => MemoNotesUI.refresh(),
    'memo-reminders': () => MemoRemindersUI.refresh(),
    'memo-overview': () => MemoOverviewUI.refresh(),
  },
};
