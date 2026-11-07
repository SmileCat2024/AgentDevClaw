/**
 * React 面板试点插件（ADR-0044 P6：React 接入基建的最小验证载体）。
 *
 * 不进 plugin-manifest、不接 rail——只验证三件事：
 *   1. esbuild 产物可被动态 import()（ESM + react 运行时自包含）；
 *   2. __clawPanelCss（构建器 banner 注入）存在且已按 scope 注释作用域化；
 *   3. ensurePanelStyle 的注入 / 移除语义（mount 时挂 <style>、dispose 时
 *      只移除自己创建的节点，幂等、不留残留）。
 *
 * #5 的 agentero 面板按真实插件协议（panels + mountBody）落地时，
 * ensurePanelStyle 模式原样复用。
 */
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** 构建器 banner 注入的 scoped CSS（无 tailwind.css 时为空字符串）。 */
declare const __clawPanelCss: string;

export interface PanelStyleDispose {
  (): void;
  /** 供测试观察：当前是否由本次调用创建的 <style>。 */
  created: boolean;
}

/**
 * 面板样式注入：存在即复用（幂等），返回 dispose 只移除自己创建的节点
 * （复用场景下 dispose 为空操作——样式生命周期归首个创建者）。
 * document 参数化注入，测试可传 stub。
 */
export function ensurePanelStyle(
  doc: Pick<Document, 'getElementById' | 'createElement' | 'head'>,
  styleId: string,
  css: string,
): PanelStyleDispose {
  const existing = doc.getElementById(styleId);
  if (existing || !css) {
    const noop: PanelStyleDispose = () => undefined;
    noop.created = false;
    return noop;
  }
  const style = doc.createElement('style');
  style.id = styleId;
  (style as HTMLStyleElement).textContent = css;
  doc.head.appendChild(style);
  const dispose: PanelStyleDispose = () => {
    if (style.isConnected) (style as unknown as { remove(): void }).remove();
  };
  dispose.created = true;
  return dispose;
}

interface MountApi {
  createElement(tag: string): Element;
  appendChild(child: Element): Element;
}

interface TrialExports {
  id: string;
  css: string;
  mountTo(container: Element & { childNodes?: NodeListOf<ChildNode> }): {
    dispose(): void;
    getRenderedText(): string | undefined;
    simulateClick(): void;
    getRoot(): Root | null;
  };
}

const plugin: TrialExports = {
  id: 'react-trial',
  get css() {
    return __clawPanelCss;
  },
  mountTo(container) {
    const disposeStyle = ensurePanelStyle(document, 'react-trial-style', __clawPanelCss);
    const root = createRoot(container);

    function CounterLink({ label }: { label: string }) {
      const [count, setCount] = useState(0);
      return createElement(
        'button',
        {
          'data-testid': 'react-trial-counter',
          className: 'react-trial text-sm font-semibold',
          onClick: () => setCount((c) => c + 1),
        },
        `${label}: ${count}`,
      );
    }

    root.render(createElement(CounterLink, { label: 'mounted' }));

    return {
      dispose() {
        root.unmount();
        disposeStyle();
      },
      getRenderedText() {
        const el = container.querySelector?.('[data-testid="react-trial-counter"]');
        return el?.textContent ?? undefined;
      },
      simulateClick() {
        const el = container.querySelector?.('[data-testid="react-trial-counter"]');
        (el as unknown as { click(): void } | null)?.click();
      },
      getRoot: () => root,
    };
  },
};

export default plugin;
export type { MountApi };
