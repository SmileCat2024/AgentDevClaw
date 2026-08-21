/**
 * 线程宿主工作空间集合 — 唯一权威定义。
 *
 * 只回答「哪些工作空间的新会话自动建立线程环境」（环境的存在性开关）。
 * 该定义放在独立的零依赖轻量模块：agent 子进程（run-prebuilt-agent.js）
 * 需要同源引用本集合做挂载判定，但不能因此把 server 侧 thread-controller
 * 初始化链拉进子进程。所有消费方一律从本模块 import，禁止复制集合。
 */
export const THREAD_HOST_AGENT_IDS = new Set(['coder']);
