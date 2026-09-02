# Deployment Guide: Local & Cloudflare Workers

## 1. Runtime Overview

The platform is designed to execute seamlessly across two runtime environments with **identical business logic**:

| Environment | Host Runtime | Entrypoint | Database | Background Cron |
| :--- | :--- | :--- | :--- | :--- |
| **Development** | Node.js >= 20 | `server.js` | Firebase RTDB (REST) | `setInterval` (60s) |
| **Production** | Cloudflare Workers | `src/worker.js` | RTDB + D1 (SQL) + R2 | Cloudflare Cron Trigger (1m) |

---

## 2. Local Development Setup

### Prerequisites
- Node.js >= 20.0.0 (required for `Headers.getSetCookie()` and native WebCrypto).

### Step-by-Step
1. Clone the repository and enter the directory:
   ```bash
   cd f:/Territory/MissionUprint/Pitch
   ```
2. Copy environment template:
   ```bash
   cp .env.example .env
   ```
3. Populate `.env` with your credentials:
   - `UPRINT_EMAIL` / `UPRINT_PASSWORD`
   - `FIREBASE_API_KEY`
   - `LABDDB_DATABASE_URL` / `LABDDB_SERVICE_ACCOUNT`
   - `ADMIN_EMAIL`
4. Start the local server:
   ```bash
   npm start
   ```
5. Open `http://localhost:3000/` in your browser.

---

## 3. Cloudflare Workers Production Deployment

### Prerequisites
- Cloudflare CLI: `npm install -g wrangler` or `npx wrangler`
- Logged into Cloudflare: `npx wrangler login`

### Step 1: Create Cloudflare Resources
1. **Create D1 Database**:
   ```bash
   npx wrangler d1 create labddb-audit
   ```
   *Copy the `database_id` output into `wrangler.toml` under `[[d1_databases]]`*.

2. **Initialize D1 Schema**:
   ```bash
   npx wrangler d1 execute labddb-audit --command="
     CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, action TEXT, actor_uid TEXT, actor_email TEXT, target_uid TEXT, details TEXT, ip TEXT, user_agent TEXT);
     CREATE TABLE IF NOT EXISTS user_history (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, uid TEXT, email TEXT, display_name TEXT, action TEXT, metadata TEXT, ip TEXT, user_agent TEXT);
     CREATE TABLE IF NOT EXISTS print_jobs_archive (job_id TEXT PRIMARY KEY, uid TEXT, email TEXT, roll TEXT, courseCode TEXT, title TEXT, tool TEXT, pages INTEGER, copies INTEGER, color INTEGER, price REAL, unit_price REAL, uprint_estimate REAL, actual_cost REAL, otp TEXT, record_id TEXT, status TEXT, r2_pdf_key TEXT, created_at INTEGER, expires_at INTEGER, settled_at INTEGER, released_at INTEGER, device_id TEXT, failure_reason TEXT);
     CREATE TABLE IF NOT EXISTS wallet_ledger_archive (id TEXT PRIMARY KEY, uid TEXT, type TEXT, amount REAL, balance_after REAL, job_id TEXT, note TEXT, by_uid TEXT, method TEXT, timestamp INTEGER);
   "
   ```

3. **Create R2 Bucket**:
   ```bash
   npx wrangler r2 bucket create labddb-covers
   ```

### Step 2: Configure `wrangler.toml`
Ensure `wrangler.toml` references the created bindings:
```toml
name = "labddb-uprint-pitch"
main = "src/worker.js"
compatibility_date = "2024-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "public"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "labddb-audit"
database_id = "<YOUR_D1_DATABASE_ID>"

[[r2_buckets]]
binding = "COVERS_BUCKET"
bucket_name = "labddb-covers"

[triggers]
crons = ["* * * * *"]
```

### Step 3: Configure Cloudflare Secrets
Never commit private keys to version control. Push secrets via Wrangler:
```bash
npx wrangler secret put UPRINT_EMAIL
npx wrangler secret put UPRINT_PASSWORD
npx wrangler secret put FIREBASE_API_KEY
npx wrangler secret put LABDDB_DATABASE_URL
npx wrangler secret put LABDDB_SERVICE_ACCOUNT
npx wrangler secret put LDDB_DEMO_SERVICE_ACCOUNT
npx wrangler secret put ADMIN_EMAIL
```

### Step 4: Deploy
```bash
npm run deploy
```
Wrangler uploads the worker script, binds the Cron trigger, and serves static files from `public/` automatically.
