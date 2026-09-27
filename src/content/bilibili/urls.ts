const BVID_RE = /(BV[0-9A-Za-z]{10})/;

/** 从任意 B 站 URL（location.href 或卡片链接）中提取 BVID */
export function parseBvidFromUrl(url: string): string | null {
  const m = url.match(BVID_RE);
  return m ? m[1] : null;
}
