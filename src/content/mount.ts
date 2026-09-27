export interface MountTier {
  mount: () => void;
  /** 该档位的裁切检测宿主；null 表示兜底档（不再检测） */
  host: Element | null;
}

const CHECK_DELAYS_MS = [100, 400, 1000, 2000, 3500, 5000];
const CLIP_TOLERANCE_PX = 4;

/**
 * 自愈式挂载：B 站标题的行数钳制是异步生效的，一次性验证挡不住，
 * 在 100ms~5s 设检查点持续监测当前档位，被裁切就升级到下一档。
 * 关键一：初始挂载不走 detached 检查——此时元素尚未入 DOM 属正常状态，
 * 把「未挂载」当「已销毁」会让角标永远挂不上去（已踩过的致命坑）。
 * 关键二：detached 有两种成因——用户销毁（stopped）与 B 站首屏水合把标题区
 * 子树整个重渲染清掉（「刷新时在、刷新完没了」的根因）。后者要重挂当前档位自愈。
 * 关键三：升级必须双帧确认（120ms 后复测）——单帧测量会被面板关闭/布局过渡期的
 * 瞬时状态骗到，把本来可见的内联角标错误升到容器外，且档位只升不降、错误就此凝固
 * （「提交后跑到标题左边、刷新后才恢复正常」的根因）。
 */
export function mountSelfHealing(pill: HTMLElement, tiers: MountTier[]): () => void {
  let tierIndex = -1;
  let stopped = false;
  const timers: number[] = [];

  const mountTier = (index: number): void => {
    pill.remove();
    tierIndex = index;
    tiers[index].mount();
    orderSiblings(pill);
  };

  /** 双帧确认后才升级 */
  const maybeEscalate = (): void => {
    if (stopped || !pill.isConnected) return;
    if (tierIndex >= tiers.length - 1) return;
    const host = tiers[tierIndex].host;
    if (!host || !isClipped(pill, host)) return;
    window.setTimeout(() => {
      if (stopped || !pill.isConnected) return;
      const h = tiers[tierIndex].host;
      if (h && isClipped(pill, h) && tierIndex < tiers.length - 1) {
        mountTier(tierIndex + 1);
      }
    }, 120);
  };

  mountTier(0);

  for (const ms of CHECK_DELAYS_MS) {
    timers.push(
      window.setTimeout(() => {
        if (stopped) return;
        if (!pill.isConnected) {
          // 非用户销毁的脱离：B 站首屏水合把标题区子树重渲染清掉了，重挂当前档位自愈
          mountTier(tierIndex);
          return;
        }
        maybeEscalate();
      }, ms),
    );
  }

  return () => {
    stopped = true;
    timers.forEach((t) => window.clearTimeout(t));
  };
}

/**
 * 同一容器内的自家角标按固定角色排序（入口在前、分类角标在后）。
 * 两个角标各自独立挂载/重挂，append 顺序取决于水合时机与定时器竞态——
 * 不排序的话每次刷新位置都会互换。重排只在自身兄弟间移动节点，不动宿主其他内容。
 */
function orderSiblings(pill: HTMLElement): void {
  const parent = pill.parentElement;
  if (!parent) return;
  const pills = Array.from(
    parent.querySelectorAll<HTMLElement>(':scope > .bmk-pill'),
  );
  if (pills.length < 2) return;
  const rank = (el: Element): number => (el.classList.contains('bmk-entry') ? 0 : 1);
  const sorted = [...pills].sort((a, b) => rank(a) - rank(b));
  if (sorted.every((el, i) => el === pills[i])) return;
  const next = pills[0].nextSibling;
  for (let i = sorted.length - 1; i >= 0; i--) {
    parent.insertBefore(sorted[i], next);
  }
}

/** 标题区三档位：内联标题文字行尾（零推挤）→ 标题下方独立行 → 标题容器上方 */
export function buildTitleTiers(
  pill: HTMLElement,
  anchor: HTMLElement,
  onTierMounted?: (tier: number) => void,
): MountTier[] {
  const titleEl =
    (anchor.matches('h1') ? anchor : anchor.querySelector('h1')) ??
    anchor.querySelector('.video-title');

  const tiers: MountTier[] = [];
  if (titleEl) {
    tiers.push({
      mount: () => {
        // 排除自家角标：我们自己的 pill 就是 span，不加排除会把彼此当挂载点
        // 互相吞进肚子里（「胶囊圈住＋标记」的根因）
        const textSpan = titleEl.querySelector(':scope > span:not([class*="bmk-"])');
        (textSpan ?? titleEl).appendChild(pill);
        onTierMounted?.(0);
      },
      host: titleEl,
    });
    if (titleEl.parentElement) {
      tiers.push({
        mount: () => {
          pill.classList.add('bmk-pill--line');
          titleEl.parentElement!.insertBefore(pill, titleEl.nextSibling);
          onTierMounted?.(1);
        },
        host: titleEl.parentElement,
      });
    }
  }
  tiers.push({
    mount: () => {
      const container = anchor.parentElement;
      if (!container) return;
      pill.classList.add('bmk-pill--line');
      container.insertBefore(pill, anchor);
      onTierMounted?.(2);
    },
    host: null,
  });
  return tiers;
}

/** 是否被裁切/不可见：line-clamp 会把超行内容视觉裁掉但矩形仍在，必须比矩形；容差 4px 吸收 vertical-align 微溢出 */
export function isClipped(el: HTMLElement, clipHost: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return true;
  const h = clipHost.getBoundingClientRect();
  return r.bottom > h.bottom + CLIP_TOLERANCE_PX || r.top < h.top - CLIP_TOLERANCE_PX;
}

export function isDetached(el: HTMLElement): boolean {
  return !el.isConnected;
}
