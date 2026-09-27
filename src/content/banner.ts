import type { MarkingEntry } from '../core/types';
import { categoryLabel } from '../core/types';
import { STR } from '../core/strings';
import { buildTitleTiers, mountSelfHealing } from './mount';

export interface BannerHandle {
  destroy(): void;
}

export interface BannerOptions {
  demo?: boolean;
  /** 投票需要：当前视频 BVID；提供时理由面板显示 👍/👎 */
  bvid?: string;
  /** UP 主信息（查成分外链用；来自播放页 __INITIAL_STATE__） */
  up?: { mid: number; name: string };
  /** 投票回调：POST 到服务器后由调用方刷新数据 */
  onVote?: (category: MarkingEntry['category'], vote: 1 | -1) => void;
}

/**
 * 播放页分类角标（SB 分类角标同位，非阻断原则）：
 * - 优先内联在标题文字行尾（零推挤）；B 站标题钳制异步生效，由自愈挂载持续监测并逐档回退；
 * - 理由面板是挂在 body 顶层的独立浮层（portal），按角标实时坐标定位——
 *   不进标题层级，不会被 h1 的 overflow:hidden 裁掉；
 * - 点角标开/关面板，点页面其他位置关闭；× 对本视频关闭。
 */
export function createBanner(
  entries: MarkingEntry[],
  anchor: HTMLElement,
  opts: BannerOptions = {},
): BannerHandle | null {
  if (entries.length === 0) return null;
  const confirmed = entries.filter((e) => e.status === 'confirmed');
  const pendingCount = entries.length - confirmed.length;

  const pill = document.createElement('span');
  pill.className = 'bmk-pill' + (opts.demo ? ' bmk-pill--demo' : '');

  // 纯待确认（如自己刚提交、尚无人确认）也展示——低置信，仅播放页
  const first = confirmed[0] ?? entries[0];
  const label = document.createElement('b');
  label.textContent = confirmed.length
    ? `⚠ ${categoryLabel(first.category)} · ${first.confirmCount}`
    : `⚠ ${categoryLabel(first.category)} · 待确认`;
  pill.append(label);
  if (confirmed.length > 1) pill.append(` +${confirmed.length - 1}`);
  if (confirmed.length > 0 && pendingCount > 0) {
    const pending = document.createElement('span');
    pending.className = 'bmk-pill__pending';
    pending.textContent = ` +${pendingCount}待确认`;
    pill.append(pending);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'bmk-pill__close';
  closeBtn.textContent = '×';
  closeBtn.title = STR.hideReasons;
  pill.append(closeBtn);

  // 理由面板：body 顶层 portal，绕开标题容器的 overflow 裁切
  const panel = buildDetails(entries, opts.demo ?? false, opts);
  panel.hidden = true;
  document.body.appendChild(panel);

  let destroyed = false;

  const onDocClick = (e: MouseEvent) => {
    const t = e.target as Node;
    if (panel.contains(t) || pill.contains(t)) return;
    closePanel();
  };

  const openPanel = () => {
    const r = pill.getBoundingClientRect();
    const maxLeft = window.scrollX + document.documentElement.clientWidth - 296;
    panel.style.top = `${r.bottom + window.scrollY + 6}px`;
    panel.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, maxLeft))}px`;
    panel.hidden = false;
    // 延迟到下一轮事件循环再挂 outside-click，避免吃掉本次开面板的点击
    window.setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  };

  const closePanel = () => {
    panel.hidden = true;
    document.removeEventListener('click', onDocClick, true);
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    stopMount();
    closePanel();
    pill.remove();
    panel.remove();
  };

  pill.addEventListener('click', (e) => {
    if (e.target === closeBtn) return;
    if (panel.hidden) openPanel();
    else closePanel();
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    destroy();
  });

  const tierLogs = [
    '[BiliMark] 分类角标已内联挂载到标题行尾',
    '[BiliMark] 角标被标题容器裁切，已回退到标题下方独立一行',
    '[BiliMark] 角标已回退到标题容器上方',
  ];
  const tiers = buildTitleTiers(pill, anchor, (tier) => console.info(tierLogs[tier]));
  const stopMount = mountSelfHealing(pill, tiers);

  return { destroy };
}

function buildDetails(
  entries: MarkingEntry[],
  demo: boolean,
  opts: BannerOptions = {},
): HTMLElement {
  const box = document.createElement('div');
  box.className = 'bmk-pill__panel';

  for (const e of entries) {
    const item = document.createElement('div');
    item.className =
      'bmk-details__item' + (e.status === 'pending' ? ' bmk-details__item--pending' : '');

    const head = document.createElement('div');
    head.className = 'bmk-details__head';
    head.textContent =
      `${categoryLabel(e.category)} · ${e.confirmCount}${STR.confirmUnit}` +
      (e.status === 'pending' ? ` · ${STR.pendingNote}` : '');

    const reason = document.createElement('div');
    reason.className = 'bmk-details__reason';
    reason.textContent = e.reason;

      item.append(head, reason);

      // 投票（v0.3：一人一票可改票，服务器去重）
      if (!demo && opts.bvid && opts.onVote) {
        const category = e.category;
        const votes = document.createElement('div');
        votes.className = 'bmk-details__votes';
        const up = document.createElement('button');
        up.textContent = '👍';
        up.title = '赞成此标记';
        up.addEventListener('click', (ev) => {
          ev.stopPropagation();
          opts.onVote!(category, 1);
        });
        const down = document.createElement('button');
        down.textContent = '👎';
        down.title = '反对此标记';
        down.addEventListener('click', (ev) => {
          ev.stopPropagation();
          opts.onVote!(category, -1);
        });
        votes.append(up, down);
        item.append(votes);
      }

      if (e.evidence.length > 0) {
      const ev = document.createElement('div');
      ev.className = 'bmk-details__evidence';
      ev.append(STR.evidenceLabel);
      e.evidence.forEach((href, i) => {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        a.textContent = `[${i + 1}]`;
        ev.append(a, ' ');
      });
      item.append(ev);
    }
    box.append(item);
  }

  if (demo) {
    const note = document.createElement('div');
    note.className = 'bmk-details__demo-note';
    note.textContent = STR.demoBannerNote;
    box.append(note);
  }

  // 查成分外联（CONTEXT.md「查成分外链」：纯深链跳转，不抓取不缓存第三方数据）
  if (!demo && opts.up && opts.up.mid) {
    const upRow = document.createElement('div');
    upRow.className = 'bmk-details__up';
    const a = document.createElement('a');
    a.href = `https://aicu.cc/user/${opts.up.mid}`;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = `查UP主「${opts.up.name || opts.up.mid}」成分 ↗`;
    upRow.append(a);
    box.append(upRow);
  }

  const disclaimer = document.createElement('div');
  disclaimer.className = 'bmk-details__disclaimer';
  disclaimer.textContent = STR.disclaimer;
  box.append(disclaimer);

  // 申诉（CONTEXT.md「申诉」：争议解决机制 + 法律防御；渠道常量留空则只显示文案）
  if (!demo) {
    const appeal = document.createElement('div');
    appeal.className = 'bmk-details__appeal';
    appeal.append(STR.appealNote);
    if (STR.appealUrl) {
      const a = document.createElement('a');
      a.href = STR.appealUrl;
      a.textContent = STR.appealLinkText;
      appeal.append(a, '。');
    } else {
      appeal.append('。');
    }
    box.append(appeal);
  }
  return box;
}
