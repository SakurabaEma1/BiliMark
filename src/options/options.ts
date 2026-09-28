import { DEFAULT_API_BASE, getApiBase, setApiBase } from '../core/api';

const input = document.getElementById('apiBase') as HTMLInputElement;
const hint = document.getElementById('hint')!;

function setHint(text: string, kind: '' | 'ok' | 'err' = ''): void {
  hint.textContent = text;
  hint.className = kind;
}

void getApiBase().then((base) => (input.value = base));

document.getElementById('save')!.addEventListener('click', () => {
  const url = input.value.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) {
    setHint('地址需要 http:// 或 https:// 开头。', 'err');
    return;
  }
  void setApiBase(url || DEFAULT_API_BASE).then(() => {
    setHint('✓ 已保存。刷新 B 站页面后生效。', 'ok');
  });
});

document.getElementById('reset')!.addEventListener('click', () => {
  input.value = DEFAULT_API_BASE;
  void setApiBase(DEFAULT_API_BASE).then(() => {
    setHint('✓ 已恢复默认（正式服务器）。', 'ok');
  });
});
