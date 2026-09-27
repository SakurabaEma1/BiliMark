import { waitFor } from './bilibili/wait';
import { createBanner } from './banner';
import { ANCHOR_CANDIDATES } from './videoPage';
import { CARD_SELECTORS } from './feedPage';
import type { MarkingEntry } from '../core/types';
import { STR } from '../core/strings';

const DEMO_ENTRIES: MarkingEntry[] = [
  {
    category: 'ai_low_effort',
    status: 'confirmed',
    confirmCount: 3,
    againstCount: 0,
    reason: '演示理由：封面一张图，AI 配音朗读文案，信息量为零。',
    evidence: [],
  },
];

const DEMO_BADGE_TARGET = 6;

let demoBanner: { destroy(): void } | null = null;

/** Popup 演示按钮：在当前播放页强挂一条演示角标（与真实数据同管线） */
export async function showDemoBanner(): Promise<void> {
  const anchor = await waitFor(ANCHOR_CANDIDATES, 8000);
  if (!anchor) {
    console.warn(
      '[BiliMark] 未找到标题区锚点，演示角标未渲染。候选选择器：',
      ANCHOR_CANDIDATES,
      '——请截图该视频页 DOM 结构反馈，补齐候选即可。',
    );
    return;
  }
  demoBanner?.destroy();
  demoBanner = createBanner(DEMO_ENTRIES, anchor as HTMLElement, { demo: true });
}

/** Popup 演示按钮：给前 N 个可见卡片贴演示角标（醒目的「演示」样式，避免与真实标记混淆） */
export function showDemoBadges(): void {
  let painted = 0;
  for (const sel of CARD_SELECTORS) {
    for (const card of document.querySelectorAll(sel)) {
      if (painted >= DEMO_BADGE_TARGET) return;
      const el = card as HTMLElement;
      if (el.querySelector('.bmk-chip')) continue;
      paintDemoBadge(el);
      painted++;
    }
  }
}

function paintDemoBadge(card: HTMLElement): void {
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

  const chip = document.createElement('div');
  chip.className = 'bmk-chip bmk-chip--demo';

  const label = document.createElement('span');
  label.className = 'bmk-chip__label';
  label.textContent = STR.demoChipLabel;

  const tip = document.createElement('div');
  tip.className = 'bmk-chip__tip';
  tip.textContent = STR.demoTip;

  chip.append(label, tip);
  card.appendChild(chip);
}
