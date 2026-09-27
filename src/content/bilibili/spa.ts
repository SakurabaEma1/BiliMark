/**
 * B 站是 SPA（pushState 路由）与整页跳转混合，
 * 因此同时 hook history API、监听 popstate，并加低频兜底轮询。
 */
export function onUrlChange(cb: (url: string) => void): void {
  let last = location.href;

  const notify = () => {
    if (location.href !== last) {
      last = location.href;
      cb(last);
    }
  };

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  history.pushState = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ) {
    const ret = origPush(data, unused, url);
    queueMicrotask(notify);
    return ret;
  } as typeof history.pushState;

  history.replaceState = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ) {
    const ret = origReplace(data, unused, url);
    queueMicrotask(notify);
    return ret;
  } as typeof history.replaceState;

  window.addEventListener('popstate', notify);
  window.setInterval(notify, 800);
}
