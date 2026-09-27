import type { VideoMarkings } from './types';

/**
 * 标记数据源的统一接口。
 * v0.1 为 MockProvider（本地 JSON）；接入服务器后替换为 ApiProvider，调用方不变。
 */
export interface MarkProvider {
  getMarkings(bvids: string[]): Promise<Map<string, VideoMarkings>>;
}
