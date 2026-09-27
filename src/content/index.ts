import { onUrlChange } from './bilibili/spa';
import { detectPageType } from './bilibili/dispatch';
import { parseBvidFromUrl } from './bilibili/urls';
import { VideoPageController } from './videoPage';
import { FeedController } from './feedPage';
import { mockProvider } from '../core/mockProvider';
import { ApiProvider } from '../core/apiProvider';
import { LocalMarkProvider } from '../core/localProvider';
import { showDemoBanner, showDemoBadges } from './demo';
import './content.css';

interface Stoppable {
  stop(): void;
}

// 服务器（真实数据）→ 不可达时回退 Mock；本地提交以「待确认」对本人可见
const provider = new LocalMarkProvider(new ApiProvider(mockProvider));

let active: Stoppable[] = [];
let videoCtl: VideoPageController | null = null;
let currentKey = '';

function route(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  const type = detectPageType(url);
  const bvid = type === 'video' ? (parseBvidFromUrl(rawUrl) ?? '') : '';
  const key = `${type}:${bvid}`;
  if (key === currentKey) return;
  currentKey = key;

  for (const c of active) c.stop();
  active = [];
  videoCtl = null;

  if (type === 'video') {
    videoCtl = new VideoPageController(provider);
    active.push(videoCtl);
    // 播放页右侧的「相关视频」列表同样需要角标
    const feed = new FeedController(provider);
    feed.start();
    active.push(feed);
  } else if (type === 'home' || type === 'search' || type === 'popular') {
    const feed = new FeedController(provider);
    feed.start();
    active.push(feed);
  }
  // dynamic / other：本期不注入
}

route(location.href);
onUrlChange(route);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'BMK_DEMO_BANNER') {
    void showDemoBanner();
    sendResponse({ ok: true });
  } else if (msg && msg.type === 'BMK_DEMO_BADGES') {
    showDemoBadges();
    sendResponse({ ok: true });
  } else if (msg && msg.type === 'BMK_REFRESH_MARKINGS') {
    videoCtl?.refresh();
    sendResponse({ ok: true });
  }
  return false;
});
