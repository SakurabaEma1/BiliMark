const hint = document.getElementById('hint')!;

async function sendDemo(type: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    hint.textContent = '找不到当前标签页。';
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
    hint.textContent = '已触发，切换到 B 站标签页查看。';
  } catch {
    hint.textContent = '此页面未注入插件（需要 www.bilibili.com 页面，刷新一次页面试试）。';
  }
}

document.getElementById('demoBanner')!.addEventListener('click', () => void sendDemo('BMK_DEMO_BANNER'));
document.getElementById('demoBadges')!.addEventListener('click', () => void sendDemo('BMK_DEMO_BADGES'));
