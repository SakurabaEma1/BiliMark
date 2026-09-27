import type { CategoryKey } from './types';

/** 默认 API 基址：开发环境本地服务器。生产环境在扩展选项页配置正式域名。 */
export const DEFAULT_API_BASE = 'http://127.0.0.1:8787';

const KEY = 'bmk_api_base';
let cachedBase: string | null = null;

/** API 基址（选项页可配置，storage.sync 持久化；进程内缓存避免每次读存储） */
export async function getApiBase(): Promise<string> {
  if (cachedBase) return cachedBase;
  try {
    const res = await chrome.storage.sync.get(KEY);
    cachedBase = (res[KEY] as string | undefined) ?? DEFAULT_API_BASE;
  } catch {
    cachedBase = DEFAULT_API_BASE;
  }
  return cachedBase;
}

export function setApiBase(url: string): Promise<void> {
  cachedBase = url;
  return chrome.storage.sync.set({ [KEY]: url });
}

export interface MarkingPayload {
  bvid: string;
  category: CategoryKey;
  reason: string;
  evidence: string[];
  privateId: string;
  /** 自声明的 B 站等级豁免（Lv6+）；服务器按 GOVERNANCE.md 抽查制对待 */
  claimedLv6?: boolean;
}

export interface VotePayload {
  bvid: string;
  category: CategoryKey;
  vote: 1 | -1;
  privateId: string;
}

/**
 * 提交标记到服务器。返回 HTTP 状态码供调用方区分：
 * ok=成功；409=已存在（视为同步完成）；其余/网络失败=未同步。
 */
export async function postMarking(
  payload: MarkingPayload,
): Promise<{ ok: boolean; status: number }> {
  try {
    const base = await getApiBase();
    const res = await fetch(`${base}/api/markings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** 投票（一人一票可改票，服务器去重）；失败静默（下次投票或刷新自然重试） */
export async function postVote(payload: VotePayload): Promise<boolean> {
  try {
    const base = await getApiBase();
    const res = await fetch(`${base}/api/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
