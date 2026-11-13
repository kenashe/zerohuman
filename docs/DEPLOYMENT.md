# Deployment (Railway) and fresh-wallet setup

> Nothing in this guide should be run against **mainnet** until the launch checklist
> ([LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md)) is approved. Do the whole procedure on Sepolia first.

## 1. Create fresh wallets (on your own trusted machine)

Never reuse a key from the previous experiment or any personal wallet.

```bash
git clone https://github.com/kenashe/zerohuman && cd zerohuman && npm ci
npm run keygen -- --label seller        --out ./wallets/seller.key        # mainnet seller hot wallet
npm run keygen -- --label test-buyer    --out ./wallets/test-buyer.key    # allowlisted test buyer
npm run keygen -- --label sepolia-seller --out ./wallets/sepolia-seller.key
npm run keygen -- --label sepolia-buyer  --out ./wallets/sepolia-buyer.key
```

Each command prints only the address; the key is written once to a `0600` file in the
git-ignored `wallets/` directory. After pasting a key into Railway, move the file to offline
storage (password manager / encrypted USB) and delete it from the laptop.

Recommended: a separate **cold** address you already control (hardware wallet) to receive sweeps.

## 2. Railway service

1. Railway → New Project → Deploy from GitHub repo → `kenashe/zerohuman`.
   Railway detects the `Dockerfile` and builds it automatically.
2. **Settings → Deploy**
   - Start command: leave empty (Dockerfile `CMD` = `node dist/seller/main.js`).
   - Healthcheck path: `/health`, timeout `120` s.
   - Restart policy: `ON_FAILURE`, max retries `10`.
   - Replicas: **1** (never more — the design uses a single signer).
3. **Volume**: add a volume to the service, mount path **`/data`**, 1 GB is plenty.
   A service with a volume is pinned to one instance and redeploys without overlap, which is what
   we want. The DB lease is a second line of defence.
4. **Networking**: generate a public domain only if you want the read-only status API/dashboard.
   The worker needs no inbound traffic to operate.
5. **Variables**: copy from [`.env.example`](../.env.example). Mark `SELLER_PRIVATE_KEY` and
   `DEEPSEEK_API_KEY` as sealed/secret variables.

> **Why no `railway.json`?** Railway's Config-as-Code files stop being read on 2026-12-01, and its
> replacement (Infrastructure as Code, `.railway/railway.ts`) is experimental and cannot yet configure
> service volumes. To avoid configuration that silently stops applying, the deployment uses the
> auto-detected Dockerfile plus the dashboard settings above. If you later adopt IaC, run
> `railway config pull` to import these settings rather than writing them by hand.

### Volume permissions

The image runs as the unprivileged `node` user. If logs show `SQLITE_CANTOPEN` or `EACCES` for
`/data`, the mounted volume is root-owned on your host: set the service variable
`RAILWAY_RUN_UID=0` (Railway's documented switch for non-root images with volumes), redeploy, and
check again.

## 3. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CHAIN_ID` | | `1` | `1` mainnet, `11155111` Sepolia |
| `RPC_URL` | ✔ | | HTTPS RPC URL(s), comma-separated; first = primary. Use a keyed provider (Alchemy/Infura/QuickNode) + a public fallback |
| `SELLER_PRIVATE_KEY` | ✔ secret | | dedicated hot-wallet key |
| `START_BLOCK` | ✔ first run | head − confirmations | first block to scan on an empty DB; set to the launch block |
| `DATABASE_PATH` | | `/data/zerohuman.db` (Docker) | SQLite file on the volume |
| `CONFIRMATIONS` | | `6` mainnet / `2` testnet | depth before acting on an order or a decision's target block |
| `BUYER_ALLOWLIST` | | empty (nobody) | comma-separated buyer addresses that are fulfilled |
| `PUBLIC_BUYERS` | | | set to exactly `I_APPROVE_PUBLIC_BUYERS` to remove the allowlist |
| `PAUSED` | | `false` | emergency stop: sign nothing |
| `MAX_FEE_PER_GAS_GWEI` | | `3` | absolute fee cap |
| `MAX_PRIORITY_FEE_GWEI` | | `0.05` | tip cap (the node's suggestion is used when lower) |
| `MAX_DELIVERY_COST_WEI` | | `75000000000000` | worst-case gas (limit × maxFee) per delivery; 75 % of the price |
| `DELIVERY_GAS_LIMIT_CAP` | | `80000` | refuse recipients that need more gas |
| `DAILY_GAS_BUDGET_WEI` | | `2000000000000000` | rolling 24 h spend cap (0.002 ETH) |
| `MAX_ORDERS_PER_DAY` | | `300` | fulfilment cap per rolling 24 h |
| `MIN_BALANCE_WEI` | | `0` | keep at least this much after a send |
| `STUCK_AFTER_MS` / `FEE_BUMP_PERCENT` / `MAX_REPLACEMENTS` | | `180000` / `20` / `3` | stuck-tx replacement policy |
| `LLM_PROVIDER` | | `deepseek` | `deepseek` or `none` (fallback text only). `mock` is refused on mainnet |
| `DEEPSEEK_API_KEY` | ✔ if deepseek | secret | |
| `LLM_MODEL` | | `deepseek-flash` | |
| `LLM_TIMEOUT_MS` / `LLM_MAX_TOKENS` / `LLM_DAILY_CALL_LIMIT` | | `15000` / `220` / `500` | model limits |
| `SWEEP_TO_ADDRESS` | | | optional cold wallet for automatic revenue sweeps |
| `SWEEP_ABOVE_WEI` / `SWEEP_KEEP_WEI` | | 0.01 / 0.003 ETH | sweep when balance exceeds X, leaving Y for gas |
| `HTTP_ENABLED` | | `true` | read-only status API + dashboard |
| `PORT` | | Railway-injected | |
| `POLL_INTERVAL_MS` | | `6000` | |
| `LOG_LEVEL` | | `info` | |
| `PUBLIC_STATUS_URL` | | | informational |
| `ENS_CHECK` | | `true` on mainnet | refuse to sign unless `addr(ENS_NAME)` = seller and the catalog agrees |
| `ENS_NAME` | | `zerohuman.eth` | |
| `ENS_RPC_URL` | | first `RPC_URL` on mainnet | mainnet RPC used for ENS (required if `ENS_CHECK=true` on a testnet) |
| `ENS_CHECK_INTERVAL_MS` | | `600000` | |

## 4. Operating

Open a shell in the running service (Railway CLI `railway ssh`, or the dashboard shell) and use
the admin tool against the volume:

```bash
node dist/cli/admin.js status
node dist/cli/admin.js review
node dist/cli/admin.js events 50
node dist/cli/admin.js approve-refund 0x<order>
node dist/cli/admin.js pause "investigating"      # and: resume operator
```

Logs are JSON lines. Useful filters: `"level":"warn"`, `"msg":"transaction mined"`, `"paused"`.

`PAUSED` is configuration-controlled: `PAUSED=true` pauses on start and `PAUSED=false` (or removing it)
clears that pause on the next start. It does **not** clear an `operator` pause set with `zh-admin pause` or
a security pause such as `nonce`; those still require `zh-admin resume <kind>`.

## 5. Public dashboard (optional)

The worker serves the dashboard at `/` on its Railway domain, reading `/api/status` and
`/api/orders` from the same origin. To host it elsewhere (GitHub Pages, any static host), publish
`dashboard/index.html` and open it as `index.html?api=https://<railway-domain>`; the API sends
`Access-Control-Allow-Origin: *` and is read-only. The proof verifier on the page reads directly
from a public Ethereum RPC and works even if the API is down.

## 6. Upgrades and restarts

Deploys and restarts are safe at any moment: state is durable and every action is idempotent.
SIGTERM finishes the current tick, releases the lease, and exits. After a crash the new instance
waits for the old lease to expire (≤ 90 s) unless it has the same `RAILWAY_DEPLOYMENT_ID`.

## 7. Key rotation

1. `PAUSED=true`, wait for in-flight deliveries to mine (`admin status` → outbox has no `signed`).
2. Generate a new key, set `SELLER_PRIVATE_KEY`, fund it with a small gas float.
3. Update the ENS catalog `seller` field and publish.
4. Sweep the old wallet to cold storage. Keep the old DB (do not reuse it with a new seller address;
   start a new volume or DB path and set `START_BLOCK`).
