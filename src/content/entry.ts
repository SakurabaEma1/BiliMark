import { parseBvidFromUrl } from './bilibili/urls';
import { buildTitleTiers, mountSelfHealing } from './mount';
import { hasAnySubmission } from '../core/submissions';
import { toggleSubmissionPanel } from './submissionPanel';

/**
 * 播放页常驻「＋标记」入口（非阻断原则：只占标题区一角，点击才出现提交面板）。
 * 两种状态：未标记=「＋ 标记」（B站粉，醒目）；已标记=「✓ 已标记」（点击可查看/撤回）。
 * 与分类角标共用同一套自愈挂载档位；返回停止函数（SPA 路由切换时随控制器销毁）。
 */
export function mountEntryPill(anchor: HTMLElement, onChanged: () => void): () => void {
  const pill = document.createElement('span');
  pill.className = 'bmk-pill bmk-entry';
  pill.title = '标记此视频（社区众包）';

  const syncState = (): void => {
    const bvid = parseBvidFromUrl(location.href) ?? '';
    void hasAnySubmission(bvid).then((has) => {
      pill.classList.toggle('bmk-entry--done', has);
      pill.textContent = has ? '✓ 已标记' : '＋ 标记';
      pill.title = has ? '查看/撤回我的标记' : '标记此视频（社区众包）';
    });
  };
  syncState();

  pill.addEventListener('click', () => {
    toggleSubmissionPanel(pill, () => {
      syncState();
      onChanged();
    });
  });

  const tierLogs = [
    '[BiliMark] 提交入口已内联挂载到标题行尾',
    '[BiliMark] 提交入口已回退到标题下方独立一行',
    '[BiliMark] 提交入口已回退到标题容器上方',
  ];
  const tiers = buildTitleTiers(pill, anchor, (tier) => console.info(tierLogs[tier]));
  const stopMount = mountSelfHealing(pill, tiers);
  return () => {
    stopMount();
    pill.remove();
  };
}
