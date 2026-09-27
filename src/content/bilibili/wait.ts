/**
 * 等待任一候选选择器出现（B 站页面由前端框架渲染，锚点出现时机不定）。
 * 超时后返回此刻的查询结果（可能为 null），调用方自行降级。
 */
export function waitFor(selectors: string[], timeoutMs: number): Promise<Element | null> {
  return waitForPredicate(
    () => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    },
    timeoutMs,
  ).then((el) => el as Element | null);
}

/** 等待自定义条件成立（MutationObserver 驱动，超时返回当前判定结果） */
export function waitForPredicate<T>(
  predicate: () => T,
  timeoutMs: number,
): Promise<T | null> {
  const immediate = predicate();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const result = predicate();
      if (result) {
        observer.disconnect();
        resolve(result);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => {
      observer.disconnect();
      resolve(predicate() || null);
    }, timeoutMs);
  });
}
