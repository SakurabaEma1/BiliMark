import { getApiBase } from '../core/api';

// 显示当前连接的服务器：确认安装后是否指向正式环境（选项页可改）
void getApiBase().then((base) => {
  const el = document.getElementById('serverBase');
  if (el) el.textContent = base;
});
