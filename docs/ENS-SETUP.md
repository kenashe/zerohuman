# zerohuman.eth as ZeroHuman's identity

**The name is the service.** Agents pay `zerohuman.eth`, and `zerohuman.eth` delivers. Concretely:

| Record on `zerohuman.eth` | Value | Effect |
|---|---|---|
| ETH address (`addr`, coin type 60) | the seller hot wallet | Sending ETH "to zerohuman.eth" from any wallet or agent pays ZeroHuman |
| Text `com.zerohuman.services` | the catalog JSON (its `seller` equals the ETH address) | Agents learn services, prices, and rules |
| *Seller wallet's* primary name (reverse record) | `zerohuman.eth` | Explorers and wallets show orders going **to** and deliveries coming **from** `zerohuman.eth` |

How each side enforces it:

- **Buyers (SDK / CLI):** `resolveIdentity()` resolves `addr(zerohuman.eth)` and the catalog, and refuses to pay if
  they disagree. It re-resolves the name immediately before paying, pays that address, and accepts deliveries only from
  the address the order was paid to.
- **Seller worker:** on mainnet it checks every 10 minutes (and at start-up) that `addr(zerohuman.eth)` is its own
  wallet, the catalog `seller` matches, and the catalog `chainId` matches. Until that is verified, or if it ever stops
  being true, it raises an `ens` pause and **signs nothing**. Paid orders wait and are fulfilled once it's fixed.

## Who holds what

```
  cold wallet (hardware) ── owns / manages zerohuman.eth ── can change any record, can't be drained by the server
          │
          └─ sets ETH address ──►  seller hot wallet (key on Railway)  ── receives orders, sends deliveries
                                        │
                                        └─ sets its own primary name = zerohuman.eth
```

Keep the **name owner** and the **seller hot wallet** different. If the server is ever compromised, the attacker gets
the small hot-wallet balance, not the name. You then point the name at a new wallet in one record change.

`zerohuman.eth` has already been upgraded to ENSv2 (checked 2026-11-12: the v1 registry entry is held by the ENS
migration "Graveyard" contract and records are served by an ENSv2 resolver). Edit its records in the **ENS app**,
which handles ENSv2 roles. Don't use old v1 resolver scripts.

## Setup steps (after Sepolia testing and your approval)

1. **Generate the seller wallet** on your own machine: `npm run keygen -- --label seller --out ./wallets/seller.key`.
2. **Deploy the worker** with that key (DEPLOYMENT.md). With the default `ENS_CHECK=true` it starts in the `ens` pause,
   because the name still points elsewhere. That's expected.
3. **See exactly what to change:**
   `SELLER_ADDRESS=0x<seller> RPC_URL=<mainnet> npm run ens -- plan`
   It prints the current and target ETH address and the exact one-line catalog value.
4. **In the ENS app, signed by the name owner:** open `zerohuman.eth` → Records → edit:
   - set **ETH address** to the seller address;
   - add a text record with key `com.zerohuman.services` and the catalog value from step 3.
   Both can be saved in one transaction.
5. **Optional, recommended: set the primary name** so deliveries show "from zerohuman.eth". The seller wallet must sign
   this itself (one transaction, ~114k gas ≈ 0.00001 ETH at 0.1 gwei; rehearsed on a mainnet fork):
   `SELLER_ADDRESS=0x… RPC_URL=… SELLER_KEY_FILE=./wallets/seller.key CONFIRM_SEND=zerohuman.eth npm run ens -- primary-name --send`
6. **Verify like a buyer:** `RPC_URL=<mainnet> npm run ens -- check` → `ok: true, primaryNameMatches: true`.
   Within 10 minutes the worker's `/api/status` shows `identity.ok: true` and the `ens` pause clears.

## Consequences to accept

- **Any ETH sent to zerohuman.eth lands in the hot wallet**, including casual transfers and tips. Turn on
  `SWEEP_TO_ADDRESS` so balances above a small float move to cold storage automatically.
- **The old address `0xa5D2…26Ce` stops receiving** anything sent to the name. Make sure nothing still depends on it
  before you switch.
- **Key rotation means a record change.** New key → update the ETH address and the catalog `seller` together in the ENS
  app → set the new wallet's primary name. The worker on the old key pauses itself the moment the name moves.
- Wallets and explorers cache ENS lookups. After a change, verify with `npm run ens -- check`, not a block explorer.
