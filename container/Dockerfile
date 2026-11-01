# AgentDev Claw runtime 应用镜像（ADR-0037 容器阶段 / M5，路线一）
#
# 镜像内容 = Agent runtime 运行闭包（仅此而已，ADR-0037 决策 1"仅 runtime
# 进容器"）：宿主脚本闭包 + prebuilt-agents + local-features / features +
# 官方 feature 仓库 + node_modules。平台物（server.js / public/ / 未被
# runtime 引用的平台路由）不进镜像。全部内容由 scripts/pack-container.mjs
# 正向收集组装，两个 context：
#
#   主 context（.） = 组装出的白名单树（dist/container-context）
#   nm              = 预组装的完整 node_modules 镜像目录
#                     （dist/container-nm：开发态含 @agentdevjs 实体化、
#                     传递依赖闭包与平台绑定包的 Linux 子包；Windows junction
#                     不被 tar 跟随且 named-context ignore 特性实测不可用，
#                     故全部预组装）
#
# 构建步骤纯 COPY、零 RUN：不在容器内 npm install（它会按镜像内 package.json
# 的 file: 开发态声明重建依赖链接，覆盖 @agentdevjs 实体，实测导致装配链
# 断裂）；native 依赖的 Linux 二进制子包由构建脚本在宿主侧备入 nm。
FROM agentdev-claw-base:24.19.0

COPY --chown=node:node . /app
COPY --chown=node:node --from=nm / /app/node_modules/

# 运行形态 = 容器内托管 runtime（M6 经 env 注入注册 ticket 与数据挂载）。
# 自检：docker run --rm --entrypoint node <img> scripts/container-selftest.js
ENTRYPOINT ["node", "scripts/run-prebuilt-agent.js"]
