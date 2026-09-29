import ADMIN_HTML from './admin.html';

/**
 * BiliMark Cloudflare Workers + D1 版（server/worker/，wrangler 自带转译，不进 tsc）。
 * 与 src/index.ts（node:sqlite 版）功能对齐、双份维护：改协议/治理逻辑时两边同步改。
 *
 * 与 node 版的差异：
 * - D1 异步 API（prepare/bind/all/run 全 Promise），aggregate 为 async
 * - GET /api/markings 无 as= 的公共查询用 Cache API 边缘缓存 60s（no-store 请求跳过，
 *   播放页 fresh 刷新即时生效）；带 as= 的是本人个性化视图，绝不缓存
 * - 内存限流在 Workers 是 isolate 局部的 best-effort（多实例各自计数），聊胜于无；
 *   需要精确限流时换 Rate Limiting binding 或 D1 计数表
 * - ADMIN_KEY 走 `wrangler secret put ADMIN_KEY`（未设置则管理端点 404 不暴露）
 */
type UnknownRow = Record<string, unknown>;

interface D1Stmt {
  bind(...args: unknown[]): D1Stmt;
  all<T = UnknownRow>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
interface D1Like {
  prepare(sql: string): D1Stmt;
}
interface Env {
  DB: D1Like;
  ADMIN_KEY?: string;
  RATE_LIMIT_MAX?: string;
}

// ---------- 管理鉴权分层（与 src/index.ts 同步）：ADMIN_KEY=owner；mod_keys 命中=moderator ----------
async function adminAuth(req: Request, env: Env): Promise<{ role: 'owner' | 'mod'; name: string } | null> {
  const key = req.headers.get('x-admin-key');
  if (!key) return null;
  if (env.ADMIN_KEY && key === env.ADMIN_KEY) return { role: 'owner', name: 'owner' };
  if (!env.ADMIN_KEY) return null;
  const row = await env.DB.prepare(`SELECT name FROM mod_keys WHERE key_hash = ? AND revoked = 0`)
    .bind(await sha256(key))
    .first<{ name: string }>();
  return row ? { role: 'mod', name: row.name } : null;
}

async function adminLog(db: D1Like, action: string, target: string, operator: string): Promise<void> {
  await db
    .prepare(`INSERT INTO admin_log (action, target, operator, created_at) VALUES (?, ?, ?, ?)`)
    .bind(action, target, operator, Date.now())
    .run();
}

const CONFIRM_THRESHOLD = 3;
const HIDE_THRESHOLD = -2;
const NOVICE_SUBMISSIONS = 3;
const NOVICE_MULTIPLIER = 2;
const UP_WARNING_THRESHOLD = 3;
const OPINION_CONFIRM_THRESHOLD = 5; // 观点类分类（黑流量）确认门槛，与 src/index.ts 同步
const SERVER_VERSION = '0.5.0'; // 与 src/manifest.json / src/index.ts 保持同步（扩展更新检查用）
const CATEGORIES = new Set([
  'low_effort', // 低创（v0.5 由 AI低创 改名扩义）
  'clickbait',
  'misinformation',
  'stolen',
  'staged', // 摆拍（v0.5 新增）：证据选填
  'engagement_bait',
  'comment_toxicity', // 评论区慎入（v0.5 新增）：观点类；UP警示排除
]);
/** 观点类分类确认阈值 5 票，事实类 3 票（v0.4/v0.5 分类扩展；盗视频无证据按观点类门槛，与 src/index.ts 同步） */
const OPINION_CATEGORIES = new Set(['engagement_bait', 'comment_toxicity']);
function thresholdFor(category: string, hasEvidence: boolean): number {
  if (OPINION_CATEGORIES.has(category)) return OPINION_CONFIRM_THRESHOLD;
  if (category === 'stolen' && !hasEvidence) return OPINION_CONFIRM_THRESHOLD;
  return CONFIRM_THRESHOLD;
}
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- best-effort 限流：每 IP 每分钟 120 次（isolate 局部；RATE_LIMIT_MAX 可调） ----------
const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string, max: number): boolean {
  const now = Date.now();
  const rec = hits.get(ip) ?? { n: 0, t: now };
  if (now - rec.t > 60_000) {
    rec.n = 0;
    rec.t = now;
  }
  rec.n += 1;
  hits.set(ip, rec);
  if (hits.size > 10_000) hits.clear();
  return rec.n > max;
}

// ---------- 聚合：标记状态机 + UP主警示（与 src/index.ts aggregate 对齐） ----------
async function aggregate(
  db: D1Like,
  bvids: string[],
  asHash: string | null,
  upExpanded = false,
): Promise<{
  markings: Record<string, unknown[]>;
  upWarnings: Record<string, { name: string; categories: Record<string, number> }>;
}> {
  const placeholders = bvids.map(() => '?').join(',');
  const subs = (
    await db
      .prepare(
        `SELECT id, bvid, category, reason, evidence, public_id, claimed_lv6, up_mid, up_name, ai_declared, created_at
         FROM submissions WHERE bvid IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .bind(...bvids)
      .all<UnknownRow>()
  ).results as unknown as Array<{
    id: number;
    bvid: string;
    category: string;
    reason: string;
    evidence: string;
    public_id: string;
    claimed_lv6: number;
    up_mid: number | null;
    up_name: string | null;
    ai_declared: number;
    created_at: number;
  }>;
  const votes = (
    await db
      .prepare(`SELECT bvid, category, public_id, vote FROM votes WHERE bvid IN (${placeholders})`)
      .bind(...bvids)
      .all<UnknownRow>()
  ).results as unknown as Array<{ bvid: string; category: string; public_id: string; vote: number }>;

  const shadowRows = (await db.prepare(`SELECT public_id FROM shadowbans`).all<UnknownRow>())
    .results as unknown as Array<{ public_id: string }>;
  const shadowSet = new Set(shadowRows.map((r) => r.public_id));
  const visible = (pid: string): boolean => !shadowSet.has(pid) || pid === asHash;

  // 管理员直接确认（不虚增票数）：命中的 (视频,分类) 强制 confirmed，且优先于社区驳回
  const adminConfirmedRows = (
    await db
      .prepare(`SELECT bvid, category FROM admin_confirmations WHERE bvid IN (${placeholders})`)
      .bind(...bvids)
      .all<{ bvid: string; category: string }>()
  ).results;
  const adminConfirmed = new Set(adminConfirmedRows.map((r) => `${r.bvid}|${r.category}`));

  const visSubs = subs.filter((s) => visible(s.public_id));
  const visVotes = votes.filter((v) => visible(v.public_id));

  // 新手期：按贡献者全部提交的 id 序取前 N 条；claimed_lv6 豁免
  const contributors = [...new Set(visSubs.map((s) => s.public_id))];
  const noviceSet = new Set<number>();
  if (contributors.length > 0) {
    const ph = contributors.map(() => '?').join(',');
    const allOf = (
      await db
        .prepare(
          `SELECT id, public_id, claimed_lv6 FROM submissions WHERE public_id IN (${ph}) ORDER BY public_id, id ASC`,
        )
        .bind(...contributors)
        .all<UnknownRow>()
    ).results as unknown as Array<{ id: number; public_id: string; claimed_lv6: number }>;
    const counts = new Map<string, number>();
    for (const r of allOf) {
      const c = counts.get(r.public_id) ?? 0;
      if (c < NOVICE_SUBMISSIONS && !r.claimed_lv6) noviceSet.add(r.id);
      counts.set(r.public_id, c + 1);
    }
  }

  const byKey = new Map<string, { net: number; against: number; reasons: Array<{ reason: string; at: number }>; evidence: Set<string>; allNovice: boolean; aiDeclared: boolean }>();
  for (const s of visSubs) {
    const key = `${s.bvid}|${s.category}`;
    const agg = byKey.get(key) ?? { net: 0, against: 0, reasons: [], evidence: new Set<string>(), allNovice: true, aiDeclared: false };
    agg.net += 1;
    if (!noviceSet.has(s.id)) agg.allNovice = false;
    if (s.ai_declared === 1) agg.aiDeclared = true;
    agg.reasons.push({ reason: s.reason, at: s.created_at });
    try {
      for (const e of JSON.parse(s.evidence) as string[]) agg.evidence.add(e);
    } catch {
      // 损坏的历史数据不阻断聚合
    }
    byKey.set(key, agg);
  }
  for (const v of visVotes) {
    const agg = byKey.get(`${v.bvid}|${v.category}`);
    if (!agg) continue;
    agg.net += v.vote;
    if (v.vote < 0) agg.against += 1;
  }

  const out: Record<string, unknown[]> = {};
  const upOf = new Map<string, { upMid: number; upName: string }>();
  for (const s of visSubs) {
    if (s.up_mid === null || s.up_mid === undefined) continue;
    const key = `${s.bvid}|${s.category}`;
    if (!upOf.has(key)) upOf.set(key, { upMid: s.up_mid, upName: s.up_name ?? '' });
  }
  const upCounts = new Map<number, { name: string; categories: Map<string, number> }>();
  for (const [key, agg] of byKey) {
    const isAdminConfirmed = adminConfirmed.has(key);
    if (agg.net <= HIDE_THRESHOLD && !isAdminConfirmed) continue;
    const [bvid, category] = key.split('|');
    const threshold = thresholdFor(category, agg.evidence.size > 0) * (agg.allNovice ? NOVICE_MULTIPLIER : 1);
    const confirmed = isAdminConfirmed || agg.net >= threshold;
    const up = upOf.get(key);
    // 评论区慎入不进 UP主警示（与 src/index.ts 同步，2026-09-30 grill）
    if (confirmed && up && category !== 'comment_toxicity') {
      const rec = upCounts.get(up.upMid) ?? { name: up.upName, categories: new Map<string, number>() };
      rec.categories.set(category, (rec.categories.get(category) ?? 0) + 1);
      upCounts.set(up.upMid, rec);
    }
    (out[bvid] ??= []).push({
      category,
      status: confirmed ? 'confirmed' : 'pending',
      confirmCount: agg.net,
      againstCount: agg.against,
      reason: agg.reasons.sort((a, b) => b.at - a.at)[0]?.reason ?? '',
      evidence: [...agg.evidence].slice(0, 3),
      upMid: up?.upMid,
      upName: up?.upName,
      aiDeclared: agg.aiDeclared,
    });
  }

  // UP警示按 up_mid 全库聚合（递归一轮扩展），非本次查询窗口
  const buildUpWarnings = (): Record<string, { name: string; categories: Record<string, number> }> => {
    const upWarnings: Record<string, { name: string; categories: Record<string, number> }> = {};
    for (const [mid, rec] of upCounts) {
      const cats: Record<string, number> = {};
      for (const [c, n] of rec.categories) {
        if (n >= UP_WARNING_THRESHOLD) cats[c] = n;
      }
      if (Object.keys(cats).length > 0) upWarnings[String(mid)] = { name: rec.name, categories: cats };
    }
    return upWarnings;
  };

  let upWarnings: Record<string, { name: string; categories: Record<string, number> }> = {};
  if (!upExpanded) {
    const upMids = [
      ...new Set(visSubs.map((s) => s.up_mid).filter((m): m is number => m !== null && m !== undefined)),
    ];
    if (upMids.length > 0) {
      const ph = upMids.map(() => '?').join(',');
      const rows = (
        await db
          .prepare(`SELECT DISTINCT bvid FROM submissions WHERE up_mid IN (${ph}) LIMIT 500`)
          .bind(...upMids)
          .all<{ bvid: string }>()
      ).results;
      const allBvids = rows.map((r) => r.bvid);
      upWarnings = allBvids.some((b) => !bvids.includes(b))
        ? (await aggregate(db, allBvids, asHash, true)).upWarnings
        : buildUpWarnings();
    }
  } else {
    upWarnings = buildUpWarnings();
  }
  return { markings: out, upWarnings };
}

// ---------- CORS / 响应 ----------
function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return cors(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
    }),
  );
}

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    try {
      const url = new URL(req.url);
      const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        } });
      }
      if (rateLimited(ip, Number(env.RATE_LIMIT_MAX ?? 120))) return json({ error: 'rate limited' }, 429);

      // 管理面板（静态单页；密钥由使用者输入，仅存本机浏览器）
      if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
        return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // GET /api/health
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first<{ n: number }>();
        return json({ ok: true, submissions: row?.n ?? 0, version: SERVER_VERSION });
      }

      // GET /api/markings?hashes=<前8位,…> 或 ?bvids=BV…[&as=<本人哈希>]
      if (req.method === 'GET' && url.pathname === '/api/markings') {
        const asRaw = url.searchParams.get('as') ?? '';
        const as = /^[0-9a-f]{64}$/.test(asRaw) ? asRaw : null;
        const fresh = (req.headers.get('cache-control') ?? '').includes('no-store');

        const cacheKeyUrl = new URL(url.toString());
        cacheKeyUrl.searchParams.delete('as'); // 个性化视图绝不共享缓存
        let cached: Response | undefined;
        if (!as && !fresh) {
          cached = await caches.default.match(cacheKeyUrl.toString());
          if (cached) return cached;
        }

        let queried: string[] = [];
        const hashes = (url.searchParams.get('hashes') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^[0-9a-f]{8}$/.test(s))
          .slice(0, 50);
        if (hashes.length > 0) {
          const like = hashes.map(() => 'bvid_hash LIKE ?').join(' OR ');
          const rows = (
            await env.DB.prepare(`SELECT DISTINCT bvid FROM submissions WHERE ${like} LIMIT 500`)
              .bind(...hashes.map((h) => `${h}%`))
              .all<{ bvid: string }>()
          ).results;
          queried = rows.map((r) => r.bvid);
        } else {
          queried = (url.searchParams.get('bvids') ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => BVID_RE.test(s))
            .slice(0, 50);
        }

        const result = queried.length === 0 ? { markings: {}, upWarnings: {} } : await aggregate(env.DB, queried, as);
        const res = json(result, 200, { 'Cache-Control': as ? 'private, no-store' : 'public, max-age=60' });
        if (!as && !fresh) ctx.waitUntil(caches.default.put(cacheKeyUrl.toString(), res.clone()));
        return res;
      }

      // POST /api/markings
      if (req.method === 'POST' && url.pathname === '/api/markings') {
        try {
          const body = (await req.json()) as {
            bvid?: string;
            category?: string;
            reason?: string;
            evidence?: string[];
            privateId?: string;
            claimedLv6?: boolean;
            region?: number | null;
            regionV2?: number | null;
            upMid?: number | null;
            upName?: string;
            duration?: number | null;
            aiDeclared?: boolean;
          };
          const bvid = body.bvid ?? '';
          const category = body.category ?? '';
          const reason = (body.reason ?? '').trim();
          const evidence = Array.isArray(body.evidence)
            ? body.evidence.filter((u) => /^https?:\/\//i.test(u)).slice(0, 5)
            : [];
          const privateId = body.privateId ?? '';
          const region = Number.isInteger(body.region) ? (body.region as number) : null;
          const regionV2 = Number.isInteger(body.regionV2) ? (body.regionV2 as number) : null;
          const upMid = Number.isInteger(body.upMid) ? (body.upMid as number) : null;
          const upName = typeof body.upName === 'string' ? body.upName.trim().slice(0, 64) : '';
          const duration =
            Number.isInteger(body.duration) && (body.duration as number) >= 0 && (body.duration as number) <= 100000
              ? (body.duration as number)
              : null;

          if (!BVID_RE.test(bvid) || !CATEGORIES.has(category)) return json({ error: 'invalid bvid or category' }, 400);
          if (region !== null && (region < 0 || region > 10000)) return json({ error: 'invalid region' }, 400);
          if ((region !== null && SENSITIVE_TIDS.has(region)) || (regionV2 !== null && SENSITIVE_TIDS.has(regionV2))) {
            return json({ error: 'sensitive zone not allowed' }, 403);
          }
          if (reason.length < 5 || reason.length > 500) return json({ error: 'reason must be 5-500 chars' }, 400);
          if (category === 'misinformation' && evidence.length === 0) return json({ error: 'misinformation requires evidence' }, 400);
          // 盗视频：源视频链接选填（v0.5 两档门槛，与 src/index.ts 同步）
          if (privateId.length < 32) return json({ error: 'invalid privateId' }, 400);

          try {
            await env.DB.prepare(
              `INSERT INTO submissions (bvid, category, reason, evidence, public_id, claimed_lv6, region, region_v2, up_mid, up_name, bvid_hash, duration, ai_declared, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
              .bind(
                bvid,
                category,
                reason,
                JSON.stringify(evidence),
                await sha256(privateId),
                body.claimedLv6 === true ? 1 : 0,
                region,
                regionV2,
                upMid,
                upName || null,
                await sha256(bvid),
                duration,
                body.aiDeclared === true ? 1 : 0,
                Date.now(),
              )
              .run();
          } catch {
            return json({ error: 'already submitted' }, 409);
          }
          return json({ ok: true });
        } catch {
          return json({ error: 'bad request' }, 400);
        }
      }

      // DELETE /api/markings —— 撤回
      if (req.method === 'DELETE' && url.pathname === '/api/markings') {
        try {
          const body = (await req.json()) as { bvid?: string; category?: string; privateId?: string };
          const bvid = body.bvid ?? '';
          const category = body.category ?? '';
          const privateId = body.privateId ?? '';
          if (!BVID_RE.test(bvid) || !CATEGORIES.has(category) || privateId.length < 32) {
            return json({ error: 'invalid payload' }, 400);
          }
          const info = await env.DB.prepare(`DELETE FROM submissions WHERE bvid = ? AND category = ? AND public_id = ?`)
            .bind(bvid, category, await sha256(privateId))
            .run();
          return json({ ok: true, deleted: info.meta.changes ?? 0 });
        } catch {
          return json({ error: 'bad request' }, 400);
        }
      }

      // POST /api/vote
      if (req.method === 'POST' && url.pathname === '/api/vote') {
        try {
          const body = (await req.json()) as { bvid?: string; category?: string; vote?: number; privateId?: string };
          const bvid = body.bvid ?? '';
          const category = body.category ?? '';
          const vote = body.vote ?? 0;
          const privateId = body.privateId ?? '';
          if (!BVID_RE.test(bvid) || !CATEGORIES.has(category) || (vote !== 1 && vote !== -1)) {
            return json({ error: 'invalid vote payload' }, 400);
          }
          if (privateId.length < 32) return json({ error: 'invalid privateId' }, 400);
          await env.DB.prepare(
            `INSERT INTO votes (bvid, category, public_id, vote, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(bvid, category, public_id)
             DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`,
          )
            .bind(bvid, category, await sha256(privateId), vote, Date.now())
            .run();
          return json({ ok: true });
        } catch {
          return json({ error: 'bad request' }, 400);
        }
      }

      // GET /database.json —— 全量发布
      if (req.method === 'GET' && url.pathname === '/database.json') {
        const subs = (
          await env.DB.prepare(
            `SELECT bvid, category, reason, evidence, claimed_lv6, region, region_v2, up_mid, up_name, created_at FROM submissions`,
          ).all<UnknownRow>()
        ).results;
        const votes = (await env.DB.prepare(`SELECT bvid, category, public_id, vote, created_at FROM votes`).all<UnknownRow>())
          .results;
        return json({
          format: 'bilimark-database/v0',
          exportedAt: new Date().toISOString(),
          note: '不含任何可识别个人身份的信息（public_id 为单向哈希）',
          submissions: subs,
          votes,
        });
      }

      // ---------- 管理端点（owner=ADMIN_KEY；moderator=mod_keys 分发）----------
      if (url.pathname.startsWith('/api/admin/')) {
        const auth = await adminAuth(req, env);
        if (!auth) return json({ error: 'not found' }, 404);
        const isOwner = auth.role === 'owner';

        if (req.method === 'GET' && url.pathname === '/api/admin/whoami') {
          return json({ role: auth.role, name: auth.name });
        }

        // moderator 密钥管理：仅 owner
        if (url.pathname === '/api/admin/mod-keys') {
          if (!isOwner) return json({ error: 'owner only' }, 403);
          if (req.method === 'GET') {
            const items = (
              await env.DB.prepare(`SELECT id, name, revoked, created_at FROM mod_keys ORDER BY created_at DESC`).all<UnknownRow>()
            ).results;
            return json({ items });
          }
          if (req.method === 'POST') {
            try {
              const body = (await req.json()) as { name?: string };
              const name = (body.name ?? '').trim().slice(0, 32);
              if (!name) return json({ error: 'name required' }, 400);
              const key = `bmk_mod_${crypto.randomUUID().replace(/-/g, '')}`;
              await env.DB.prepare(`INSERT INTO mod_keys (name, key_hash, created_at) VALUES (?, ?, ?)`)
                .bind(name, await sha256(key), Date.now())
                .run();
              await adminLog(env.DB, 'mod-key-create', name, auth.name);
              return json({ ok: true, name, key }); // 明文仅此一次
            } catch {
              return json({ error: 'bad request' }, 400);
            }
          }
          if (req.method === 'DELETE') {
            try {
              const body = (await req.json()) as { id?: number };
              const id = Number(body.id);
              if (!Number.isInteger(id)) return json({ error: 'invalid id' }, 400);
              await env.DB.prepare(`UPDATE mod_keys SET revoked = 1 WHERE id = ?`).bind(id).run();
              await adminLog(env.DB, 'mod-key-revoke', String(id), auth.name);
              return json({ ok: true });
            } catch {
              return json({ error: 'bad request' }, 400);
            }
          }
          return json({ error: 'not found' }, 404);
        }

        // 管理员直接确认/撤销确认（不虚增票数，管理员确认优先于社区驳回）
        if (req.method === 'POST' && (url.pathname === '/api/admin/confirm' || url.pathname === '/api/admin/unconfirm')) {
          try {
            const body = (await req.json()) as { bvid?: string; category?: string };
            const bvid = body.bvid ?? '';
            const category = body.category ?? '';
            if (!BVID_RE.test(bvid) || !CATEGORIES.has(category)) return json({ error: 'invalid payload' }, 400);
            if (url.pathname.endsWith('/confirm')) {
              await env.DB.prepare(
                `INSERT INTO admin_confirmations (bvid, category, operator, created_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(bvid, category) DO UPDATE SET operator = excluded.operator, created_at = excluded.created_at`,
              )
                .bind(bvid, category, auth.name, Date.now())
                .run();
              await adminLog(env.DB, 'confirm', `${bvid}|${category}`, auth.name);
            } else {
              await env.DB.prepare(`DELETE FROM admin_confirmations WHERE bvid = ? AND category = ?`)
                .bind(bvid, category)
                .run();
              await adminLog(env.DB, 'unconfirm', `${bvid}|${category}`, auth.name);
            }
            return json({ ok: true });
          } catch {
            return json({ error: 'bad request' }, 400);
          }
        }

        // 提交趋势统计（面板概览）：每日提交数与活跃贡献者数
        if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
          const days = Math.min(Number(url.searchParams.get('days') ?? 14) || 14, 90);
          const since = Date.now() - days * 86_400_000;
          const daily = (
            await env.DB.prepare(
              `SELECT date(created_at / 1000, 'unixepoch') AS day,
                      COUNT(*) AS submissions,
                      COUNT(DISTINCT public_id) AS contributors
               FROM submissions WHERE created_at >= ?
               GROUP BY day ORDER BY day ASC`,
            )
              .bind(since)
              .all<{ day: string; submissions: number; contributors: number }>()
          ).results;
          const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first<{ n: number }>())?.n ?? 0;
          return json({ total, daily });
        }

        // 当前管理员确认清单（面板「管理确认」页：撤销入口）
        if (req.method === 'GET' && url.pathname === '/api/admin/confirmations') {
          const items = (
            await env.DB.prepare(`SELECT bvid, category, operator, created_at FROM admin_confirmations ORDER BY created_at DESC`).all<UnknownRow>()
          ).results;
          return json({ items });
        }

        // 触发中的 UP 主警示清单（全库聚合，管理监控用）
        if (req.method === 'GET' && url.pathname === '/api/admin/upwarnings') {
          const rows = (
            await env.DB.prepare(`SELECT DISTINCT bvid FROM submissions WHERE up_mid IS NOT NULL`).all<{ bvid: string }>()
          ).results;
          const allBvids = rows.map((r) => r.bvid);
          const { upWarnings } = allBvids.length > 0 ? await aggregate(env.DB, allBvids, null, true) : { upWarnings: {} };
          return json({ upWarnings });
        }

        // 删除单条提交（物理删除，区别于影子封禁）
        if (req.method === 'DELETE' && url.pathname === '/api/admin/delete-submission') {
          try {
            const body = (await req.json()) as { id?: number };
            const id = Number(body.id);
            if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, 400);
            const info = await env.DB.prepare(`DELETE FROM submissions WHERE id = ?`).bind(id).run();
            await adminLog(env.DB, 'delete-submission', String(id), auth.name);
            return json({ ok: true, deleted: info.meta.changes ?? 0 });
          } catch {
            return json({ error: 'bad request' }, 400);
          }
        }

        // 审计日志
        if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
          const items = (
            await env.DB.prepare(`SELECT id, action, target, operator, created_at FROM admin_log ORDER BY id DESC LIMIT ?`)
              .bind(limit)
              .all<UnknownRow>()
          ).results;
          return json({ items });
        }

        if (req.method === 'GET' && url.pathname === '/api/admin/claimed-lv6') {
          const items = (
            await env.DB.prepare(
              `SELECT id, bvid, category, reason, public_id, created_at FROM submissions WHERE claimed_lv6 = 1 ORDER BY created_at DESC`,
            ).all<UnknownRow>()
          ).results;
          return json({ items });
        }
        // 最近提交清单（含 public_id）：发现与定位恶意贡献者用（配合 shadowban）
        if (req.method === 'GET' && url.pathname === '/api/admin/recent-submissions') {
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
          const items = (
            await env.DB.prepare(
              `SELECT id, bvid, category, reason, public_id, claimed_lv6, up_mid, up_name, created_at
               FROM submissions ORDER BY created_at DESC LIMIT ?`,
            )
              .bind(limit)
              .all<UnknownRow>()
          ).results;
          return json({ items });
        }
        // 撤销某条提交的 Lv6 豁免（GOVERNANCE.md「等级豁免」抽查发现造假时）
        if (req.method === 'POST' && url.pathname === '/api/admin/revoke-lv6') {
          try {
            const body = (await req.json()) as { id?: number };
            const id = Number(body.id);
            if (!Number.isInteger(id) || id <= 0) return json({ error: 'invalid id' }, 400);
            const info = await env.DB.prepare(
              `UPDATE submissions SET claimed_lv6 = 0 WHERE id = ? AND claimed_lv6 = 1`,
            )
              .bind(id)
              .run();
            return json({ ok: true, revoked: info.meta.changes ?? 0 });
          } catch {
            return json({ error: 'bad request' }, 400);
          }
        }
        if (req.method === 'POST' && (url.pathname === '/api/admin/shadowban' || url.pathname === '/api/admin/unshadowban')) {
          try {
            const body = (await req.json()) as { publicId?: string; note?: string };
            const publicId = body.publicId ?? '';
            if (!/^[0-9a-f]{64}$/.test(publicId)) return json({ error: 'publicId must be sha256 hex' }, 400);
            if (url.pathname.endsWith('/shadowban')) {
              await env.DB.prepare(
                `INSERT INTO shadowbans (public_id, note, created_at) VALUES (?, ?, ?)
                 ON CONFLICT(public_id) DO UPDATE SET note = excluded.note`,
              )
                .bind(publicId, body.note ?? '', Date.now())
                .run();
            } else {
              await env.DB.prepare(`DELETE FROM shadowbans WHERE public_id = ?`).bind(publicId).run();
            }
            return json({ ok: true });
          } catch {
            return json({ error: 'bad request' }, 400);
          }
        }
        return json({ error: 'not found' }, 404);
      }

      return json({ error: 'not found' }, 404);
    } catch {
      return json({ error: 'internal error' }, 500);
    }
  },
};

// 高敏分区清单：与 src/index.ts 的 SENSITIVE_TIDS 保持一致（分区隔离墙，ADR-0004）
const SENSITIVE_TIDS = new Set<number>([
  202, 203, 204, 205, 206,
  1009, 2080, 2081, 2082, 2083,
  2088, 2089,
]);
