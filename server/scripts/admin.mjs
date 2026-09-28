#!/usr/bin/env node
/**
 * BiliMark 管理工具：唯一管理员的服务器治理命令行（零依赖，node >= 18）。
 *
 * 用法：node scripts/admin.mjs <命令> [参数]
 * 密钥读取顺序：--key 参数 > 环境变量 BILIMARK_ADMIN_KEY > server/.admin-key 文件
 * 服务器地址：--base 参数（默认 https://api.bilimark.top；本地调试用 --base http://127.0.0.1:8787）
 *
 * 命令：
 *   setkey <key>          保存密钥到 server/.admin-key（只需做一次，之后命令免输）
 *   health                服务器健康与总量
 *   recent [数量]          最近提交清单（含 public_id，定位恶意者用）
 *   claimed               声明了 Lv6 豁免的提交清单（抽查用）
 *   revoke <提交id>        撤销某条提交的 Lv6 豁免（抽查发现造假时）
 *   ban <publicId> [备注]  影子封禁（其内容对全网隐藏，本人可见）
 *   unban <publicId>      解除影子封禁
 *   export [文件名]        下载全量发布 database.json（接管/备份）
 *   help
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const KEYFILE = join(here, '..', '.admin-key');

const readKeyFile = () => (existsSync(KEYFILE) ? readFileSync(KEYFILE, 'utf-8').trim() : '');
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const KEY = flag('--key') ?? process.env.BILIMARK_ADMIN_KEY ?? readKeyFile();
const BASE = (flag('--base') ?? 'https://api.bilimark.top').replace(/\/+$/, '');
const cmd = args[0] ?? 'help';
const rest = args.slice(1).filter((a, i) => !(args[i - 1] === '--key' || args[i - 1] === '--base') && a !== '--key' && a !== '--base');

const CAT_LABEL = { ai_low_effort: 'AI低创', clickbait: '标题党', misinformation: '造谣', stolen: '盗视频', engagement_bait: '黑流量' };
const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✗ HTTP ${res.status}: ${body.error ?? JSON.stringify(body)}`);
    if (res.status === 404 && path.startsWith('/api/admin')) {
      console.error('  （404 通常是密钥不对，或服务器未配置 ADMIN_KEY）');
    }
    process.exit(1);
  }
  return body;
}

const shortReason = (s, n = 30) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function main() {
  switch (cmd) {
  case 'setkey': {
    if (!rest[0]) {
      console.error('用法：node scripts/admin.mjs setkey <你的ADMIN_KEY>');
      process.exit(1);
    }
    writeFileSync(KEYFILE, `${rest[0].trim()}\n`);
    console.log(`✓ 密钥已保存到 ${KEYFILE}（该文件已加入 .gitignore，不会入库）`);
    break;
  }

  case 'health': {
    const h = await api('/api/health');
    console.log(`服务器 ${BASE}`);
    console.log(`状态正常 ✓  当前提交总量：${h.submissions}`);
    break;
  }

  case 'recent': {
    const limit = Number(rest[0] ?? 20);
    const { items } = await api(`/api/admin/recent-submissions?limit=${limit}`);
    if (items.length === 0) return console.log('（暂无提交）');
    console.log(`最近 ${items.length} 条提交（id | 时间 | 分类 | 理由 | Lv6声明 | public_id）：\n`);
    for (const it of items) {
      console.log(
        `#${it.id}  ${fmtTime(it.created_at)}  [${CAT_LABEL[it.category] ?? it.category}]  ${shortReason(it.reason)}` +
          `${it.claimed_lv6 ? '  (Lv6声明)' : ''}\n    public_id: ${it.public_id}  bvid: ${it.bvid}`,
      );
    }
    console.log('\n封禁：node scripts/admin.mjs ban <public_id> "备注"；撤销Lv6豁免：revoke <id>');
    break;
  }

  case 'claimed': {
    const { items } = await api('/api/admin/claimed-lv6');
    if (items.length === 0) return console.log('（暂无 Lv6 豁免声明）');
    console.log(`Lv6 豁免声明清单（${items.length} 条）——低频抽查：看理由/证据是否认真，敷衍且声明 Lv6 的可 revoke + 评估封禁：\n`);
    for (const it of items) {
      console.log(`#${it.id}  ${fmtTime(it.created_at)}  [${CAT_LABEL[it.category] ?? it.category}]  ${shortReason(it.reason, 40)}  ${it.bvid}\n    public_id: ${it.public_id}`);
    }
    console.log('\n撤销豁免：node scripts/admin.mjs revoke <id>');
    break;
  }

  case 'revoke': {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) return console.error('用法：node scripts/admin.mjs revoke <提交id>');
    const r = await api('/api/admin/revoke-lv6', { method: 'POST', body: JSON.stringify({ id }) });
    console.log(r.revoked ? `✓ 已撤销提交 #${id} 的 Lv6 豁免（该提交回到新手期阈值）` : `该提交 #${id} 本无豁免（无需撤销）`);
    break;
  }

  case 'ban': {
    const [publicId, note] = rest;
    if (!publicId || !/^[0-9a-f]{64}$/.test(publicId)) {
      return console.error('用法：node scripts/admin.mjs ban <public_id(64位hex)> [备注]\n（public_id 从 recent/claimed 清单复制）');
    }
    await api('/api/admin/shadowban', { method: 'POST', body: JSON.stringify({ publicId, note: note ?? '' }) });
    console.log(`✓ 已影子封禁 ${publicId.slice(0, 12)}…（其内容对全网隐藏、本人可见；备注：${note ?? '无'}）`);
    break;
  }

  case 'unban': {
    const [publicId] = rest;
    if (!publicId || !/^[0-9a-f]{64}$/.test(publicId)) return console.error('用法：node scripts/admin.mjs unban <public_id>');
    await api('/api/admin/unshadowban', { method: 'POST', body: JSON.stringify({ publicId }) });
    console.log(`✓ 已解除 ${publicId.slice(0, 12)}… 的影子封禁`);
    break;
  }

  case 'export': {
    const outfile = rest[0] ?? `bilimark-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const body = await api('/database.json');
    writeFileSync(outfile, JSON.stringify(body, null, 2));
    console.log(`✓ 全量数据已保存到 ${outfile}（${body.submissions.length} 条提交，${body.votes.length} 票）`);
    break;
  }

  case 'help':
  default:
    console.log(`BiliMark 管理工具  （服务器：${BASE}）

  node scripts/admin.mjs setkey <key>     保存密钥（一次即可）
  node scripts/admin.mjs health           健康与总量
  node scripts/admin.mjs recent [数量]     最近提交（含 public_id）
  node scripts/admin.mjs claimed          Lv6 声明抽查清单
  node scripts/admin.mjs revoke <id>      撤销某条 Lv6 豁免
  node scripts/admin.mjs ban <publicId> [备注]
  node scripts/admin.mjs unban <publicId>
  node scripts/admin.mjs export [文件]     全量备份（database.json）
  可选：--base http://127.0.0.1:8787（本地调试） --key <key>（临时密钥）`);
  }
}

await main();
