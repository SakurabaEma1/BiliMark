import { onUrlChange } from './bilibili/spa';
import { detectPageType } from './bilibili/dispatch';
import { parseBvidFromUrl } from './bilibili/urls';
import { VideoPageController } from './videoPage';
import { FeedController } from './feedPage';
import { mockProvider } from '../core/mockProvider';
import { ApiProvider } from '../core/apiProvider';
import { LocalMarkProvider } from '../core/localProvider';
import { extContextValid } from '../core/extContext';
import './content.css';

interface Stoppable {
  stop(): void;
}

// 扩展重载/更新瞬间，开着的小破站标签页里旧 content script 的 chrome API 调用会 reject；
// 旧实例已死、无功能可损失，只静音这一种错误（其余 rejection 照常抛出，不掩盖真 bug）。
window.addEventListener('unhandledrejection', (e) => {
  if (String(e.reason ?? '').includes('Extension context invalidated')) e.preventDefault();
});

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

  // 旧实例失联：停掉现有控制器后不再创建新的，静待页面刷新拿到新实例
  if (!extContextValid()) return;

  if (type === 'video') {
    videoCtl = new VideoPageController(provider);
    active.push(videoCtl);
    // 播放页右侧的「相关视频」列表同样需要角标
    const feed = new FeedController(provider);
    feed.start();
    active.push(feed);
  } else if (type === 'home' || type === 'search' || type === 'popular' || type === 'space') {
    const feed = new FeedController(provider);
    feed.start();
    active.push(feed);
  }
  // dynamic / other：本期不注入
}

route(location.href);
onUrlChange(route);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'BMK_REFRESH_MARKINGS') {
    videoCtl?.refresh();
    sendResponse({ ok: true });
  }
  return false;
});
