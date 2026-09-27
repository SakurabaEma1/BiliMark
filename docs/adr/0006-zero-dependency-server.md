# 0006 — 服务器 v0.3：零依赖微服务（node:http + node:sqlite）

服务器以 Node 24 内置能力实现：node:http 起服务、node:sqlite 做存储，**零运行时 npm 依赖**，单文件微服务（server/src/index.ts）。这是对 ADR-0003 中「简单后端 + Postgres」的 v0.3 阶段修正：单人志愿运维（ADR-0005）下，SQLite 的零守护进程、文件即备份特性完全对齐「全量发布与可接管性」——server/data/bilimark.db 单文件复制即备份；Postgres 推迟到规模真正需要时。

端点：GET /api/markings（按 BVID 批量聚合查询）、POST /api/markings（提交；私人 ID 仅以 SHA-256 哈希落库，明文不出本机）、POST /api/vote（一人一票可改票）、GET /database.json（全量发布）。聚合阈值（确认 ≥3 / 驳回 ≤-2）为写死常量，属 FEASIBILITY.md 实现期待定项。每 IP 每分钟 120 次的简易限流。

## Consequences

- node:sqlite 需 Node ≥ 22.5——部署环境锁定 Node 22.5+（当前开发机 24.x）。
- 扩展端 ApiProvider 在服务器不可达时回退 Mock，本地提交闭环不受影响（优雅降级）。
