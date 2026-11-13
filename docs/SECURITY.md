# Security review

Scope: ZeroHuman v1.0 seller, buyer SDK, dashboard. Date: 2026-11-11. Reviewer: build author
(self-review — an independent review is recommended before public launch).

## Assets and trust boundaries

| Asset | Where | Exposure |
|---|---|---|
| Seller hot-wallet key | Railway secret → process memory (`LocalSigner` private field) | Anyone who compromises the Railway service, project, or account |
| Seller ETH balance | Ethereum | Bounded by keeping the wallet low-value + optional auto-sweep |
| DeepSeek API key | Railway secret | Billing abuse up to the DeepSeek account balance |
| Order database | Railway volume | Integrity matters for exactly-once delivery; contents are public chain data |

Untrusted inputs: every byte of every transaction sent to the seller; every DeepSeek response;
RPC responses (partially — see risks).

## Controls implemented

**Keys and secrets**
- New dedicated seller key generated with `npm run keygen` (CSPRNG, file mode 0600, never printed by default). No key, wallet, catalog, or state from the previous experiment is used.
- Keys are only read from environment variables, removed from `process.env` immediately after load, and held only inside the signer. Config's copy is overwritten.
- Logger scrubs registered secrets and secret-named fields; tests assert the key never appears in logs (also verified on a real run: 0 occurrences).
- `.gitignore`/`.dockerignore` exclude `.env*`, `wallets/`, `data/`.

**Money movement**
- The seller only ever sends three kinds of transaction, each checked by a pre-sign invariant: delivery (value **0**, to the order's sender, data references the order), refund (to the order's sender, value **exactly** what they paid, operator-approved), sweep (only to `SWEEP_TO_ADDRESS` from config). Any mismatch → item to review + manual operator pause. Tested by tampering the DB row directly.
- Gas ceilings: `MAX_FEE_PER_GAS_GWEI`, per-delivery worst-case cost cap, `DELIVERY_GAS_LIMIT_CAP`, rolling 24 h gas budget, order cap per day, balance floor. All pause automatically; gas/budget/balance resume automatically.
- One transaction in flight; nonce = confirmed nonce; refuses to sign if any unknown pending tx exists from the seller address; raises a manual `nonce` pause if a nonce is consumed by an unknown transaction (a strong signal of key compromise).
- Gas estimation runs before every signature; recipients needing more than the gas cap (contracts / 7702-delegated EOAs that execute code on receipt) are sent to review rather than paid for.

**Untrusted buyer input**
- Hard byte limit before parsing (768 B), strict UTF-8 decoding, JSON object only, strict schemas with no unknown keys, canonical-string rule (no control/bidi/zero-width characters), bounded arrays.
- Zero-value spam is bulk-ignored without RPC calls so it cannot delay paid orders or flood the review queue.
- Allowlist mode by default; public mode requires the exact env value `PUBLIC_BUYERS=I_APPROVE_PUBLIC_BUYERS`.

**Prompt injection / model output**
- The model has no tools, functions, shell, wallet, or RPC. It receives a system prompt and the obstacle text wrapped in `<obstacle>` tags (angle brackets stripped from buyer text).
- Output is parsed as JSON, canonicalised, length-clipped, and rejected (→ deterministic fallback) if it contains URLs, domains, long hex/addresses, code fences, or fund/secret/command language.
- Recipient and value are never derived from model output; they come from the on-chain order and are re-checked by the invariant guard. Tested with a malicious model that instructs a transfer to an attacker: the delivery went to the buyer with value 0 and the fallback text.
- Per-day model call limit; 15 s timeout; `max_tokens` 220; thinking mode disabled.

**Availability and integrity**
- Durable cursor, idempotent inserts, unique outbox rows, write-ahead signing, reconcile-before-act, chain-observed delivery adoption after database loss. Verified by unit crash points and by `kill -9` of the real process at random times on a real EVM (6 orders, 7 kills, exactly one delivery each).
- RPC chain id must match config or the worker pauses. Multiple RPC URLs supported (viem `fallback`).

**Public surface**
- HTTP server is GET/HEAD only, fixed routes, no query handling, no body parsing, request/header timeouts, `nosniff`, `no-referrer`, strict CSP on the dashboard. Nothing reachable from it can sign.
- Dashboard renders all buyer-supplied text with `textContent` (no HTML injection). Proof verification in the dashboard uses the visitor's chosen RPC, not ZeroHuman's API.

**Identity**
- `zerohuman.eth`'s ETH address is the seller wallet. The worker signs nothing unless `addr(zerohuman.eth)` equals its own address and the catalog agrees (checked at start and every 10 min). Buyers refuse to pay when the address and catalog disagree, and accept deliveries only from the address they paid.
- The name is owned by a separate cold wallet, so a server compromise cannot take the name; recovery is one record change.

## Remaining risks (accepted for v1, ranked)

1. **Hot-wallet compromise.** The hot wallet is now *the* address behind `zerohuman.eth`, so all ETH sent to the name accumulates there until swept. Anyone who gets shell or env access to the Railway service, or the
   Railway/GitHub account, can take the key. *Mitigations:* keep the balance tiny (≤ ~0.01 ETH of gas
   float), enable auto-sweep to a cold wallet, 2FA on Railway/GitHub/DeepSeek, restrict project members.
   A remote signer/KMS is the v2 fix.
2. **Selective non-delivery / seller honesty.** There is no escrow. A seller (or a compromised one)
   can take payment and not deliver. Buyers risk 0.0001 ETH per order. Documented.
3. **Decision randomness is proposer-influenceable** (see DECISION-ALGORITHM.md). Low-stakes only.
4. **Single RPC trust.** A malicious RPC could hide orders (denial of service) or feed a fake block
   hash (wrong decision proof — which buyers would detect with their own RPC). Use reputable
   providers and configure a fallback; buyers must verify with an independent RPC.
5. **Volume loss.** Mitigated: the watcher also reads the seller's own outgoing transactions, and
   fulfilment is held until the scan has caught up with the chain head. A rebuilt database adopts
   past deliveries from the chain instead of re-delivering (tested). Residual risk: refunds and
   sweeps carry no order reference and would not be recognised, so after a restore an operator
   must re-check refund status before approving any refund again; and orders older than
   `START_BLOCK` are invisible, so never move `START_BLOCK` forward past unfulfilled orders.
6. **DeepSeek availability/content.** The model could be down (fallback used) or produce unhelpful but
   "safe" text. Sanitiser is deny-list based; it cannot guarantee tone quality.
7. **Gas griefing within the price.** Every correctly paid invalid request costs the seller one error
   delivery (~35k gas), covered by the 0.0001 ETH payment at normal gas prices; the cost cap pauses
   fulfilment when this stops being true.
8. **Reorg after delivery.** Deliveries are treated as final after 1 confirmation; a deep reorg could
   drop one. The signed raw transaction remains in the DB and is re-broadcast if its receipt
   disappears only while the item is in flight — a post-finalisation reorg is out of scope.
9. **Supply chain.** Dependencies are pinned (`viem` 2.57.18, `zod` 4.6.7) with a lockfile; no
   automated dependency scanning yet.

## Operator responsibilities

Rotate the key if anything above is suspected (`npm run keygen`, update the Railway secret, update
the ENS catalog `seller`, sweep the old wallet). Review `zh-admin review` regularly. Never run the
seller on a machine that also holds personal keys.
