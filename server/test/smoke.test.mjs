/**
 * 服务器端到端冒烟测试（零依赖：node:test 内置测试器，ADR-0006 同款约束）。
 * 自起服务器子进程（独立端口 + 独立数据目录 + 测试 ADMIN_KEY），全部打真实 HTTP。
 * 运行：cd server && npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = 'test-admin-key';
const CAT = 'ai_low_effort';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newId = () => randomBytes(32).toString('hex');
const newBvid = () => 'BV' + randomBytes(5).toString('hex'); // BV + 10 hex，满足 BVID_RE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
let dataDir;

async function get(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path, payload, headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const submit = (payload) => post('/api/markings', payload);
const vote = (bvid, category, v, privateId) =>
  post('/api/vote', { bvid, category, vote: v, privateId });

/** 读取某 bvid 指定分类的聚合条目（as=本人哈希可选），无则返回 null */
async function entryOf(bvid, category = CAT, as = '') {
  const { body } = await get(`/api/markings?bvids=${bvid}${as ? `&as=${as}` : ''}`);
  return body?.markings?.[bvid]?.find((e) => e.category === category) ?? null;
}

const submitSimple = (bvid, privateId, extra = {}) =>
  submit({
    bvid,
    category: CAT,
    reason: '测试理由：信息量极低（冒烟测试自动生成）',
    evidence: [],
    privateId,
    ...extra,
  });

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'bilimark-test-'));
  child = spawn(process.execPath, [join(here, '..', 'dist', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY, BILIMARK_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      // 尚未就绪
    }
    await sleep(100);
  }
  throw new Error('服务器未在 6s 内就绪');
});

after(() => {
  child?.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows 句柄延迟释放时忽略
  }
});

test('health 就绪且初始为空库', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.submissions, 0);
});

test('提交校验：无效分类/无效bvid/短理由/造谣无证据 → 400', async () => {
  const pid = newId();
  assert.equal((await submit({ bvid: newBvid(), category: 'nope', reason: '理由足够长了', evidence: [], privateId: pid })).status, 400);
  assert.equal((await submit({ bvid: 'BVSHORT', category: CAT, reason: '理由足够长了', evidence: [], privateId: pid })).status, 400);
  assert.equal((await submit({ bvid: newBvid(), category: CAT, reason: '短', evidence: [], privateId: pid })).status, 400);
  assert.equal(
    (await submit({ bvid: newBvid(), category: 'misinformation', reason: '造谣必须有证据链接', evidence: [], privateId: pid })).status,
    400,
  );
});

test('分区隔离墙（ADR-0004）：v1 资讯区 203 与 v2 时政解读 2089 → 403', async () => {
  const pid = newId();
  assert.equal((await submitSimple(newBvid(), pid, { region: 203 })).status, 403);
  assert.equal((await submitSimple(newBvid(), pid, { regionV2: 2089 })).status, 403);
  assert.equal((await submitSimple(newBvid(), pid, { region: 203, regionV2: null })).status, 403);
  // 非高敏分区照常接受（知识区 36）
  assert.equal((await submitSimple(newBvid(), pid, { region: 36, regionV2: 1010 })).status, 200);
});

test('新手期状态机：全新身份标记需 6 票（标准 3 × 新手倍率 2）', async () => {
  const bvid = newBvid();
  const pidA = newId();
  assert.equal((await submitSimple(bvid, pidA)).status, 200);

  let e = await entryOf(bvid);
  assert.equal(e.status, 'pending');
  assert.equal(e.confirmCount, 1); // 提交者默认一票赞成

  for (let i = 0; i < 4; i++) {
    assert.equal((await vote(bvid, CAT, 1, newId())).status, 200);
  }
  e = await entryOf(bvid);
  assert.equal(e.status, 'pending', 'net=5 < 6 应仍为待确认');
  assert.equal(e.confirmCount, 5);

  assert.equal((await vote(bvid, CAT, 1, newId())).status, 200);
  e = await entryOf(bvid);
  assert.equal(e.status, 'confirmed', 'net=6 ≥ 6 应升为已确认');
  assert.equal(e.againstCount, 0);
});

test('重复提交：同一贡献者同一(视频,分类) → 409', async () => {
  const bvid = newBvid();
  const pid = newId();
  assert.equal((await submitSimple(bvid, pid)).status, 200);
  const dup = await submitSimple(bvid, pid);
  assert.equal(dup.status, 409);
});

test('Lv6 豁免：claimed_lv6 标记阈值保持标准 3 票', async () => {
  const bvid = newBvid();
  const pidD = newId();
  assert.equal((await submitSimple(bvid, pidD, { claimedLv6: true })).status, 200);
  assert.equal((await entryOf(bvid)).status, 'pending');

  assert.equal((await vote(bvid, CAT, 1, newId())).status, 200);
  assert.equal((await entryOf(bvid)).status, 'pending', 'net=2 < 3 仍待确认');

  assert.equal((await vote(bvid, CAT, 1, newId())).status, 200);
  const e = await entryOf(bvid);
  assert.equal(e.status, 'confirmed', 'net=3 ≥ 3 已确认（未翻倍，豁免生效）');
});

test('新手毕业：非新手贡献者（第 4 条起）恢复标准 3 票', async () => {
  const pidB = newId();
  // 前 3 条（各占一个视频）完成新手期，留在 pending 态即可
  for (let i = 0; i < 3; i++) {
    assert.equal((await submitSimple(newBvid(), pidB)).status, 200);
  }
  const bvid4 = newBvid();
  assert.equal((await submitSimple(bvid4, pidB)).status, 200);
  assert.equal((await entryOf(bvid4)).status, 'pending', 'net=1');

  assert.equal((await vote(bvid4, CAT, 1, newId())).status, 200);
  assert.equal((await entryOf(bvid4)).status, 'pending', 'net=2 < 3');

  assert.equal((await vote(bvid4, CAT, 1, newId())).status, 200);
  assert.equal((await entryOf(bvid4)).status, 'confirmed', 'net=3 ≥ 3（标准阈值）');
});

test('驳回：净反对 ≤ -2 后条目对全网隐藏', async () => {
  const bvid = newBvid();
  assert.equal((await submitSimple(bvid, newId())).status, 200); // net=1
  for (let i = 0; i < 3; i++) {
    assert.equal((await vote(bvid, CAT, -1, newId())).status, 200);
  }
  const e = await entryOf(bvid);
  assert.equal(e, null, 'net=-2 应被驳回隐藏');
});

test('投票改票：一人一票可改票，改后按最新值计', async () => {
  const bvid = newBvid();
  assert.equal((await submitSimple(bvid, newId())).status, 200); // net=1
  const voter = newId();
  assert.equal((await vote(bvid, CAT, 1, voter)).status, 200);
  assert.equal((await entryOf(bvid)).confirmCount, 2);
  assert.equal((await vote(bvid, CAT, -1, voter)).status, 200); // 改票
  const e = await entryOf(bvid);
  assert.equal(e.confirmCount, 0); // net = 提交者1 + 改后票(-1)
  assert.equal(e.againstCount, 1);
});

test('影子封禁：被封者内容全网隐藏，as=本人哈希仍可见；unshadowban 恢复', async () => {
  const bvid = newBvid();
  const pidC = newId();
  assert.equal((await submitSimple(bvid, pidC)).status, 200);
  assert.notEqual(await entryOf(bvid), null, '封禁前可见');

  const pub = sha256(pidC);
  assert.equal((await post('/api/admin/shadowban', { publicId: pub, note: '冒烟测试' }, { 'X-Admin-Key': ADMIN_KEY })).status, 200);
  assert.equal(await entryOf(bvid), null, '封禁后全网不可见');
  assert.notEqual(await entryOf(bvid, CAT, pub), null, 'as=本人哈希时仍可见');

  assert.equal((await post('/api/admin/unshadowban', { publicId: pub }, { 'X-Admin-Key': ADMIN_KEY })).status, 200);
  assert.notEqual(await entryOf(bvid), null, '解封后恢复可见');
});

test('管理端点鉴权：无 key / 错误 key → 404 不暴露存在', async () => {
  assert.equal((await get('/api/admin/claimed-lv6')).status, 404);
  assert.equal((await post('/api/admin/shadowban', { publicId: sha256(newId()) }, { 'X-Admin-Key': 'wrong' })).status, 404);
});

test('claimed-Lv6 抽样清单：包含豁免提交且字段齐全', async () => {
  const res = await fetch(BASE + '/api/admin/claimed-lv6', { headers: { 'X-Admin-Key': ADMIN_KEY } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.items) && body.items.length >= 1);
  const item = body.items.find((i) => i.category === CAT);
  assert.ok(item, '应有 claimed_lv6=1 的测试提交');
  assert.ok(item.id && item.bvid && item.public_id);
});

test('全量发布 database.json：格式、列齐全、不含明文身份', async () => {
  const { status, body } = await get('/database.json');
  assert.equal(status, 200);
  assert.equal(body.format, 'bilimark-database/v0');
  assert.ok(body.submissions.length >= 5);
  const s = body.submissions[0];
  for (const key of ['bvid', 'category', 'reason', 'evidence', 'claimed_lv6', 'region', 'region_v2', 'up_mid', 'up_name', 'created_at']) {
    assert.ok(key in s, `应包含 ${key} 列`);
  }
  assert.ok(!('public_id' in s), '全量发布不导出 public_id（单向哈希也不导出）');
});

test('GET /api/markings：bvid 校验与批量上限不 500', async () => {
  assert.deepEqual((await get('/api/markings?bvids=BAD')).body.markings, {});
  const fifty = Array.from({ length: 60 }, () => newBvid()).join(',');
  const { status, body } = await get(`/api/markings?bvids=${fifty}`);
  assert.equal(status, 200);
  assert.deepEqual(body.markings, {});
});
