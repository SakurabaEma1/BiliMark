import { getApiBase } from '../core/api';

const manifest = chrome.runtime.getManifest();

// 版本号从 manifest 动态取，避免与构建产物漂移
const verEl = document.getElementById('ver');
if (verEl) verEl.textContent = `v${manifest.version}`;

// 显示当前连接的服务器：确认安装后是否指向正式环境（选项页可改）
void getApiBase().then((base) => {
  const el = document.getElementById('serverBase');
  if (el) el.textContent = base;
});

/**
 * 更新检查：对比服务器版本与本地 manifest，仅在有新版本时显示下载链接。
 * 非阻断姿态：离线/服务器不可达/版本相同时全部静默。
 */
function isNewer(remote: string, local: string): boolean {
  const seg = (s: string) => s.split('.').map((n) => parseInt(n, 10) || 0);
  const a = seg(remote);
  const b = seg(local);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

void (async () => {
  try {
    const base = await getApiBase();
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    if (!data.version || !isNewer(data.version, manifest.version)) return;
    document.getElementById('update')?.removeAttribute('hidden');
  } catch {
    // 静默：更新检查失败不影响弹窗其他功能
  }
})();
