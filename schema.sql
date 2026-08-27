-- 成员表；realName 只存哈希，绝不落明文（§3.4）
CREATE TABLE IF NOT EXISTS members (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  real_name_lookup TEXT UNIQUE,          -- SHA-256(realName + PEPPER)，确定性哈希，用于查重/等值查找
  real_name_verify TEXT,                 -- 慢哈希(PBKDF2)，用于验证比对
  name             TEXT NOT NULL,
  generation       TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT '',
  bio              TEXT NOT NULL DEFAULT '',
  avatar           TEXT NOT NULL DEFAULT '',
  tags             TEXT NOT NULL DEFAULT '[]',
  social           TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL
);

-- 审核记录表（§3.3）
CREATE TABLE IF NOT EXISTS submissions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  verified_by_real_name  INTEGER NOT NULL DEFAULT 1,
  member_id              INTEGER NOT NULL,
  member_name            TEXT NOT NULL,
  changes                TEXT NOT NULL,
  old_data               TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  reason                 TEXT,
  reviewed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at);

-- verifyToken 表：一次性、5 分钟有效期
CREATE TABLE IF NOT EXISTS verify_tokens (
  token      TEXT PRIMARY KEY,
  member_id  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL              -- unix 毫秒
);

-- adminToken 会话表：支持服务端吊销（§6.4）
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- 限流表（§6.3）
CREATE TABLE IF NOT EXISTS rate_limits (
  ip       TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits ON rate_limits(endpoint, ip, ts);
