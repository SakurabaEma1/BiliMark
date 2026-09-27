import type { CategoryKey } from './types';

export interface StoredSubmission {
  bvid: string;
  category: CategoryKey;
  reason: string;
  evidence: string[];
  createdAt: number;
  /** 已同步到服务器；false/缺省 = 待同步（服务器不可达时落本地，由 background 定时重试） */
  synced?: boolean;
  /** 自声明的 B 站等级豁免（Lv6+，GOVERNANCE.md「等级豁免」） */
  claimedLv6?: boolean;
  /** 提交时快照的分区/UP 元数据：待同步重发时页面可能已切换，必须用存储值而非现读 */
  region?: number | null;
  regionV2?: number | null;
  upMid?: number | null;
  upName?: string;
}

const KEY = 'bmk_submissions';

/**
 * 本地提交存储（v0.2：无服务器阶段的落地处）。
 * 接服务器后这里变为「待同步队列」，接口形态保持不变。
 */
export async function getSubmissions(): Promise<StoredSubmission[]> {
  const res = await chrome.storage.local.get(KEY);
  return (res[KEY] as StoredSubmission[] | undefined) ?? [];
}

export async function hasSubmission(bvid: string, category: CategoryKey): Promise<boolean> {
  return (await getSubmissions()).some((s) => s.bvid === bvid && s.category === category);
}

/** 每人每视频仅一次：该视频是否已有本人的任何提交 */
export async function hasAnySubmission(bvid: string): Promise<boolean> {
  return (await getSubmissions()).some((s) => s.bvid === bvid);
}

export async function getSubmissionsForBvid(bvid: string): Promise<StoredSubmission[]> {
  return (await getSubmissions()).filter((s) => s.bvid === bvid);
}

/** 撤回：移除本人在该视频上指定分类的提交，撤回后可重新提交 */
export async function retractSubmission(bvid: string, category: CategoryKey): Promise<void> {
  const all = await getSubmissions();
  const next = all.filter((s) => !(s.bvid === bvid && s.category === category));
  await chrome.storage.local.set({ [KEY]: next });
}

export async function addSubmission(submission: StoredSubmission): Promise<void> {
  const all = await getSubmissions();
  all.push(submission);
  await chrome.storage.local.set({ [KEY]: all });
}

/** 待同步队列：服务器不可达时落本地的提交，由 background 定时重试 */
export async function getPendingSubmissions(): Promise<StoredSubmission[]> {
  return (await getSubmissions()).filter((s) => !s.synced);
}

export async function markSynced(
  bvid: string,
  category: CategoryKey,
  createdAt: number,
): Promise<void> {
  const all = await getSubmissions();
  const next = all.map((s) =>
    s.bvid === bvid && s.category === category && s.createdAt === createdAt
      ? { ...s, synced: true }
      : s,
  );
  await chrome.storage.local.set({ [KEY]: next });
}
