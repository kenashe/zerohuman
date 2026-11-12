# Cost estimates

All gas figures are **measured** (anvil, Prague/Osaka rules incl. the EIP-7623 calldata floor);
mainnet fee levels were sampled from the last 1,024 mainnet blocks on 2026-11-12 (block ≈ 26,395,450).
Dollar figures assume ETH = $3,000 — scale linearly.

## Per order (seller side)

| Item | Measured / assumed | Cost |
|---|---|---|
| Decision delivery tx | 36,840 gas (396-byte response) | — |
| Encouragement delivery tx | 34,000–34,840 gas (325-byte response) | — |
| Mainnet base fee | p10 0.063 · **p50 0.097** · p90 0.171 · max 0.293 gwei | — |
| Priority fee | median 0.01 gwei | — |
| **Delivery at p50** | 36,840 × 0.107 gwei | **≈ 3.9 × 10¹² wei ≈ 0.0000039 ETH (3.9 % of price) ≈ $0.012** |
| Delivery at p90 | 36,840 × 0.181 gwei | ≈ 6.7 × 10¹² wei (6.7 % of price) |
| Gas break-even | actual cost = price | base fee ≈ 2.7 gwei |
| Auto-pause point (defaults) | worst case 40.5k × (1.5·base + tip) > 7.5 × 10¹³ | base fee ≈ 1.2 gwei |
| DeepSeek `deepseek-flash` call | ~400 in / ~90 out tokens, $0.30 / $1.20 per M (peak) | ≈ $0.0002 (half off-peak) |
| **Revenue per order** | 0.0001 ETH | **≈ $0.30** |

So at today's fees one order nets roughly 0.000096 ETH. Error responses to invalid paid requests
cost the same gas as a delivery and are covered by the payment.

## Fixed / monthly

| Item | Estimate | Notes |
|---|---|---|
| Railway Hobby | ≈ $5 / month | Plan minimum including usage credit; this worker uses a fraction of a vCPU and < 150 MB RAM, plus a 1 GB volume. Verify current Railway pricing. |
| RPC | $0 on free tiers | ≈ 36k requests/day (7,200 full blocks + heads + receipts). Fits free tiers of keyed providers; full blocks are ~1–1.5 GB/day of *inbound* data |
| DeepSeek | ≈ $0.10 / month at 500 orders | prepaid balance; cap with `LLM_DAILY_CALL_LIMIT` |
| GitHub | $0 | public repo + Actions minutes |
| Dashboard hosting | $0 | served by the worker or GitHub Pages |

## One-time (launch)

| Item | Estimate |
|---|---|
| ENS app: ETH address + `com.zerohuman.services` (≈540-byte JSON), one transaction | ≈ 350k–450k gas ≈ 0.00004–0.00008 ETH at 0.1–0.17 gwei (storage-dominated) |
| Seller primary name (`setName`, seller wallet) | 114,042 gas (measured on a mainnet fork) ≈ 0.00001 ETH at 0.1 gwei |
| Seller gas float | 0.003–0.005 ETH covers ~1,000 deliveries at today's fees |
| Test-buyer funds | 0.002 ETH covers ~10 test orders + gas |
| Sepolia | free (faucet) |

## Daily ceilings with defaults

- Gas: ≤ 0.002 ETH per rolling 24 h (`DAILY_GAS_BUDGET_WEI`).
- Orders: ≤ 300 per 24 h (`MAX_ORDERS_PER_DAY`).
- Model calls: ≤ 500 per UTC day (`LLM_DAILY_CALL_LIMIT`); beyond that, fallback text is delivered.
