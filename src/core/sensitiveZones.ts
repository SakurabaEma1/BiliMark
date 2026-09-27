/**
 * 高敏分区清单（ADR-0004 分区隔离墙）：不提交、不展示。
 * 与 server/src/index.ts 的 SENSITIVE_TIDS 保持一致——服务器是提交侧防线，
 * 客户端是入口/展示侧防线；修订清单时两边同步改。
 * tid 体系依据 bilibili-API-collect video_zone.md / video_zone_v2.md（2026-09 查证）：
 * v1 资讯区即时政/社会/国际新闻；v2 新体系把时政/社会观察独立成子分区。
 * 124 社科·法律·心理、207/2087 财经商业属知识区，风险较低，v1 保持开放，清单可调。
 */
const SENSITIVE_TIDS: ReadonlySet<number> = new Set([
  202, 203, 204, 205, 206, // v1 资讯区：主分区/热点(时政)/环球/社会/综合
  1009, 2080, 2081, 2082, 2083, // v2 资讯区：主分区/时政资讯/海外资讯/社会资讯/综合资讯
  2088, 2089, // v2 知识区：社会观察/时政解读
]);

/** v1/v2 双体系任一命中即视为高敏（防止仅一侧可判定时被绕过） */
export function isSensitiveZone(tid: number | null, tidV2: number | null): boolean {
  return (tid !== null && SENSITIVE_TIDS.has(tid)) || (tidV2 !== null && SENSITIVE_TIDS.has(tidV2));
}
