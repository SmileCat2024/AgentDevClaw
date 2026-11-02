# AgentDev Claw runtime 应用镜像（ADR-0037 M5 修订：按 agent 构建）
#
# 一 agent 一镜像：主 context = 该 agent 的运行闭包（run-prebuilt-agent 宿主
# 闭包 + agent 目录 + 其引用的 local-features / features 子包），由
# scripts/pack-container.mjs 按 agent 组装（dist/container-ctx-<agentId>）；
# nm named context = 该闭包的最小 node_modules（dist/container-nm-<agentId>，
# 只含 bare import 递归闭包，平台绑定包为容器架构 Linux 子包）。
#
# 构建步骤纯 COPY、零 RUN、零 npm install：依赖安装由"本地能跑"前提消解
#（开发态 @agentdevjs 经相邻仓库 npm pack 实体化）；不在容器内重装依赖
#（会按 package.json 的 file: 开发态声明重建链接，覆盖实体，实测装配链断裂）。
FROM agentdev-claw-base:24.19.0

COPY --chown=node:node . /app
COPY --chown=node:node --from=nm / /app/node_modules/

# 运行形态 = 容器内托管 runtime（M6 经 env 注入注册 ticket 与数据挂载）。
# 自检：docker run --rm --entrypoint node <img> scripts/container-selftest.js
ENTRYPOINT ["node", "scripts/run-prebuilt-agent.js"]
