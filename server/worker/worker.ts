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

const CONFIRM_THRESHOLD = 3;
const HIDE_THRESHOLD = -2;
const NOVICE_SUBMISSIONS = 3;
const NOVICE_MULTIPLIER = 2;
const UP_WARNING_THRESHOLD = 3;
const OPINION_CONFIRM_THRESHOLD = 5; // 观点类分类（黑流量）确认门槛，与 src/index.ts 同步
const CATEGORIES = new Set([
  'ai_low_effort',
  'clickbait',
  'misinformation',
  'stolen',
  'engagement_bait',
]);
/** 分类确认阈值：观点类 5 票，事实类 3 票 */
function thresholdFor(category: string): number {
  return category === 'engagement_bait' ? OPINION_CONFIRM_THRESHOLD : CONFIRM_THRESHOLD;
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
    if (agg.net <= HIDE_THRESHOLD) continue;
    const [bvid, category] = key.split('|');
    const threshold = thresholdFor(category) * (agg.allNovice ? NOVICE_MULTIPLIER : 1);
    const confirmed = agg.net >= threshold;
    const up = upOf.get(key);
    if (confirmed && up) {
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

      // GET /api/health
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first<{ n: number }>();
        return json({ ok: true, submissions: row?.n ?? 0 });
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
          // 盗视频：原视频链接必填（不限平台）
          if (category === 'stolen' && evidence.length === 0) return json({ error: 'stolen requires source video link' }, 400);
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

      // ---------- 管理端点 ----------
      if (url.pathname.startsWith('/api/admin/')) {
        if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) {
          return json({ error: 'not found' }, 404);
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/claimed-lv6') {
          const items = (
            await env.DB.prepare(
              `SELECT id, bvid, category, reason, public_id, created_at FROM submissions WHERE claimed_lv6 = 1 ORDER BY created_at DESC`,
            ).all<UnknownRow>()
          ).results;
          return json({ items });
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
