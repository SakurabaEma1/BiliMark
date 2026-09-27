import type { MarkProvider } from './provider';
import type { VideoMarkings } from './types';
import mockData from '../../mocks/markings.json';

const LATENCY_MIN = 120;
const LATENCY_MAX = 350;

/** 模拟真实 API 的网络延迟与批量查询形态 */
export const mockProvider: MarkProvider = {
  getMarkings(bvids: string[]): Promise<Map<string, VideoMarkings>> {
    const latency = LATENCY_MIN + Math.random() * (LATENCY_MAX - LATENCY_MIN);
    return new Promise((resolve) => {
      window.setTimeout(() => {
        const map = new Map<string, VideoMarkings>();
        const store = mockData as Record<string, VideoMarkings>;
        for (const bvid of bvids) {
          const hit = store[bvid];
          if (hit) map.set(bvid, hit);
        }
        resolve(map);
      }, latency);
    });
  },
};
