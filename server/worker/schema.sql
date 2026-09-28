-- BiliMark D1 建表（Cloudflare 路线一次性执行；node 版由 src/index.ts 运行时迁移自动建列）
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bvid TEXT NOT NULL,
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  public_id TEXT NOT NULL,
  claimed_lv6 INTEGER NOT NULL DEFAULT 0,
  region INTEGER,
  region_v2 INTEGER,
  up_mid INTEGER,
  up_name TEXT,
  bvid_hash TEXT,
  duration INTEGER,
  ai_declared INTEGER,
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
CREATE TABLE IF NOT EXISTS mod_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bvid TEXT NOT NULL,
  category TEXT NOT NULL,
  operator TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(bvid, category)
);
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  operator TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_bvid_hash ON submissions(bvid_hash);
CREATE INDEX IF NOT EXISTS idx_submissions_up_mid ON submissions(up_mid);
