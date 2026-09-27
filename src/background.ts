import { getPendingSubmissions, markSynced } from './core/submissions';
import { postMarking } from './core/api';
import { getOrCreatePrivateId } from './core/privateId';

/** 待同步队列：离线提交每小时重试；成功或 409（已在社区）即标记完成（ADR-0005 降级补全） */
async function syncPending(): Promise<void> {
  const pending = await getPendingSubmissions();
  if (pending.length === 0) return;
  const privateId = await getOrCreatePrivateId();
  for (const s of pending) {
    const { ok, status } = await postMarking({
      bvid: s.bvid,
      category: s.category,
      reason: s.reason,
      evidence: s.evidence,
      privateId,
      claimedLv6: s.claimedLv6,
      region: s.region ?? null,
      regionV2: s.regionV2 ?? null,
      upMid: s.upMid ?? null,
      upName: s.upName ?? '',
    });
    if (ok || status === 409) await markSynced(s.bvid, s.category, s.createdAt);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('bmk_sync', { periodInMinutes: 60 });
  console.log('[BiliMark] installed');
});

chrome.runtime.onStartup.addListener(() => {
  void syncPending();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bmk_sync') void syncPending();
});
