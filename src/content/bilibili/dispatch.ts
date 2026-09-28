export type PageType = 'video' | 'home' | 'search' | 'popular' | 'dynamic' | 'space' | 'other';

export function detectPageType(url: URL): PageType {
  // UP 主个人空间（独立子域，content_scripts 已匹配）：视频列表走 feed 角标管线
  if (url.hostname === 'space.bilibili.com') return 'space';
  const p = url.pathname;
  if (p.startsWith('/video/')) return 'video';
  if (p === '/' || p === '/index.html') return 'home';
  if (p === '/all' || p.startsWith('/all')) return 'search';
  if (p.startsWith('/v/')) return 'popular';
  if (p.startsWith('/opus/') || p === '/dyn' || p.startsWith('/dyn/')) return 'dynamic';
  return 'other';
}
