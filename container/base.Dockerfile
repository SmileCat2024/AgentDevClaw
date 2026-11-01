# AgentDev Claw runtime 容器 base 镜像（ADR-0037 容器阶段 / M5）
#
# 联网准备一次（拉官方 node slim + Debian 源安装 git），此后应用镜像
# （container/Dockerfile）只 FROM 本镜像做 COPY，树级构建不再联网。
# 断网环境可在他机构建后经 `docker save` / `docker load` 导入。
#
# node 版本与桌面 pin 同轨（scripts/pack-desktop.mjs PINNED_NODE_VERSION），
# 升级时两处同步。

FROM node:24.19.0-slim

# git：编程小助手 / coder 工具链依赖；ca-certificates：HTTPS 出网（模型 API）。
# 单层 RUN 并清理 apt 缓存控制体积。
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 非 root 运行（ADR-0037 既定卫生项）。node 官方镜像自带 uid 1000 的
# node 用户；镜像树 /app 只读，运行时写入全部落在挂载卷（用户数据 / workspace）。
USER node
WORKDIR /app
