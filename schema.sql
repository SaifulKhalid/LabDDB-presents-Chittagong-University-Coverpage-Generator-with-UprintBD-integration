-- =============================================================================
-- schema.sql — Cloudflare D1 Database Schema for LabDDB x UprintBD
-- Advanced user management, immutable audit logging, and job history tracking.
-- =============================================================================

-- 1. Administrative Audit Logs
-- Records every privileged action (top-ups, adjustments, role changes, price edits, forced settles).
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,            -- Unix ms
  action TEXT NOT NULL,                  -- 'topup', 'adjustment', 'user_flags', 'pricing_change', 'force_settle', 'force_expire', 'unmatched_clear'
  actor_uid TEXT NOT NULL,               -- UID of the admin
  actor_email TEXT NOT NULL,             -- Verified email of the admin
  target_uid TEXT,                       -- Target user UID (if applicable)
  details TEXT,                          -- JSON string with parameters / state before-after
  ip TEXT,                               -- Client IP address
  user_agent TEXT                        -- Client User-Agent
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_uid);

-- 2. User Activity & History
-- Tracks sign-ins, profile syncs, and generator interactions.
CREATE TABLE IF NOT EXISTS user_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,            -- Unix ms
  uid TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  action TEXT NOT NULL,                  -- 'sign_in', 'profile_sync', 'quote_request', 'otp_mint', 'job_cancel'
  metadata TEXT,                         -- JSON string of extra context (e.g. course, roll, device)
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_history_uid ON user_history(uid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_user_history_timestamp ON user_history(timestamp DESC);

-- 3. Print Jobs Archive
-- Relational, queryable store of all cover page and kiosk print jobs.
CREATE TABLE IF NOT EXISTS print_jobs_archive (
  job_id TEXT PRIMARY KEY,               -- e.g. 19e9s2b7H8K
  uid TEXT NOT NULL,
  email TEXT,
  roll TEXT,
  course_code TEXT,
  title TEXT,
  tool TEXT,
  pages INTEGER NOT NULL DEFAULT 1,
  copies INTEGER NOT NULL DEFAULT 1,
  color INTEGER NOT NULL DEFAULT 0,      -- 0 for mono, 1 for color
  price INTEGER NOT NULL,                -- Integer BDT charged to student
  unit_price INTEGER NOT NULL,
  uprint_estimate INTEGER,               -- Declared cost to UprintBD
  actual_cost REAL,                      -- Real cost billed by UprintBD (e.g. 2.0)
  otp TEXT,                              -- 6-digit kiosk OTP
  record_id TEXT,                        -- UprintBD internal record id
  status TEXT NOT NULL,                  -- 'reserving', 'reserved', 'printed', 'expired', 'cancelled', 'failed'
  r2_pdf_key TEXT,                       -- Object key in R2 storage (if uploaded)
  created_at INTEGER NOT NULL,           -- Unix ms
  expires_at INTEGER,                    -- Unix ms
  settled_at INTEGER,                    -- Unix ms
  released_at INTEGER,                   -- Unix ms
  device_id TEXT,                        -- Kiosk device identifier
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_uid ON print_jobs_archive(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs_archive(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_created ON print_jobs_archive(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_roll ON print_jobs_archive(roll);
CREATE INDEX IF NOT EXISTS idx_print_jobs_course ON print_jobs_archive(course_code);

-- 4. Wallet Ledger Archive
-- Permanent SQL audit trail of all financial movements (top-up, hold, settle, release, adjustments).
CREATE TABLE IF NOT EXISTS wallet_ledger_archive (
  id TEXT PRIMARY KEY,                   -- e.g. top_19e9s2b7, chg_19e9s2b7, ref_19e9s2b7
  uid TEXT NOT NULL,
  type TEXT NOT NULL,                    -- 'topup', 'charge', 'adjustment', 'refund', 'hold', 'release'
  amount INTEGER NOT NULL,               -- Signed integer BDT (+ for credit, - for debit)
  balance_after INTEGER NOT NULL,
  job_id TEXT,
  note TEXT,
  by_uid TEXT,                           -- Admin UID if admin-initiated
  method TEXT,                           -- 'bKash', 'cash', etc.
  timestamp INTEGER NOT NULL             -- Unix ms
);

CREATE INDEX IF NOT EXISTS idx_ledger_uid ON wallet_ledger_archive(uid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_timestamp ON wallet_ledger_archive(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_job ON wallet_ledger_archive(job_id);
