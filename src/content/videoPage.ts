import { parseBvidFromUrl } from './bilibili/urls';
import { waitFor, waitForPredicate } from './bilibili/wait';
import { readVideoMeta } from './bilibili/videoMeta';
import { isSensitiveZone } from '../core/sensitiveZones';
import { createBanner, type BannerHandle } from './banner';
import { mountEntryPill } from './entry';
import { postVote } from '../core/api';
import { getOrCreatePrivateId } from '../core/privateId';
import type { MarkProvider } from '../core/provider';
import type { CategoryKey } from '../core/types';

/** 角标锚点候选：标题/信息区容器（在其内部寻找标题 h1 挂内联角标，SB 分类角标同位） */
export const ANCHOR_CANDIDATES = [
  '#viewbox_report',
  '.video-info-container',
  '.left-container',
  '#playerWrap',
];
const ANCHOR_TIMEOUT_MS = 15000;

/**
 * 播放页控制器：按 BVID 拉取标记并挂提示条。
 * token 防止「拉取期间用户已切到下一个视频」的竞态把旧 UI 写进新视频。
 */
export class VideoPageController {
  private banner: BannerHandle | null = null;
  private entryStop: (() => void) | null = null;
  private token = 0;

  constructor(private provider: MarkProvider) {
    void this.enter(location.href);
  }

  private async enter(url: string): Promise<void> {
    const bvid = parseBvidFromUrl(url);
    if (!bvid) return;

    // 分区隔离墙（ADR-0004，fail-closed）：分区不可判定或命中高敏清单时，播放页不注入任何 UI。
    // 合规优先于可用性——宁可漏提醒，不可在高敏分区出现「社区标记」。
    const meta = readVideoMeta();
    if (!meta || (meta.tid === null && meta.tidV2 === null)) {
      console.warn('[BiliMark] 无法判定视频分区，按隔离墙策略跳过注入（fail-closed）');
      return;
    }
    if (isSensitiveZone(meta.tid, meta.tidV2)) {
      console.info(`[BiliMark] 高敏分区（${meta.tname || '未知'}），不启用标记与提醒（分区隔离墙）`);
      return;
    }

    const myToken = ++this.token;

    this.banner?.destroy();
    this.banner = null;

    const anchor = await waitFor(ANCHOR_CANDIDATES, ANCHOR_TIMEOUT_MS);
    if (myToken !== this.token || !anchor) return;

    // 等标题文本 span 出现（B 站水合完成的标志）再挂入口：
    // 否则入口会在水合前进 h1 裸文本态、分类角标在水合后进 span，两个角标分属
    // 不同父容器，排序失效且第一帧与后续位置不一致。
    // 超时 1s：宁可先出现再由自愈机制修正位置，也不让用户干等
    const el = anchor as HTMLElement;
    await waitForPredicate(() => {
      const h1 = el.matches('h1') ? el : el.querySelector('h1');
      return !!h1?.querySelector(':scope > span:not([class*="bmk-"])');
    }, 1000);
    if (myToken !== this.token) return;

    // 常驻提交入口（不依赖数据）；标记数据异步拉取
    if (!this.entryStop) {
      this.entryStop = mountEntryPill(el, () => this.refresh());
    }

    const result = await this.provider.getMarkings([bvid]);
    if (myToken !== this.token) return;

    const vm = result.get(bvid);
    if (!vm) return;
    this.banner = createBanner(vm.entries, anchor as HTMLElement, {
      bvid,
      up: meta.upMid !== null ? { mid: meta.upMid, name: meta.upName } : undefined,
      onVote: (category, v) => {
        void this.vote(bvid, category, v);
      },
    });
  }

  /** 面板内 👍/👎：POST 到服务器后刷新聚合结果 */
  private async vote(bvid: string, category: CategoryKey, v: 1 | -1): Promise<void> {
    const privateId = await getOrCreatePrivateId();
    await postVote({ bvid, category, vote: v, privateId });
    this.refresh();
  }

  stop(): void {
    this.token++;
    this.entryStop?.();
    this.entryStop = null;
    this.banner?.destroy();
    this.banner = null;
  }

  /** 本地提交后刷新当前视频的标记数据（提交反馈闭环） */
  refresh(): void {
    void this.enter(location.href);
  }
}
