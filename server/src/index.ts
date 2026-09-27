/**
 * BiliMark 轻量 API 服务器（v0.3）
 *
 * 零运行时依赖：node:http + Node 24 内置 node:sqlite（ADR-0006）。
 * 单文件微服务是有意的——契合 ADR-0005 的零成本与可接管性：
 * 数据库就是一个 SQLite 文件，复制即备份，发布即全量（/database.json）。
 * 规模到了再拆文件、再换 Postgres。
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8787);
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.BILIMARK_DATA_DIR ?? join(here, '..', 'data');
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, 'bilimark.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT NOT NULL,
    category TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    public_id TEXT NOT NULL,
    claimed_lv6 INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(bvid, category, public_id)
  );
  CREATE TABLE IF NOT EXISTS votes (
    bvid TEXT NOT NULL,
    category TEXT NOT NULL,
    public_id TEXT NOT NULL,
    vote INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(bvid, category, public_id)
  );
  CREATE TABLE IF NOT EXISTS shadowbans (
    public_id TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
`);
// 旧库迁移：v0.3 前的 submissions 表补列（已存在则忽略）
for (const ddl of [
  'ALTER TABLE submissions ADD COLUMN claimed_lv6 INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE submissions ADD COLUMN region INTEGER', // 视频分区（v1 体系 tid），二期分社区对比的数据基础
  'ALTER TABLE submissions ADD COLUMN region_v2 INTEGER', // 视频分区（v2 新体系 tid_v2）
  'ALTER TABLE submissions ADD COLUMN up_mid INTEGER', // UP 主 mid（元数据，派生 UP警示用）
  'ALTER TABLE submissions ADD COLUMN up_name TEXT',
]) {
  try {
    db.exec(ddl);
  } catch {
    // 列已存在
  }
}

/** 调优待定项（FEASIBILITY.md 实现期待定项）：先写死，跑起来有数据再调 */
const CONFIRM_THRESHOLD = 3; // 净票 ≥ 3 → 已确认
const HIDE_THRESHOLD = -2; // 净票 ≤ -2 → 驳回（隐藏）
const NOVICE_SUBMISSIONS = 3; // 新手期：公开 ID 的前 3 条提交（GOVERNANCE.md）
const NOVICE_MULTIPLIER = 2; // 新手期确认阈值倍数（全新手标记需 6 票）
const UP_WARNING_THRESHOLD = 3; // UP主警示：同 UP 同分类「已确认」视频数门槛（CONTEXT.md，调优待定项）
const ADMIN_KEY = process.env.ADMIN_KEY ?? ''; // 未设置则管理端点不可达（404，不暴露存在）
const CATEGORIES = new Set(['ai_low_effort', 'clickbait', 'misinformation']);
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;

/**
 * 高敏分区（ADR-0004 分区隔离墙）：不接受提交、不展示提醒。
 * v1 从紧：资讯区 = 时政/社会/国际新闻，「造谣」标记在此等于替用户做政治定论。
 * tid 体系依据 bilibili-API-collect video_zone.md / video_zone_v2.md（2026-09 查证）；
 * 124 社科·法律·心理、207/2087 财经商业属知识区，风险较低，v1 保持开放，清单可调。
 */
const SENSITIVE_TIDS = new Set<number>([
  202, 203, 204, 205, 206, // v1 资讯区：主分区/热点(时政)/环球/社会/综合
  1009, 2080, 2081, 2082, 2083, // v2 资讯区：主分区/时政资讯/海外资讯/社会资讯/综合资讯
  2088, 2089, // v2 知识区：社会观察/时政解读
]);

interface SubRow {
  id: number;
  bvid: string;
  category: string;
  reason: string;
  evidence: string;
  public_id: string;
  claimed_lv6: number;
  up_mid: number | null;
  up_name: string | null;
  created_at: number;
}
interface VoteRow {
  bvid: string;
  category: string;
  public_id: string;
  vote: number;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---------- 简易限流：每 IP 每分钟 120 次 ----------
const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = hits.get(ip) ?? { n: 0, t: now };
  if (now - rec.t > 60_000) {
    rec.n = 0;
    rec.t = now;
  }
  rec.n += 1;
  hits.set(ip, rec);
  if (hits.size > 10_000) hits.clear(); // 防-map膨胀，粗粒度即可
  return rec.n > 120;
}

// ---------- 聚合：标记状态机（CONTEXT.md「标记状态机」）----------
interface Agg {
  net: number;
  against: number;
  reasons: Array<{ reason: string; at: number }>;
  evidence: Set<string>;
}

function aggregate(
  bvids: string[],
  asHash: string | null,
  upExpanded = false,
): {
  markings: Record<string, unknown[]>;
  upWarnings: Record<string, { name: string; categories: Record<string, number> }>;
} {
  const placeholders = bvids.map(() => '?').join(',');
  const subs = db
    .prepare(
      `SELECT id, bvid, category, reason, evidence, public_id, claimed_lv6, up_mid, up_name, created_at
       FROM submissions WHERE bvid IN (${placeholders}) ORDER BY created_at ASC`,
    )
    .all(...bvids) as unknown as SubRow[];
  const votes = db
    .prepare(
      `SELECT bvid, category, public_id, vote FROM votes WHERE bvid IN (${placeholders})`,
    )
    .all(...bvids) as unknown as VoteRow[];

  // 影子封禁：被处理者的内容全网隐藏，仅「as=本人哈希」时可见（GOVERNANCE.md）
  const shadowRows = db.prepare(`SELECT public_id FROM shadowbans`).all() as unknown as Array<{
    public_id: string;
  }>;
  const shadowSet = new Set(shadowRows.map((r) => r.public_id));
  const visible = (pid: string): boolean => !shadowSet.has(pid) || pid === asHash;

  const visSubs = subs.filter((s) => visible(s.public_id));
  const visVotes = votes.filter((v) => visible(v.public_id));

  // 新手期：按贡献者全部提交的 id 序（=时间序）取前 N 条；claimed_lv6 豁免
  const contributors = [...new Set(visSubs.map((s) => s.public_id))];
  const noviceSet = new Set<number>();
  if (contributors.length > 0) {
    const ph = contributors.map(() => '?').join(',');
    const allOf = db
      .prepare(
        `SELECT id, public_id, claimed_lv6 FROM submissions WHERE public_id IN (${ph}) ORDER BY public_id, id ASC`,
      )
      .all(...contributors) as unknown as Array<{
      id: number;
      public_id: string;
      claimed_lv6: number;
    }>;
    const counts = new Map<string, number>();
    for (const r of allOf) {
      const c = counts.get(r.public_id) ?? 0;
      if (c < NOVICE_SUBMISSIONS && !r.claimed_lv6) noviceSet.add(r.id);
      counts.set(r.public_id, c + 1);
    }
  }

  const byKey = new Map<string, Agg & { allNovice: boolean }>();
  for (const s of visSubs) {
    const key = `${s.bvid}|${s.category}`;
    const agg =
      byKey.get(key) ?? {
        net: 0,
        against: 0,
        reasons: [],
        evidence: new Set<string>(),
        allNovice: true,
      };
    agg.net += 1; // 提交者本人算一票赞成
    if (!noviceSet.has(s.id)) agg.allNovice = false;
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
  // UP主警示（CONTEXT.md「UP主警示」）：同 UP 同分类「已确认」视频数达门槛即警示。
  // 纯派生聚合，不可提交、不折算分数、只展示原始计数；up_mid 缺失的历史提交不参与。
  const upOf = new Map<string, { upMid: number; upName: string }>();
  for (const s of visSubs) {
    if (s.up_mid === null || s.up_mid === undefined) continue;
    const key = `${s.bvid}|${s.category}`;
    if (!upOf.has(key)) upOf.set(key, { upMid: s.up_mid, upName: s.up_name ?? '' });
  }
  const upCounts = new Map<number, { name: string; categories: Map<string, number> }>();
  for (const [key, agg] of byKey) {
    if (agg.net <= HIDE_THRESHOLD) continue; // 驳回：对全网隐藏
    const [bvid, category] = key.split('|');
    // 新手期乘法器：全部贡献者都在新手期 → 阈值翻倍（GOVERNANCE.md）
    const threshold = agg.allNovice ? CONFIRM_THRESHOLD * NOVICE_MULTIPLIER : CONFIRM_THRESHOLD;
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
    });
  }

  // 只输出达到门槛的 UP 警示；影子封禁/驳回天然不计入（visSubs 与 HIDE_THRESHOLD 已过滤）。
  // 关键：警示按 UP 名下【全库】视频统计，而非本次查询窗口——否则播放页单视频查询永远算不满。
  // 做法：查询涉及的 up → 找出其名下全部 bvid → 递归 aggregate 一轮（upExpanded=true 不再扩展）。
  const buildUpWarnings = (): Record<
    string,
    { name: string; categories: Record<string, number> }
  > => {
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
      const rows = db
        .prepare(`SELECT DISTINCT bvid FROM submissions WHERE up_mid IN (${ph}) LIMIT 500`)
        .all(...upMids) as unknown as Array<{ bvid: string }>;
      const allBvids = rows.map((r) => r.bvid);
      if (allBvids.some((b) => !bvids.includes(b))) {
        upWarnings = aggregate(allBvids, asHash, true).upWarnings;
      } else {
        upWarnings = buildUpWarnings();
      }
    }
  } else {
    upWarnings = buildUpWarnings();
  }
  return { markings: out, upWarnings };
}

// ---------- HTTP 骨架 ----------
function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 10_240): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const server = createServer((req, res) => {
  void (async () => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (rateLimited(ip)) {
      sendJson(res, 429, { error: 'rate limited' });
      return;
    }

    // GET /api/health
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n;
      sendJson(res, 200, { ok: true, submissions: n });
      return;
    }

    // GET /api/markings?bvids=BV1,BV2[&as=<本人 public_id 哈希>]
    if (req.method === 'GET' && url.pathname === '/api/markings') {
      const bvids = (url.searchParams.get('bvids') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => BVID_RE.test(s))
        .slice(0, 50);
      const asRaw = url.searchParams.get('as') ?? '';
      const as = /^[0-9a-f]{64}$/.test(asRaw) ? asRaw : null;
      if (bvids.length === 0) {
        sendJson(res, 200, { markings: {}, upWarnings: {} });
        return;
      }
      sendJson(res, 200, aggregate(bvids, as));
      return;
    }

    // POST /api/markings
    if (req.method === 'POST' && url.pathname === '/api/markings') {
      try {
        const body = JSON.parse(await readBody(req)) as {
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

        if (!BVID_RE.test(bvid) || !CATEGORIES.has(category)) {
          sendJson(res, 400, { error: 'invalid bvid or category' });
          return;
        }
        if (region !== null && (region < 0 || region > 10000)) {
          sendJson(res, 400, { error: 'invalid region' });
          return;
        }
        // 分区隔离墙（ADR-0004）：v1/v2 任一分区命中高敏清单即拒绝，双体系都查防止绕过
        if (
          (region !== null && SENSITIVE_TIDS.has(region)) ||
          (regionV2 !== null && SENSITIVE_TIDS.has(regionV2))
        ) {
          sendJson(res, 403, { error: 'sensitive zone not allowed' });
          return;
        }
        if (reason.length < 5 || reason.length > 500) {
          sendJson(res, 400, { error: 'reason must be 5-500 chars' });
          return;
        }
        if (category === 'misinformation' && evidence.length === 0) {
          sendJson(res, 400, { error: 'misinformation requires evidence' });
          return;
        }
        if (privateId.length < 32) {
          sendJson(res, 400, { error: 'invalid privateId' });
          return;
        }

        try {
          db.prepare(
            `INSERT INTO submissions (bvid, category, reason, evidence, public_id, claimed_lv6, region, region_v2, up_mid, up_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            bvid,
            category,
            reason,
            JSON.stringify(evidence),
            sha256(privateId),
            body.claimedLv6 === true ? 1 : 0,
            region,
            regionV2,
            upMid,
            upName || null,
            Date.now(),
          );
        } catch {
          sendJson(res, 409, { error: 'already submitted' }); // 同一贡献者对同一(视频,分类)唯一
          return;
        }
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 400, { error: 'bad request' });
      }
      return;
    }

    // DELETE /api/markings —— 撤回（CONTEXT.md「提交」：撤回后可重新提交）
    if (req.method === 'DELETE' && url.pathname === '/api/markings') {
      try {
        const body = JSON.parse(await readBody(req)) as {
          bvid?: string;
          category?: string;
          privateId?: string;
        };
        const bvid = body.bvid ?? '';
        const category = body.category ?? '';
        const privateId = body.privateId ?? '';
        if (!BVID_RE.test(bvid) || !CATEGORIES.has(category) || privateId.length < 32) {
          sendJson(res, 400, { error: 'invalid payload' });
          return;
        }
        const info = db
          .prepare(`DELETE FROM submissions WHERE bvid = ? AND category = ? AND public_id = ?`)
          .run(bvid, category, sha256(privateId));
        sendJson(res, 200, { ok: true, deleted: Number(info.changes) }); // 0 = 服务器本无此条，同样视为撤回完成
      } catch {
        sendJson(res, 400, { error: 'bad request' });
      }
      return;
    }

    // POST /api/vote
    if (req.method === 'POST' && url.pathname === '/api/vote') {
      try {
        const body = JSON.parse(await readBody(req)) as {
          bvid?: string;
          category?: string;
          vote?: number;
          privateId?: string;
        };
        const bvid = body.bvid ?? '';
        const category = body.category ?? '';
        const vote = body.vote ?? 0;
        const privateId = body.privateId ?? '';
        if (!BVID_RE.test(bvid) || !CATEGORIES.has(category) || (vote !== 1 && vote !== -1)) {
          sendJson(res, 400, { error: 'invalid vote payload' });
          return;
        }
        if (privateId.length < 32) {
          sendJson(res, 400, { error: 'invalid privateId' });
          return;
        }
        // 一人一票可改票：UNIQUE(bvid, category, public_id) + REPLACE
        db.prepare(
          `INSERT INTO votes (bvid, category, public_id, vote, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(bvid, category, public_id)
           DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`,
        ).run(bvid, category, sha256(privateId), vote, Date.now());
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 400, { error: 'bad request' });
      }
      return;
    }

    // GET /database.json —— 全量发布（ADR-0005：可接管性）
    if (req.method === 'GET' && url.pathname === '/database.json') {
      const subs = db
        .prepare(
          `SELECT bvid, category, reason, evidence, claimed_lv6, region, region_v2, up_mid, up_name, created_at
           FROM submissions`,
        )
        .all() as unknown as Array<{
        bvid: string;
        category: string;
        reason: string;
        evidence: string;
        claimed_lv6: number;
        region: number | null;
        region_v2: number | null;
        up_mid: number | null;
        up_name: string | null;
        created_at: number;
      }>;
      const votes = db
        .prepare(`SELECT bvid, category, public_id, vote, created_at FROM votes`)
        .all();
      sendJson(res, 200, {
        format: 'bilimark-database/v0',
        exportedAt: new Date().toISOString(),
        note: '不含任何可识别个人身份的信息（public_id 为单向哈希）',
        submissions: subs,
        votes,
      });
      return;
    }

    // ---------- 管理端点（X-Admin-Key；未配置 ADMIN_KEY 时一律 404 不暴露存在）----------
    if (url.pathname.startsWith('/api/admin/')) {
      if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      // claimed-Lv6 清单：GOVERNANCE.md 的低频抽样核查用
      if (req.method === 'GET' && url.pathname === '/api/admin/claimed-lv6') {
        const items = db
          .prepare(
            `SELECT id, bvid, category, reason, public_id, created_at
             FROM submissions WHERE claimed_lv6 = 1 ORDER BY created_at DESC`,
          )
          .all();
        sendJson(res, 200, { items });
        return;
      }
      if (
        req.method === 'POST' &&
        (url.pathname === '/api/admin/shadowban' || url.pathname === '/api/admin/unshadowban')
      ) {
        try {
          const body = JSON.parse(await readBody(req)) as {
            publicId?: string;
            note?: string;
          };
          const publicId = body.publicId ?? '';
          if (!/^[0-9a-f]{64}$/.test(publicId)) {
            sendJson(res, 400, { error: 'publicId must be sha256 hex' });
            return;
          }
          if (url.pathname.endsWith('/shadowban')) {
            db.prepare(
              `INSERT INTO shadowbans (public_id, note, created_at) VALUES (?, ?, ?)
               ON CONFLICT(public_id) DO UPDATE SET note = excluded.note`,
            ).run(publicId, body.note ?? '', Date.now());
          } else {
            db.prepare(`DELETE FROM shadowbans WHERE public_id = ?`).run(publicId);
          }
          sendJson(res, 200, { ok: true });
        } catch {
          sendJson(res, 400, { error: 'bad request' });
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  })().catch(() => {
    try {
      sendJson(res, 500, { error: 'internal error' });
    } catch {
      // 已响应过则忽略
    }
  });
});

server.listen(PORT, () => {
  console.log(`[BiliMark server] listening on http://127.0.0.1:${PORT}`);
});
