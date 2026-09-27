const KEY = 'bmk_private_id';

/**
 * 私人 ID（ADR-0002）：本地生成的匿名凭证，等价于密码——
 * 只存本机、不上传；将来接服务器时以其哈希作为公开身份。
 */
export async function getOrCreatePrivateId(): Promise<string> {
  const res = await chrome.storage.local.get(KEY);
  const existing = res[KEY] as string | undefined;
  if (existing) return existing;

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ [KEY]: id });
  return id;
}

let cachedHash: string | null | undefined;

/**
 * 公开 ID（= 服务器 public_id 列，privateId 的 SHA-256）。
 * GET 时作为 as 参数：影子封禁下让本人仍可见自己的提交（GOVERNANCE.md）。
 * 公开 ID 本就是公开数据，随 GET 发送不增加暴露面。
 */
export async function getPublicIdHash(): Promise<string | null> {
  if (cachedHash !== undefined) return cachedHash;
  try {
    const pid = await getOrCreatePrivateId();
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pid));
    cachedHash = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    cachedHash = null;
  }
  return cachedHash;
}
