import { getApiBase } from './api';
import { getPublicIdHash } from './privateId';
import type { MarkProvider } from './provider';
import type { MarkingEntry, VideoMarkings } from './types';

/**
 * 服务器数据源：批量查询（视频,分类）聚合结果。
 * 服务器不可达时回退到 fallback（Mock），本地提交闭环与演示不受影响——
 * ADR-0005 的优雅降级要求：插件端永远可用，只是数据新鲜度降级。
 */
export class ApiProvider implements MarkProvider {
  constructor(private fallback: MarkProvider) {}

  async getMarkings(bvids: string[]): Promise<Map<string, VideoMarkings>> {
    try {
      const base = await getApiBase();
      const query = bvids.map(encodeURIComponent).join(',');
      // as=本人公开 ID：影子封禁下本人仍可见自己的提交（GOVERNANCE.md）
      const as = await getPublicIdHash();
      const res = await fetch(
        `${base}/api/markings?bvids=${query}${as ? `&as=${as}` : ''}`,
        {
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        markings: Record<string, MarkingEntry[]>;
      };
      const map = new Map<string, VideoMarkings>();
      for (const bvid of bvids) {
        const entries = data.markings?.[bvid];
        if (entries && entries.length > 0) map.set(bvid, { bvid, entries });
      }
      return map;
    } catch {
      return this.fallback.getMarkings(bvids);
    }
  }
}
