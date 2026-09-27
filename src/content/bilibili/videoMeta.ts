/**
 * 播放页视频元数据（分区 + UP 主）：来自 B 站播放页全局状态树 __INITIAL_STATE__。
 * 分区隔离墙（ADR-0004）依赖此数据——全局状态树比 DOM 选择器稳定。
 * 注意：B 站播放页 BV→BV 跳转为整页导航，每次 enter() 重新读取即可；
 * 若 B 站未来改为真 SPA 换视频，需改读其路由数据（README 已知边界）。
 */
export interface VideoMeta {
  /** v1 分区 tid（videoData.tid） */
  tid: number | null;
  /** v2 新分区 tid_v2（部分接口写 tidv2） */
  tidV2: number | null;
  tname: string;
  upMid: number | null;
  upName: string;
}

interface BiliVideoData {
  tid?: number;
  tname?: string;
  tid_v2?: number;
  tidv2?: number;
  owner?: { mid?: number; name?: string };
}

declare global {
  interface Window {
    __INITIAL_STATE__?: { videoData?: BiliVideoData };
  }
}

export function readVideoMeta(): VideoMeta | null {
  try {
    const vd = window.__INITIAL_STATE__?.videoData;
    if (!vd) return null;
    const tidV2 =
      typeof vd.tid_v2 === 'number' ? vd.tid_v2 : typeof vd.tidv2 === 'number' ? vd.tidv2 : null;
    return {
      tid: typeof vd.tid === 'number' ? vd.tid : null,
      tidV2,
      tname: typeof vd.tname === 'string' ? vd.tname : '',
      upMid: typeof vd.owner?.mid === 'number' ? vd.owner.mid : null,
      upName: typeof vd.owner?.name === 'string' ? vd.owner.name : '',
    };
  } catch {
    return null;
  }
}
