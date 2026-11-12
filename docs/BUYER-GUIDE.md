# Buyer guide

You do not need ZeroHuman's servers, dashboard, or an account. You need an Ethereum wallet with a
little ETH and an RPC endpoint.

## Option A — TypeScript SDK

```bash
npm install github:kenashe/zerohuman viem
```

```ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { ZeroHumanBuyer, decisionRequest, encouragementRequest } from 'zerohuman';

const publicClient = createPublicClient({ chain: mainnet, transport: http(process.env.RPC_URL) });
const walletClient = createWalletClient({ account: privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`), chain: mainnet, transport: http(process.env.RPC_URL) });
const zh = new ZeroHumanBuyer({ publicClient, walletClient });

const catalog = await zh.getCatalog();            // reads com.zerohuman.services from zerohuman.eth

// Decision: pay, wait, receive, verify — one call.
const d = await zh.order(decisionRequest(['retry now', 'back off 30s', 'escalate'], 'rate limited'));
console.log(d.delivery.response, d.verification.valid);

// Encouragement, step by step.
const orderTx = await zh.submit(encouragementRequest('My scraper hits CAPTCHAs after 50 pages', 'playful'));
await zh.waitForConfirmation(orderTx);
const delivery = await zh.waitForDelivery(orderTx);
const check = await zh.verify(delivery);          // uses only your RPC
```

`verifyDelivery(publicClient, delivery, sellerAddress)` and `computeDecision(...)` are exported for
independent verifiers.

## Option B — CLI

```bash
export RPC_URL=https://…mainnet…   BUYER_PRIVATE_KEY=0x…
npx zh-buyer catalog
npx zh-buyer decision "ship it" "add tests first" "ask a human" --context "friday deploy"
npx zh-buyer encourage "my tool call returned malformed JSON three times" --tone playful
npx zh-buyer verify 0x<orderTxHash>
DRY_RUN=1 npx zh-buyer decision "a" "b"      # print the exact transaction instead of sending
```

Real output (local devnet):

```json
{
  "orderTxHash": "0x9e2eec55a8f51e0f01feafda3f4b06066870c2aae0407ad06e71f92d335f02b8",
  "deliveryTxHash": "0x5ed75ee72dfaaf465356d10b4c4b5efe25cc9b12f29cb048ca0fac90ea5c6867",
  "response": {
    "zh": 1, "re": "0x9e2eec55a8f51e0f01feafda3f4b06066870c2aae0407ad06e71f92d335f02b8", "ok": true, "svc": "decision",
    "out": { "index": 2, "option": "ask a human", "method": "zh-blockhash-v1",
      "proof": { "orderBlock": 7, "offset": 5, "targetBlock": 12,
        "targetBlockHash": "0xcbee139c2683a03da6280e0517e53665cb0fb1a8c98f0446cc09d4c1e7f87cda",
        "seed": "0x1a51209512977c425e2389c541a81932b4c046233c4a5b4da74b9e2a63f2bc3b", "n": 3 } }
  },
  "verified": true,
  "problems": []
}
```

## Option C — no ZeroHuman code at all (foundry `cast` + any ENS client)

```bash
# 1. Catalog: any Universal-Resolver (ENSv2-ready) client works. With viem:
CAT=$(node -e "const {createPublicClient,http}=require('viem');const {mainnet}=require('viem/chains');createPublicClient({chain:mainnet,transport:http(process.env.RPC)}).getEnsText({name:'zerohuman.eth',key:'com.zerohuman.services'}).then(console.log)")
SELLER=$(echo "$CAT" | jq -r .seller)
REQ='{"zh":1,"svc":"decision","opts":["left","right"]}'
# 2. Pay + order in one transaction (data = UTF-8 bytes of the JSON):
ORDER=$(cast send $SELLER --value 100000000000000 $(cast from-utf8 "$REQ") \
        --private-key $KEY --rpc-url $RPC --json | jq -r .transactionHash)
# 3. Watch blocks for a tx from $SELLER to you whose input decodes (cast to-utf8) to JSON with "re" == $ORDER
```

## Rules of thumb for agents

- Read the catalog every time you start; refuse if `chainId`, `seller` format, or `price` look wrong.
- Only send from an EOA (or a 7702-delegated EOA that accepts zero-value calls cheaply). The order
  must be a top-level transaction to the seller.
- Requests are public forever. No secrets, keys, personal data, or confidential task details.
- Allow up to `sla.maxSeconds` for delivery. If the catalog says `allowlist`, unknown buyers are
  not served — your payment is held for a refund review.
- Decisions are for low-stakes tie-breaking only. See [DECISION-ALGORITHM.md](DECISION-ALGORITHM.md).
