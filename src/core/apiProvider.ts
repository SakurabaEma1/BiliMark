import { getApiBase } from './api';
import { getPublicIdHash } from './privateId';
import type { MarkProvider } from './provider';
import type { MarkingEntry, VideoMarkings } from './types';

/**
 * 隐私查询协议（FEASIBILITY 待定项，SB 同款）：GET 不发明文 BVID，
 * 只发 sha256(bvid) 的前 8 位 hex 前缀；服务器按 bvid_hash 前缀命中，
 * 返回以真实 bvid 为键的聚合，客户端用本地 prefix→bvid 映射组装。
 * 前缀只有 8 位（16^8 空间），反推 BVID 不可行；会话内缓存避免重复摘要。
 */
const hashCache = new Map<string, string>();

async function bvidHashPrefix(bvid: string): Promise<string> {
  const hit = hashCache.get(bvid);
  if (hit) return hit;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bvid));
  const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const prefix = hex.slice(0, 8);
  hashCache.set(bvid, prefix);
  return prefix;
}

/**
 * 服务器数据源：批量查询（视频,分类）聚合结果。
 * 服务器不可达时回退到 fallback（Mock），本地提交闭环与演示不受影响——
 * ADR-0005 的优雅降级要求：插件端永远可用，只是数据新鲜度降级。
 */
export class ApiProvider implements MarkProvider {
  constructor(private fallback: MarkProvider) {}

  async getMarkings(
    bvids: string[],
    opts?: { fresh?: boolean },
  ): Promise<Map<string, VideoMarkings>> {
    try {
      const base = await getApiBase();
      const prefixToBvid = new Map<string, string>();
      const hashes = await Promise.all(
        bvids.map(async (bvid) => {
          const prefix = await bvidHashPrefix(bvid);
          prefixToBvid.set(prefix, bvid);
          return prefix;
        }),
      );
      // as=本人公开 ID：影子封禁下本人仍可见自己的提交（GOVERNANCE.md）
      const as = await getPublicIdHash();
      const res = await fetch(
        `${base}/api/markings?hashes=${hashes.join(',')}${as ? `&as=${as}` : ''}`,
        opts?.fresh
          ? { cache: 'no-store', signal: AbortSignal.timeout(3000) }
          : { signal: AbortSignal.timeout(3000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        markings: Record<string, Array<MarkingEntry & { upMid?: number }>>;
        upWarnings?: Record<string, { name?: string; categories: Record<string, number> }>;
      };
      const map = new Map<string, VideoMarkings>();
      for (const [prefix, bvid] of prefixToBvid) {
        const entries = data.markings?.[bvid];
        if (!entries || entries.length === 0) continue;
        const vm: VideoMarkings = { bvid, entries };
        // UP主警示派生（CONTEXT.md）：该视频 UP 触发门槛时挂到视频级标记上
        const upMid = entries.find((e) => typeof e.upMid === 'number')?.upMid;
        const warn = upMid !== undefined ? data.upWarnings?.[String(upMid)] : undefined;
        if (warn) {
          vm.upWarning = {
            name: warn.name,
            categories: Object.entries(warn.categories).map(([category, count]) => ({
              category: category as MarkingEntry['category'],
              count,
            })),
          };
        }
        map.set(bvid, vm);
      }
      return map;
    } catch {
      return this.fallback.getMarkings(bvids, opts);
    }
  }
}
