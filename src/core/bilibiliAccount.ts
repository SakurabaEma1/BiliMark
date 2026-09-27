let cachedLevel: number | null | undefined;

/**
 * 读取当前浏览器登录的 B 站账号等级。
 * Content script 在 bilibili 页面上下文内携带 cookie 调用 nav 接口（BiliScope 同款模式）。
 * 用于 Lv6 豁免新手期（GOVERNANCE.md「等级豁免」：自声明 + 抽查）。
 * 失败返回 null → 不豁免（fail-closed）。
 */
export async function getOwnLevel(): Promise<number | null> {
  if (cachedLevel !== undefined) return cachedLevel;
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials: 'include',
      signal: AbortSignal.timeout(3000),
    });
    const data = (await res.json()) as { data?: { level?: number } };
    cachedLevel = typeof data?.data?.level === 'number' ? data.data.level : null;
  } catch {
    cachedLevel = null;
  }
  return cachedLevel;
}
