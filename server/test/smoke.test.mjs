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
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY, BILIMARK_DATA_DIR: dataDir, RATE_LIMIT_MAX: '100000' },
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

test('撤回：DELETE 删除提交后可重新提交（不再 409）', async () => {
  const bvid = newBvid();
  const pid = newId();
  assert.equal((await submitSimple(bvid, pid)).status, 200);
  const del = await fetch(BASE + '/api/markings', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bvid, category: CAT, privateId: pid }),
  });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true, deleted: 1 });

  // 无记录时重复 DELETE：deleted=0 仍 200（幂等，客户端视为撤回完成）
  const del2 = await fetch(BASE + '/api/markings', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bvid, category: CAT, privateId: pid }),
  });
  assert.equal(del2.status, 200);
  assert.equal((await del2.json()).deleted, 0);

  assert.equal((await submitSimple(bvid, pid)).status, 200, '撤回后重新提交应成功');
});

test('UP主警示派生：门槛边界/分类隔离/撤回消失/影子封禁不计入', async () => {
  const upMid = 777001;
  const seeder = newId();
  for (let i = 0; i < 3; i++) {
    assert.equal((await submitSimple(newBvid(), seeder, { upMid })).status, 200); // 毕业
  }

  // 2 个视频 confirmed（各 2 票 + 提交者 = 3）→ 低于门槛 3 不警示
  const targets = [];
  for (let i = 0; i < 2; i++) {
    const bvid = newBvid();
    assert.equal((await submitSimple(bvid, seeder, { upMid, upName: '测试UP' })).status, 200);
    await vote(bvid, CAT, 1, newId());
    await vote(bvid, CAT, 1, newId());
    targets.push(bvid);
  }
  let body = (await get(`/api/markings?bvids=${targets.join(',')}`)).body;
  assert.equal(body.upWarnings['777001']?.categories?.[CAT] ?? 0, 0, '2 个视频 < 门槛不警示');
  assert.equal(body.markings[targets[0]][0].upMid, 777001, '条目带 upMid');
  assert.equal(body.markings[targets[0]][0].upName, '测试UP');

  // 第 3 个视频 confirmed → 达门槛
  const third = newBvid();
  assert.equal((await submitSimple(third, seeder, { upMid, upName: '测试UP' })).status, 200);
  await vote(third, CAT, 1, newId());
  await vote(third, CAT, 1, newId());
  targets.push(third);

  body = (await get(`/api/markings?bvids=${targets.join(',')}`)).body;
  assert.equal(body.upWarnings['777001'].categories[CAT], 3);
  assert.equal(body.upWarnings['777001'].name, '测试UP');

  // 分类隔离：另一分类 1 个视频 confirmed，不与 CAT 合并、自身低于门槛不输出
  const other = newBvid();
  await post('/api/markings', { bvid: other, category: 'clickbait', reason: '测试理由：标题党分类隔离用', evidence: [], privateId: seeder, upMid });
  await vote(other, 'clickbait', 1, newId());
  await vote(other, 'clickbait', 1, newId());
  body = (await get(`/api/markings?bvids=${[...targets, other].join(',')}`)).body;
  assert.equal(body.upWarnings['777001'].categories[CAT], 3, '不同分类不合并');
  assert.equal(body.upWarnings['777001'].categories.clickbait, undefined, '低于门槛的分类不输出');

  // 撤回一条 → 降到门槛下 → 警示消失
  const del = await fetch(BASE + '/api/markings', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bvid: third, category: CAT, privateId: seeder }),
  });
  assert.equal(del.status, 200);
  body = (await get(`/api/markings?bvids=${targets.join(',')}`)).body;
  assert.equal(body.upWarnings['777001']?.categories?.[CAT] ?? 0, 0, '撤回后 2 个 < 门槛 → 不输出警示');

  // 影子封禁该 UP 的提交者 → 内容全网隐藏，警示不计数
  await post('/api/admin/shadowban', { publicId: sha256(seeder), note: 'upwarning test' }, { 'X-Admin-Key': ADMIN_KEY });
  body = (await get(`/api/markings?bvids=${targets.join(',')}`)).body;
  assert.equal(body.upWarnings['777001'] ?? undefined, undefined, '影子封禁后不计入');
  await post('/api/admin/unshadowban', { publicId: sha256(seeder) }, { 'X-Admin-Key': ADMIN_KEY });
});

test('隐私查询：hashes= 前缀命中 bvids= 同款数据；duration 入库', async () => {
  const bvid = newBvid();
  const pid = newId();
  const { createHash: ch } = await import('node:crypto');
  const prefix = ch('sha256').update(bvid).digest('hex').slice(0, 8);
  // 带 duration 提交
  const s = await post('/api/markings', {
    bvid,
    category: CAT,
    reason: '测试理由：哈希前缀查询与时长入库',
    evidence: [],
    privateId: pid,
    duration: 213,
  });
  assert.equal(s.status, 200);

  // hashes= 前缀查询（明文 bvid 不出现在请求里）
  const byHash = await get(`/api/markings?hashes=${prefix}`);
  assert.equal(byHash.status, 200);
  assert.ok(byHash.body.markings[bvid], 'hash 前缀命中');
  assert.equal(byHash.body.markings[bvid][0].confirmCount, 1);

  // 8 位之外的 hash 不命中；无效格式被拒之门外（空结果）
  const miss = await get(`/api/markings?hashes=${prefix.slice(0, 4)}`);
  assert.deepEqual(miss.body.markings, {}, '前缀不足 8 位不匹配');

  // 无效 hash 格式 → 空结果
  const bad = await get('/api/markings?hashes=ZZZZ');
  assert.deepEqual(bad.body.markings, {});

  // 缓存头：无 as 公共查询可边缘缓存；带 as 私有不缓存
  const pub = await fetch(`${BASE}/api/markings?bvids=${bvid}`);
  assert.match(pub.headers.get('cache-control') ?? '', /s-maxage=60/);
  const priv = await fetch(`${BASE}/api/markings?bvids=${bvid}&as=${sha256(pid)}`);
  assert.match(priv.headers.get('cache-control') ?? '', /private/);
});

test('v0.4 分类扩展：盗视频必填原链接/3票确认；黑流量观点类5票；新手期叠加', async () => {
  const { createHash: ch2 } = await import('node:crypto');
  // 1) stolen 无原链接 → 400；有 → 3 票确认（事实类标准阈值；提交者先毕业 3 条避开新手期）
  const graduate = async (pid) => {
    for (let i = 0; i < 3; i++) {
      await post('/api/markings', { bvid: newBvid(), category: CAT, reason: '毕业用提交', evidence: [], privateId: pid });
    }
  };
  const sv = newBvid();
  const noLink = await post('/api/markings', { bvid: sv, category: 'stolen', reason: '测试理由：搬运未注明出处', evidence: [], privateId: newId() });
  assert.equal(noLink.status, 400, '盗视频缺原视频链接应 400');
  const pidS = newId();
  await graduate(pidS);
  assert.equal((await post('/api/markings', { bvid: sv, category: 'stolen', reason: '测试理由：搬运未注明出处', evidence: ['https://www.youtube.com/watch?v=test'], privateId: pidS })).status, 200);
  assert.equal((await vote(sv, 'stolen', 1, newId())).status, 200);
  await vote(sv, 'stolen', 1, newId());
  const svEntry = (await get(`/api/markings?bvids=${sv}`)).body.markings[sv].find((e) => e.category === 'stolen');
  assert.equal(svEntry.status, 'confirmed', '盗视频 3 票应确认（事实类）');

  // 2) engagement_bait：4 票 pending，第 5 票 confirmed（观点类更高门槛；提交者先毕业）
  const eb = newBvid();
  const pidE = newId();
  await graduate(pidE);
  assert.equal((await post('/api/markings', { bvid: eb, category: 'engagement_bait', reason: '测试理由：刻意引战骗互动', evidence: [], privateId: pidE })).status, 200);
  for (let i = 0; i < 3; i++) await vote(eb, 'engagement_bait', 1, newId());
  let ebEntry = (await get(`/api/markings?bvids=${eb}`)).body.markings[eb].find((e) => e.category === 'engagement_bait');
  assert.equal(ebEntry.status, 'pending', '黑流量 net=4 < 5 应待确认');
  await vote(eb, 'engagement_bait', 1, newId());
  ebEntry = (await get(`/api/markings?bvids=${eb}`)).body.markings[eb].find((e) => e.category === 'engagement_bait');
  assert.equal(ebEntry.status, 'confirmed', '黑流量 net=5 应确认（观点类门槛）');

  // 3) 观点类新手期叠加：黑流量新手标记需 10 票（5×2）
  const ebNovice = newBvid();
  const pidN = newId();
  await post('/api/markings', { bvid: ebNovice, category: 'engagement_bait', reason: '测试理由：黑流量新手期验证', evidence: [], privateId: pidN });
  for (let i = 0; i < 8; i++) await vote(ebNovice, 'engagement_bait', 1, newId());
  ebEntry = (await get(`/api/markings?bvids=${ebNovice}`)).body.markings[ebNovice].find((e) => e.category === 'engagement_bait');
  assert.equal(ebEntry.status, 'pending', '黑流量新手 net=9 < 10 应待确认');
  await vote(ebNovice, 'engagement_bait', 1, newId());
  ebEntry = (await get(`/api/markings?bvids=${ebNovice}`)).body.markings[ebNovice].find((e) => e.category === 'engagement_bait');
  assert.equal(ebEntry.status, 'confirmed', '黑流量新手 net=10 应确认');

  // 4) aiDeclared 元数据：任一提交者带声明即真
  const av = newBvid();
  await post('/api/markings', { bvid: av, category: CAT, reason: '测试理由：AI声明元数据验证', evidence: [], privateId: newId(), aiDeclared: false });
  await post('/api/markings', { bvid: av, category: 'clickbait', reason: '测试理由：AI声明元数据验证二', evidence: [], privateId: newId(), aiDeclared: true });
  const avMark = (await get(`/api/markings?bvids=${av}`)).body.markings[av];
  assert.equal(avMark.find((e) => e.category === CAT).aiDeclared, false, '未声明条目为 false');
  assert.equal(avMark.find((e) => e.category === 'clickbait').aiDeclared, true, '声明条目为 true');
});

test('GET /api/markings：bvid 校验与批量上限不 500', async () => {
  assert.deepEqual((await get('/api/markings?bvids=BAD')).body.markings, {});
  const fifty = Array.from({ length: 60 }, () => newBvid()).join(',');
  const { status, body } = await get(`/api/markings?bvids=${fifty}`);
  assert.equal(status, 200);
  assert.deepEqual(body.markings, {});
});
