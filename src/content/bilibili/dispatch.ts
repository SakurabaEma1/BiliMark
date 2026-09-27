export type PageType = 'video' | 'home' | 'search' | 'popular' | 'dynamic' | 'other';

export function detectPageType(url: URL): PageType {
  const p = url.pathname;
  if (p.startsWith('/video/')) return 'video';
  if (p === '/' || p === '/index.html') return 'home';
  if (p === '/all' || p.startsWith('/all')) return 'search';
  if (p.startsWith('/v/')) return 'popular';
  if (p.startsWith('/opus/') || p === '/dyn' || p.startsWith('/dyn/')) return 'dynamic';
  return 'other';
}
