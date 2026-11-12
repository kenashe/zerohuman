# ZeroHuman protocol `zh/1`

Status: **v1.0 — stable wire format.** Any change to a value in this document requires `zh/2`.

ZeroHuman sells small services to autonomous AI agents. There is no marketplace, account,
API key, or ZeroHuman server in the buying path: an agent discovers the service through ENS,
pays with an ordinary Ethereum transaction that carries its request, and receives the result
in an ordinary Ethereum transaction from the seller.

> **Everything in this protocol is public.** Requests and responses are permanently visible
> on Ethereum. Never put secrets, credentials, personal data, or anything sensitive in a request.

---

## 1. Roles and constants

| Item | Value |
|---|---|
| Protocol id | `zh/1` (the number `1` in every payload as `"zh": 1`) |
| Chain | Ethereum mainnet, chain id `1` |
| Price (both services) | exactly `100000000000000` wei = 0.0001 ETH |
| Identity | **`zerohuman.eth`** — orders are paid to `addr(zerohuman.eth)`, deliveries come from it |
| Discovery | text record `com.zerohuman.services` on `zerohuman.eth` |
| Order id | the hash of the buyer's order transaction |
| Max request | 768 bytes of transaction input data |
| Max response | 1024 bytes of transaction input data |

## 2. Discovery (ENS)

Read the text record `com.zerohuman.services` on `zerohuman.eth` with any ENS client that
resolves through the **Universal Resolver** (ENSv2-ready). In TypeScript with viem:

```ts
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });
const raw = await client.getEnsText({ name: normalize('zerohuman.eth'), key: 'com.zerohuman.services' });
const catalog = JSON.parse(raw!);
```

Custom text records are **not** indexed or searchable by default. Agents find ZeroHuman by
being told the name (this repository, its docs, and any directory listings point to it), then
read the record. The record value is a single-line JSON document
([schema](../schemas/catalog.schema.json)):

```json
{"v":"zh/1","chainId":1,"seller":"0xSELLER…","services":{"decision":{"price":"100000000000000","offset":5,"method":"zh-blockhash-v1"},"encouragement":{"price":"100000000000000","tones":["supportive","playful"]}},"schema":"https://raw.githubusercontent.com/kenashe/zerohuman/main/schemas/zh1.schema.json","docs":"https://github.com/kenashe/zerohuman/blob/main/docs/PROTOCOL.md","status":"allowlist","sla":{"confirmations":6,"typicalSeconds":180,"maxSeconds":3600},"maxRequestBytes":768}
```

| Field | Meaning |
|---|---|
| `v` | protocol id, must be `zh/1` |
| `chainId` | settlement chain; buyers must refuse if their RPC reports a different chain |
| `name` | `zerohuman.eth` |
| `seller` | must equal `addr(zerohuman.eth)`: the only address orders go to and deliveries come from |
| `services.*.price` | price in wei as a decimal string; buyers must refuse if it differs from `100000000000000` |
| `status` | `live` (anyone), `allowlist` (only pre-approved buyers are fulfilled), `paused`, `retired` |
| `sla` | confirmations the seller waits, typical and maximum fulfilment time in seconds |
| `statusUrl` | optional read-only status API (convenience only; never required) |

**The ETH address record of `zerohuman.eth` is authoritative.** The catalog's `seller` field must equal
`addr(zerohuman.eth)`; buyers must refuse to pay if they differ. The SDK's `resolveIdentity()` does this. The
seller's primary name (reverse record) is `zerohuman.eth`, so explorers show deliveries from `zerohuman.eth`.
See [ENS-SETUP.md](ENS-SETUP.md).

## 3. Placing an order

Send one transaction:

| Field | Value |
|---|---|
| `to` | `zerohuman.eth` — i.e. `addr(zerohuman.eth)`, resolved immediately before sending (equals catalog `seller`) |
| `value` | exactly `100000000000000` |
| `data` | UTF-8 bytes of the request JSON (no ABI encoding, no selector) |
| `chainId` | `1` (EIP-155 replay protection is required; legacy unprotected txs are not fulfilled) |
| type | any EOA-originated type (legacy-155, 2930, 1559, 7702). The order must be a **top-level** transaction whose `to` is the seller: payments made via internal calls (smart-contract wallets, 4337 bundles) are not detected in v1 |

The response is sent to the transaction's `from` address. If that address runs code (EIP-7702
delegation or similar) and needs more than ~80,000 gas to receive a zero-value call, the order
is held for review instead of delivered.

### 3.1 Decision request

```json
{"zh":1,"svc":"decision","opts":["retry now","back off 30s","escalate"],"ctx":"rate limited"}
```

| Key | Required | Rule |
|---|---|---|
| `zh` | yes | `1` |
| `svc` | yes | `"decision"` |
| `opts` | yes | array of **2–5** unique strings, each 1–96 UTF-8 bytes |
| `ctx` | no | 1–160 bytes. Informational only — it never influences the selection |
| `ref` | no | 1–32 bytes, buyer's own correlation id, echoed nowhere (it's in your tx) |

### 3.2 Encouragement request

```json
{"zh":1,"svc":"encouragement","msg":"My scraper hits CAPTCHAs after 50 pages","tone":"supportive"}
```

| Key | Required | Rule |
|---|---|---|
| `zh` | yes | `1` |
| `svc` | yes | `"encouragement"` |
| `msg` | yes | 1–280 UTF-8 bytes describing the obstacle |
| `tone` | no | `"supportive"` (default) or `"playful"` |
| `ref` | no | as above |

### 3.3 String rules (all string fields)

Strings must already be **canonical**: NFC-normalised, no leading/trailing whitespace, and no C0/C1
control characters (including newlines and tabs), bidi overrides/isolates, zero-width characters,
or BOM. The seller **rejects** non-canonical strings rather than normalising them, so both sides
always agree on the exact bytes. Unknown keys are rejected. The SDK canonicalises for you.

## 4. Seller processing

1. The seller scans every block for top-level transactions to `seller`, waiting `sla.confirmations` blocks.
2. A transaction is an **order** only if: receipt status is success, `chainId` matches, `value` is
   exactly the price, `data` is non-empty, and (while `status` is `allowlist`) the sender is allowlisted.
3. Invalid payments are never answered automatically:

| Situation | Seller action |
|---|---|
| Zero value (with or without data) | ignored |
| Value > 0 with no data, ≠ price | ignored (treated as a transfer/tip) |
| Exactly the price, no data | held for review, refund-eligible |
| Wrong amount with data | held for review, refund-eligible |
| Missing/wrong chain id | held for review, refund-eligible |
| Sender not allowlisted (allowlist phase) | held for review, refund-eligible |

4. A correctly paid order with an **invalid request** (bad JSON, unknown service, bounds violated…)
   receives an **error response** on-chain (§5.3). It is not automatically refunded.
5. Each order is answered at most once. Orders are processed one at a time in block order.

## 5. Responses

The seller sends a **zero-value** transaction from `seller` to the order's `from`, whose `data` is
the UTF-8 JSON response. The delivery transaction hash is the hash of that transaction.
Every response carries `re` = the order transaction hash (lowercase).

### 5.1 Decision response (real example from the test suite)

```json
{"zh":1,"re":"0x0d68f194428f52d8e0e4a3e1d5b2a1ca57baaf13ca6ae02144af8f25e643b1eb","ok":true,"svc":"decision","out":{"index":0,"option":"retry now","method":"zh-blockhash-v1","proof":{"orderBlock":1,"offset":5,"targetBlock":6,"targetBlockHash":"0xabbab90ac65eed0c14eb39a4788b594aa41643acbfa9a5e83708e519d62c269d","seed":"0x3ab223758ad894f253ceec3d9fca911f2892727778d4e85120e4a9765c47c87c","n":3}}}
```

| Field | Meaning |
|---|---|
| `out.index` | zero-based index of the selected option in the request's `opts` |
| `out.option` | the selected option text, byte-identical to the request |
| `out.method` | `zh-blockhash-v1` |
| `out.proof.orderBlock` | block that included the order transaction |
| `out.proof.offset` | `5` |
| `out.proof.targetBlock` | `orderBlock + 5` |
| `out.proof.targetBlockHash` | hash of `targetBlock` |
| `out.proof.seed` | `keccak256(targetBlockHash ‖ orderTxHash)` |
| `out.proof.n` | number of options |

Selection: `index = uint256(seed) mod n`. See [DECISION-ALGORITHM.md](DECISION-ALGORITHM.md).

### 5.2 Encouragement response (real example)

```json
{"zh":1,"re":"0x7ea1fed50a66ca796390595bd0e36437687fb8d10aeb994efbb44fe3da7d224e","ok":true,"svc":"encouragement","out":{"message":"The bug has revealed its location. Bugs that reveal themselves are the polite kind.","nextStep":"Log the inputs right before the failure and compare them with what you expected.","tone":"playful","gen":"fallback"}}
```

| Field | Meaning |
|---|---|
| `out.message` | ≤ 240 characters |
| `out.nextStep` | one practical action, ≤ 200 characters |
| `out.tone` | tone used |
| `out.gen` | `llm` (generated by the model) or `fallback` (built-in text used when the model is unavailable, over budget, or produced unsafe output) |

### 5.3 Error response

```json
{"zh":1,"re":"0x…order…","ok":false,"svc":"decision","err":{"code":"invalid_input","msg":"opts: Too big: expected array to have <=5 items"}}
```

Codes: `bad_json`, `bad_version`, `unknown_service`, `invalid_input`, `too_large`, `internal`.

## 6. Buyer verification checklist

A buyer should accept a delivery only if, **using its own RPC**:

1. the order tx succeeded, was sent to `addr(zerohuman.eth)`, with value exactly the price;
2. the delivery tx succeeded, is from `addr(zerohuman.eth)` (the address the order paid), to the order's `from`, with value 0, in a later block;
3. the delivery data parses as a zh/1 response with `re` equal to the order hash;
4. for decisions: recomputing `keccak256(blockhash(orderBlock+5) ‖ orderTxHash) mod n` over
   the `opts` **read from the order transaction itself** gives `out.index`, and `out.option` equals `opts[out.index]`.

`verifyDelivery()` in the SDK performs all of these.

## 7. Timing and availability

- Encouragement: typically delivered within `confirmations + 2` blocks (~1.5–2 min on mainnet).
- Decision: cannot be delivered before `orderBlock + 5 + confirmations` (~2.5 min), by design.
- The seller pauses automatically when gas exceeds its ceilings or its daily gas budget is used up;
  paid orders wait in the queue and are fulfilled when it resumes. The catalog `sla.maxSeconds` is a
  target, not a guarantee.

## 8. Refunds

Best effort, operator-approved, no escrow. See [REFUNDS.md](REFUNDS.md).

## 9. Versioning

A future `zh/2` will use a new catalog record value (`"v":"zh/2"`) and `"zh": 2` payloads. A `zh/1`
seller answers `"zh": 2` requests with `bad_version`.
