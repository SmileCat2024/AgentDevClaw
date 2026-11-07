/**
 * dsh-client-ui-slots shim：类型桩（仅类型，无运行时）。
 *
 * 组件消费面：
 *   - papers.ts：PropsLocale<'agentero.library'>['t']
 *   - papers-library.tsx：PropsRuntime / PropsLocale（PropsRuntime<'sidebar.right.pane.tab'>
 *     在 dsh 是右栏 slot 注入的运行时 props；面板组件未消费其字段，空接口即可，
 *     若上游新增消费会以编译错误暴露）
 *   - library-feedback.tsx：InjectFace<LibraryFeedbackFace>（face 直接作 props）
 */
export type PropsLocale<N extends string = string> = {
  t: (key: string, params?: Record<string, unknown>) => string
}

export type PropsRuntime<S extends string = string> = Record<string, never>

export type InjectFace<T> = T
