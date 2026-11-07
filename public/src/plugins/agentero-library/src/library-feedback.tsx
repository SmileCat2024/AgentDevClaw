import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'

export type LibraryNotice = { text: string, sequence: number } | null

export interface LibraryFeedbackFace {
  hooks: { notice: ObservableSnapshot<LibraryNotice> }
  dismiss(): void
}

export function LibraryFeedback({ useNotice, dismiss }: InjectFace<LibraryFeedbackFace>) {
  const notice = useNotice(value => value)
  return notice === null ? null : <Toast key={notice.sequence} text={notice.text} onDone={dismiss} />
}
