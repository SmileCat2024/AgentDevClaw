/**
 * dsh-client-ui-primitives shim：Toast 提示条（Claw 侧自绘）。
 *
 * 组件消费面（library-feedback.tsx）：<Toast key text onDone/> —— 展示提示
 * 文本，动画寿命结束后回调 onDone。实现：底部浮层 + 淡入 + 3.5s 自动完成。
 * 样式走 tailwind scope（.agentero-library）内的 utility，不依赖宿主样式。
 */
import { useEffect, useState, type ReactNode } from 'react'

export function Toast({ text, onDone }: { text: ReactNode, onDone: () => void }): ReactNode {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const fade = setTimeout(() => { setLeaving(true) }, 3000)
    const done = setTimeout(onDone, 3300)
    return () => { clearTimeout(fade); clearTimeout(done) }
  }, [onDone])

  return (
    <div
      data-testid='agentero-toast'
      className={`agentero-surface pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground shadow-lg transition-opacity duration-300 ${leaving ? 'opacity-0' : 'opacity-100'}`}
      role='status'
    >
      {text}
    </div>
  )
}
