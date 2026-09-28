import type { VideoMarkings } from './types';

export interface MarkQueryOptions {
  /** 跳过边缘缓存拿最新数据（投票/提交后的刷新用；feed 批量查询走默认缓存） */
  fresh?: boolean;
}

/**
 * 标记数据源的统一接口。
 * v0.1 为 MockProvider（本地 JSON）；接入服务器后替换为 ApiProvider，调用方不变。
 */
export interface MarkProvider {
  getMarkings(bvids: string[], opts?: MarkQueryOptions): Promise<Map<string, VideoMarkings>>;
}
