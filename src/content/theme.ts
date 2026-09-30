/**
 * 主题自适应（非阻断原则的延伸）：插件样式默认按夜间页面调校，
 * 浅色页面下同样式会过于显眼。不依赖B站内部暗色类名（易随改版失效），
 * 而是沿挂载点向上采样第一个不透明背景的亮度——对任何页面的主题实现都成立。
 * 浅色判定通过后给根元素加 bmk-light，CSS 变量整体切换浅色调色板。
 */

/** 从元素沿父链向上找第一个不透明背景，按亮度判断是否浅色页面 */
export function isLightSurface(start: HTMLElement | null): boolean {
  let node: HTMLElement | null = start;
  for (let i = 0; node && i < 12; i++, node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    const m = /rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)\s*(?:[,/]\s*([\d.]+)\s*)?\)/.exec(bg);
    if (!m) continue;
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (alpha < 0.1) continue; // 全透明背景，继续向上
    const luminance = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
    if (luminance > 0.6) return true;
    if (luminance < 0.35) return false;
    // 中间亮度：继续向上找更明确的页面背景
  }
  // 找不到明确背景（全部透明）：按B站默认浅色处理
  return true;
}

/** 给自绘根元素打主题类；anchor 为其挂载环境的参照（面板类 body 门户可省略） */
export function applyTheme(el: HTMLElement, anchor?: HTMLElement | null): void {
  if (isLightSurface(anchor ?? document.body)) el.classList.add('bmk-light');
}
