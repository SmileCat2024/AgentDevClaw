/**
 * dsh-client-store shim（Claw 侧最小实现）。
 *
 * 组件消费面（library-feedback.tsx / index 入口）：createSnapshotStore<T>(initial)
 * 返回 { get, set, subscribe } 的快照 store；入口 notice.set(...)、反馈组件经
 * useSyncExternalStore 消费。ObservableSnapshot 是它的类型名。
 *
 * alias 接线见 src/shim/alias.json + scripts/build-react-panels.mjs。
 */
export interface ObservableSnapshot<T> {
  get(): T
  set(next: T): void
  subscribe(listener: () => void): () => void
}

export function createSnapshotStore<T>(initial: T): ObservableSnapshot<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(next: T) {
      current = next
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
