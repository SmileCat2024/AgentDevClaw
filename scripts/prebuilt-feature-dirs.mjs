// features/ 下被预制 agent 按源码路径静态 import 的 feature 包目录清单
// （见各 agent.js 顶层 import）。这些包的 dist 不入库，需现场构建。
// 新增此类 feature 时在此登记一处，构建（build:features）与
// prestart 过时检测（ensure-local-builds）共用本清单。
export const FEATURE_DIRS = ['force-continuation', 'step-rotating-model', 'tickets-build-flow'];
