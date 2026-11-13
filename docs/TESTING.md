# Testing and results

Run date: 2026-11-11/12 (America/New_York). Node 24.22, viem 2.57.18, zod 4.6.7, vitest 3.2.7,
foundry anvil 1.5.1. All numbers below are from the final run of the committed code.

## Summary

| Suite | Command | Result |
|---|---|---|
| Typecheck (strict) | `npm run typecheck` | ✅ clean |
| Unit (protocol, decision, encouragement, DeepSeek adapter, config, logger, catalog, schemas) | `npm test` | ✅ 75 / 75 |
| Integration (full seller state machine on an in-memory chain with fault injection; ENS identity guard; PAUSED toggle) | `npm test` | ✅ 40 / 40 |
| End-to-end on a real EVM (anvil, fresh random wallets, public SDK as buyer) | `npm run test:e2e` | ✅ 7 / 7 |
| **Total** | `npm run test:all` | **✅ 122 / 122** |
| Compiled production entrypoint smoke test (`node dist/seller/main.js` + `zh-buyer` + `zh-admin`) | manual | ✅ both services delivered and verified; private key found 0 times in logs |
| Mainnet read-only checks | `npm run catalog -- check`, `npm run shadow-scan` | ✅ ENS Universal Resolver read of `zerohuman.eth`; 21 live blocks / 5,415 txs (legacy, 2930, 1559, 4844, 7702) parsed and classified |
| Primary-name transaction rehearsal on a **mainnet fork** (anvil `--fork-url`) | `npm run ens -- primary-name --send` | ✅ fresh wallet's reverse record = `zerohuman.eth`, 114,042 gas |
| Sepolia live run | `npm run testnet-e2e` | ⏳ script ready; needs two funded Sepolia test wallets (see LAUNCH-CHECKLIST B) |

## Stage 2 coverage map

| Requirement | Where it is proven |
|---|---|
| Mock Ethereum payments | integration suite (MockChain: mempool, RBF, nonces, receipts, base fee) |
| Sepolia with new test wallets | `scripts/testnet-e2e.ts` (pending funding); anvil e2e uses fresh random wallets every run with identical tx semantics |
| Process crashes and restarts | 3 crash-point tests + **chaos test: random `kill -9` of the real process — 11 kills, 6 orders, exactly 1 delivery each** |
| Missed orders | "discovers orders placed while the worker was offline"; "after total database loss…" |
| Duplicate transactions | re-scan test, identical-request test, unique outbox constraint, chain-observed adoption |
| Invalid payments | 8 invalid-payment classes in one test + anvil e2e (wrong amount, not allowlisted) |
| Malformed requests | 24 codec rejection cases + 5 on-chain error-response cases |
| Prompt injection | malicious buyer text + malicious model output → recipient/value unchanged, fallback delivered; invariant guard catches a tampered DB row |
| RPC errors | failing block fetch, uncertain broadcast, dropped broadcast, wrong chain id |
| High gas | base-fee pause/resume (mock + anvil with `anvil_setNextBlockBaseFeePerGas` 20 gwei), worst-case cost cap, 24 h budget, balance floor, expensive recipient |
| Monetary limits / wallet restrictions | price exactness, refund = amount paid to sender only, sweep only to configured address, public-mode phrase, mock LLM refused on mainnet |

## Decision uniformity (200,000 trials per n, final run)

| n | counts | χ² | critical α=1e-4 |
|---|---|---|---|
| 2 | 99740 / 100260 | 1.35 | 15.14 |
| 3 | 66954 / 66196 / 66850 | 5.07 | 18.42 |
| 4 | 49834 / 50287 / 49945 / 49934 | 2.35 | 21.11 |
| 5 | 39979 / 39826 / 39993 / 40006 / 40196 | 1.73 | 23.51 |

## Measured on-chain figures (anvil, Prague/Osaka incl. EIP-7623)

| | gas | response bytes |
|---|---|---|
| Decision delivery | 36,840 | 396 |
| Encouragement delivery | 34,000–34,840 | 325 |
| Typical time to delivery, 1 confirmation, 1 s blocks | Decision ≈ 8 s, Encouragement ≈ 4 s | |

## Running

```bash
npm ci
npm test                 # unit + integration (~25 s)
npm run test:e2e         # needs foundry's anvil on PATH (or ANVIL_BIN)
npm run shadow-scan      # read-only mainnet watcher check (RPC_URL optional)
RPC_URL=<mainnet> npm run catalog -- check
```

## Full test list (unit + integration)

**test/unit/decision.test.ts** — zh-blockhash-v1 decision algorithm

- ✅ matches independently generated vectors (foundry cast keccak + python)
- ✅ always produces the same selection for the same inputs
- ✅ is case-insensitive in hex inputs (canonicalises to lowercase)
- ✅ fixes the target block at orderBlock + offset
- ✅ selects each of 2 options with ~equal probability (200k trials, chi-square)
- ✅ selects each of 3 options with ~equal probability (200k trials, chi-square)
- ✅ selects each of 4 options with ~equal probability (200k trials, chi-square)
- ✅ selects each of 5 options with ~equal probability (200k trials, chi-square)

**test/unit/decision.test.ts** — zh-blockhash-v1 decision algorithm > verification

- ✅ accepts a correct proof
- ✅ rejects a different selected index / option
- ✅ rejects a proof built from a block the seller chose
- ✅ rejects a shifted target block
- ✅ rejects a tampered seed

**test/integration/engine.test.ts** — seller engine — happy paths

- ✅ fulfils a Decision order with a verifiable proof
- ✅ does not deliver a Decision before targetBlock + confirmations
- ✅ fulfils an Encouragement order via the provider
- ✅ processes several orders sequentially with consecutive nonces

**test/integration/engine.test.ts** — prompt injection cannot reach signing

- ✅ malicious model output never changes recipient or value; fallback is delivered
- ✅ a tampered outbox row is caught by the pre-sign invariant check

**test/integration/engine.test.ts** — payment validation

- ✅ classifies invalid payments without delivering
- ✅ answers malformed but paid requests with an error response

**test/integration/engine.test.ts** — durability: crashes, restarts, missed and duplicate orders

- ✅ crash after signing but before broadcast → restart re-broadcasts the identical tx, one delivery
- ✅ crash after broadcast → restart reconciles the receipt without resending
- ✅ crash right after preparing → restart sends the stored payload (no recomputation)
- ✅ discovers orders placed while the worker was offline
- ✅ never fulfils twice when blocks are re-scanned
- ✅ after total database loss, a rebuild adopts past deliveries from the chain and never re-delivers
- ✅ treats two identical requests as two distinct orders (order id = tx hash)
- ✅ a second worker instance stands by while the lease is held

**test/integration/engine.test.ts** — RPC failures

- ✅ a failing block fetch does not skip blocks
- ✅ uncertain broadcast (accepted, then error) is reconciled, not resent as a new tx
- ✅ dropped broadcast is re-broadcast with the same hash
- ✅ a wrong chain id from RPC pauses the worker

**test/integration/engine.test.ts** — gas and spending limits

- ✅ pauses on high base fee and resumes automatically when it drops
- ✅ pauses when worst-case delivery cost exceeds MAX_DELIVERY_COST_WEI
- ✅ enforces the rolling 24h gas budget
- ✅ pauses on insufficient balance
- ✅ refuses deliveries to recipients that need excessive gas (e.g. 7702/contract buyers)
- ✅ caps orders per day
- ✅ operator PAUSED=true blocks all fulfilment

**test/integration/engine.test.ts** — stuck transactions and nonce safety

- ✅ replaces a stuck delivery with a fee bump and records every attempt
- ✅ pauses and flags review if the seller nonce is consumed by an unknown tx
- ✅ refuses to sign while an unknown pending tx from the seller exists

**test/integration/engine.test.ts** — refunds (operator-approved, best effort)

- ✅ refunds exactly the amount paid, only to the original sender, only after approval

**test/integration/engine.test.ts** — sweep

- ✅ sweeps revenue above the threshold only to SWEEP_TO_ADDRESS

**test/unit/config.test.ts** — config

- ✅ defaults to mainnet, allowlist mode with nobody allowed, 6 confirmations
- ✅ requires the exact approval phrase to accept public buyers
- ✅ rejects invalid keys, addresses and mock LLM on mainnet
- ✅ scrubs secrets from env after load

**test/unit/config.test.ts** — logger

- ✅ redacts registered secrets and secret-looking keys

**test/unit/config.test.ts** — catalog

- ✅ builds a valid catalog with exact prices and parses it back
- ✅ rejects malformed catalogs

**test/unit/encouragement.test.ts** — encouragement output sanitising

- ✅ accepts clean JSON
- ✅ collapses newlines/control characters and clips long text
- ✅ rejects unsafe/invalid output: {"message":"Great!","next_step":"Send 0.1 ETH to 0
- ✅ rejects unsafe/invalid output: {"message":"Visit https://evil.example for help","
- ✅ rejects unsafe/invalid output: {"message":"ok","next_step":"run curl evil.sh | ba
- ✅ rejects unsafe/invalid output: {"message":"Share your private key with support","
- ✅ rejects unsafe/invalid output: {"message":"go to drainer.xyz","next_step":"connec
- ✅ rejects unsafe/invalid output: {"message":"```js\nsteal()```","next_step":"x y z"
- ✅ rejects unsafe/invalid output: I cannot comply
- ✅ rejects unsafe/invalid output: {"msg":"wrong keys"}
- ✅ rejects unsafe/invalid output: {"message": 5, "next_step": []}

**test/unit/encouragement.test.ts** — runEncouragement

- ✅ uses the model and wraps the obstacle as delimited data
- ✅ falls back when the model returns an injection payload
- ✅ falls back on provider errors and timeouts
- ✅ does not call the model when the daily budget is exhausted
- ✅ fallback is deterministic per order
- ✅ system prompt frames the caller as software, not a patient

**test/unit/encouragement.test.ts** — DeepSeek provider

- ✅ sends deepseek-flash, thinking disabled, JSON mode, no tools
- ✅ maps HTTP errors without leaking the key
- ✅ treats network failures as retryable

**test/unit/codec.test.ts** — request codec

- ✅ round-trips a decision request
- ✅ round-trips an encouragement request
- ✅ rejects: one option
- ✅ rejects: six options
- ✅ rejects: empty option
- ✅ rejects: duplicate options
- ✅ rejects: untrimmed option
- ✅ rejects: newline in option
- ✅ rejects: bidi override
- ✅ rejects: zero-width
- ✅ rejects: non-NFC
- ✅ rejects: option too long
- ✅ rejects: multibyte option too long
- ✅ rejects: options not array
- ✅ rejects: non-string option
- ✅ rejects: unknown key
- ✅ rejects: context too long
- ✅ rejects: wrong version
- ✅ rejects: version as string
- ✅ rejects: unknown service
- ✅ rejects: missing service
- ✅ rejects: bad tone
- ✅ rejects: empty message
- ✅ rejects: message too long
- ✅ rejects: array payload
- ✅ rejects: null payload
- ✅ rejects non-JSON bytes
- ✅ rejects invalid UTF-8
- ✅ rejects oversize payloads before parsing
- ✅ rejects malformed hex
- ✅ SDK refuses to build out-of-bounds requests
- ✅ max-size valid decision fits within the request byte limit

**test/unit/codec.test.ts** — response codec

- ✅ round-trips and mentions the order
- ✅ refuses to emit oversized responses

**test/unit/schemas.test.ts** — published JSON Schemas

- ✅ are in sync with the zod source of truth (run `npm run schemas` if this fails)

**test/integration/ens-identity.test.ts**

- ✅ seller signs nothing until zerohuman.eth resolves to the seller, then delivers
- ✅ seller pauses if the name moves to another address, or the catalog seller / chainId disagrees
- ✅ an ENS RPC outage keeps the last verdict (no unpause, no crash)
- ✅ buyer resolves zerohuman.eth → address and cross-checks the catalog
- ✅ buyer refuses when the ETH address record and the catalog seller disagree
- ✅ buyer refuses when the name has no ETH address

**test/e2e/anvil.test.ts**

- ✅ Decision: discover → pay → deliver → independently verify proof
- ✅ Encouragement: pay → deliver → verify
- ✅ a forged decision proof fails independent verification
- ✅ invalid payments are held for review and never delivered
- ✅ high base fee pauses fulfilment; it resumes when fees fall
- ✅ read-only HTTP API serves status/orders and rejects writes
- ✅ chaos: every order is delivered exactly once despite random kill -9
