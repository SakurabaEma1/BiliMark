import type { MarkProvider } from './provider';
import type { VideoMarkings } from './types';
import { getSubmissions } from './submissions';

/**
 * 基础数据源 + 本地提交合并。
 * 自己的提交以「待确认」状态对本人可见（提交反馈闭环，CONTEXT.md「低置信展示」）：
 * 只出现在播放页角标，推荐流角标仍只展示「已确认」（feedPage 侧过滤）。
 */
export class LocalMarkProvider implements MarkProvider {
  constructor(private base: MarkProvider) {}

  async getMarkings(
    bvids: string[],
    opts?: { fresh?: boolean },
  ): Promise<Map<string, VideoMarkings>> {
    const result = await this.base.getMarkings(bvids, opts);
    const submissions = await getSubmissions();
    if (submissions.length === 0) return result;

    for (const bvid of bvids) {
      const own = submissions.filter((s) => s.bvid === bvid);
      if (own.length === 0) continue;
      const vm: VideoMarkings = result.get(bvid) ?? { bvid, entries: [] };
      for (const s of own) {
        // 该分类已有数据（含社区已确认）时不再叠加自己的待确认副本
        if (vm.entries.some((e) => e.category === s.category)) continue;
        vm.entries.push({
          category: s.category,
          status: 'pending',
          confirmCount: 1,
          againstCount: 0,
          reason: s.reason,
          evidence: s.evidence,
        });
      }
      result.set(bvid, vm);
    }
    return result;
  }
}
