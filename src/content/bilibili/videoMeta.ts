/**
 * 播放页视频元数据（分区 + UP 主）：调 B 站公开 view API 获取，按 bvid 会话内缓存。
 * 不能读 window.__INITIAL_STATE__——content script 运行在隔离世界，读不到页面 JS
 * 设置的全局变量（走查实测永远 undefined → fail-closed 会误杀全部播放页）。
 * view API 与 bilibiliAccount.ts 的 nav 接口同款模式：页面上下文 fetch，
 * B 站 CORS 允许 www.bilibili.com origin，无需登录。
 * 拿不到 → 返回 null → 播放页不注入（ADR-0004 分区隔离墙 fail-closed）。
 */
export interface VideoMeta {
  /** v1 分区 tid（data.tid） */
  tid: number | null;
  /** v2 新分区 tid_v2（部分接口写 tidv2） */
  tidV2: number | null;
  tname: string;
  upMid: number | null;
  upName: string;
}

const cache = new Map<string, VideoMeta>();

export async function readVideoMeta(bvid: string): Promise<VideoMeta | null> {
  const hit = cache.get(bvid);
  if (hit) return hit;
  try {
    const res = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    const body = (await res.json()) as {
      code?: number;
      data?: { tid?: number; tname?: string; tid_v2?: number; owner?: { mid?: number; name?: string } };
    };
    if (body.code !== 0 || !body.data) return null;
    const meta: VideoMeta = {
      tid: typeof body.data.tid === 'number' ? body.data.tid : null,
      tidV2: typeof body.data.tid_v2 === 'number' ? body.data.tid_v2 : null,
      tname: typeof body.data.tname === 'string' ? body.data.tname : '',
      upMid: typeof body.data.owner?.mid === 'number' ? body.data.owner.mid : null,
      upName: typeof body.data.owner?.name === 'string' ? body.data.owner.name : '',
    };
    cache.set(bvid, meta);
    return meta;
  } catch {
    return null;
  }
}
