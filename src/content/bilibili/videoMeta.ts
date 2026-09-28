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
  /** 视频时长（秒）：随提交记录，为防换源校验留数据基础 */
  duration: number | null;
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
      data?: {
        tid?: number;
        tname?: string;
        tid_v2?: number;
        duration?: number;
        owner?: { mid?: number; name?: string };
      };
    };
    if (body.code !== 0 || !body.data) return null;
    const meta: VideoMeta = {
      tid: typeof body.data.tid === 'number' ? body.data.tid : null,
      tidV2: typeof body.data.tid_v2 === 'number' ? body.data.tid_v2 : null,
      tname: typeof body.data.tname === 'string' ? body.data.tname : '',
      upMid: typeof body.data.owner?.mid === 'number' ? body.data.owner.mid : null,
      upName: typeof body.data.owner?.name === 'string' ? body.data.owner.name : '',
      duration: typeof body.data.duration === 'number' ? body.data.duration : null,
    };
    cache.set(bvid, meta);
    return meta;
  } catch {
    return null;
  }
}

/**
 * 播放页官方 AI 生成声明检测。
 * B 站公开接口不返回该字段（view/popular 均无，2026-09 实测），但视频页信息区
 * 会渲染声明文字——DOM 在隔离世界与页面间共享，可安全读取。
 * 限定在视频信息容器内匹配，避免把评论区/简介外的"AI"字样误判为声明；
 * UP 在简介自述使用 AI 也会命中，符合"视频内使用了 AI"的中性语义。
 */
export function readAiDeclaredFromDom(): boolean {
  try {
    const scope = document.querySelector('#viewbox_report, .video-info-container');
    if (!scope) return false;
    const text = (scope.textContent ?? '').slice(0, 2000);
    return /AI\s*生成|生成式\s*AI|人工智能生成/.test(text);
  } catch {
    return false;
  }
}
