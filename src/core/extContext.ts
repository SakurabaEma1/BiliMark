/**
 * 扩展上下文有效性：重载/更新后，旧标签页里的旧 content script 已随旧实例失联，
 * 任何 chrome.* 访问都会 throw「Extension context invalidated」。
 * 属性访问本身也可能 throw（不只是返回 undefined），所以 try/catch 包住而非只靠可选链。
 */
export function extContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}
