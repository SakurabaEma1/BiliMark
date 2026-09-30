import { parseBvidFromUrl } from './bilibili/urls';
import type { MarkProvider } from '../core/provider';
import type { MarkingEntry, VideoMarkings } from '../core/types';
import { categoryLabel } from '../core/types';
import { applyTheme } from './theme';
import { STR } from '../core/strings';

/** 视频卡片候选选择器：首页 / 搜索 / 热门 / 播放页右侧「相关视频」/ UP 空间页（属性包含匹配，兼容变体类名） */
export const CARD_SELECTORS = [
  '[class*="bili-video-card"]', // 首页/搜索/热门（新版，含 __info 等 BEM 变体）
  '[class*="video-page-card"]', // 播放页右侧相关视频（含 small/big 变体）
  '.video-list-item', // 搜索页（旧版）
  '.small-item', // UP 空间页投稿列表（space.bilibili.com）
];

const SCAN_THROTTLE_MS = 150;
const BATCH_DEBOUNCE_MS = 300;

/**
 * Feed 控制器：扫描视频卡片 → 按 BVID 批量拉取 → 右下角贴角标。
 * 只展示「已确认」条目（低置信展示规则：待确认不出现在推荐流）。
 */
export class FeedController {
  private processed = new WeakSet<Element>();
  private observer: MutationObserver | null = null;
  private scanTimer: number | null = null;
  private flushTimer: number | null = null;
  private queue = new Map<string, Element[]>();
  private inFlight = false;

  constructor(private provider: MarkProvider) {}

  start(): void {
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.scheduleScan();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.scanTimer = null;
    this.flushTimer = null;
  }

  private scheduleScan(): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, SCAN_THROTTLE_MS);
  }

  private scan(): void {
    let added = false;
    for (const sel of CARD_SELECTORS) {
      for (const card of document.querySelectorAll(sel)) {
        if (this.processed.has(card)) continue;
        // 属性包含选择器会同时命中卡片与其子元素（如 __info），只取最外层
        if (card.parentElement?.closest(sel)) continue;
        this.processed.add(card);
        const link = (card.matches('a[href]')
          ? card
          : card.querySelector('a[href*="/video/"]')) as HTMLAnchorElement | null;
        if (!link) continue;
        const bvid = parseBvidFromUrl(link.href);
        if (!bvid) continue;
        const list = this.queue.get(bvid) ?? [];
        list.push(card);
        this.queue.set(bvid, list);
        added = true;
      }
    }
    if (added) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => void this.flush(), BATCH_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (this.inFlight) {
      this.scheduleFlush();
      return;
    }
    this.inFlight = true;
    const batch = new Map(this.queue);
    this.queue.clear();
    try {
      const result = await this.provider.getMarkings([...batch.keys()]);
      for (const [bvid, cards] of batch) {
        const vm = result.get(bvid);
        if (!vm) continue;
        for (const card of cards) paintBadge(card as HTMLElement, vm);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

export function paintBadge(card: HTMLElement, vm: VideoMarkings): void {
  if (card.querySelector('.bmk-chip')) return;
  const entries = vm.entries.filter((e) => e.status === 'confirmed');
  if (entries.length === 0) return;

  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

  const chip = document.createElement('div');
  chip.className = 'bmk-chip';

  const label = document.createElement('span');
  label.className = 'bmk-chip__label';
  label.textContent = `⚠ ${categoryLabel(entries[0].category)} · ${entries[0].confirmCount}`;

  chip.append(label);
  // 官方 AI 生成声明（中性标注）：小灰标，不代表低质判定（低质判定走「低创」分类）
  if (vm.aiDeclared) {
    const ai = document.createElement('span');
    ai.className = 'bmk-chip__ai';
    ai.textContent = 'AI';
    ai.title = '官方标注：本视频含 AI 生成内容（不代表低质判定）';
    chip.append(ai);
  }
  chip.append(buildTip(entries, vm.upWarning));
  card.appendChild(chip);
  applyTheme(chip, card); // 浅色页面切换浅色调色板
}

function buildTip(entries: MarkingEntry[], upWarning?: VideoMarkings['upWarning']): HTMLElement {
  const tip = document.createElement('div');
  tip.className = 'bmk-chip__tip';

  // UP主警示（派生聚合，CONTEXT.md）：悬浮详情顶部一行原始计数
  if (upWarning && upWarning.categories.length > 0) {
    for (const c of upWarning.categories) {
      const warn = document.createElement('div');
      warn.className = 'bmk-chip__tip-upwarning';
      warn.textContent = `⚠ 该UP主有 ${c.count} 个视频被确认「${categoryLabel(c.category)}」`;
      tip.append(warn);
    }
  }

  for (const e of entries) {
    const line = document.createElement('div');
    line.className = 'bmk-chip__tip-line';
    const head = document.createElement('b');
    head.textContent = `${categoryLabel(e.category)} · ${e.confirmCount}${STR.confirmUnit}`;
    const reason = document.createElement('span');
    reason.textContent = e.reason;
    line.append(head, reason);
    tip.append(line);
  }

  const foot = document.createElement('div');
  foot.className = 'bmk-chip__tip-foot';
  foot.textContent = STR.disclaimer;
  tip.append(foot);
  return tip;
}
