# Mainnet launch checklist

Every item marked **[YOU]** needs the operator. Nothing here has been done yet: no wallet funded,
no ENS record written, no Railway service deployed, no mainnet transaction sent.

## A. Accounts and secrets

- [ ] **[YOU]** 2FA on GitHub, Railway, DeepSeek, and the wallet holding `zerohuman.eth`.
- [ ] **[YOU]** Create a DeepSeek API key dedicated to ZeroHuman; set a low prepaid balance (e.g. $5).
- [ ] **[YOU]** Create a keyed mainnet RPC (Alchemy/Infura/QuickNode) and a Sepolia RPC.
- [ ] **[YOU]** Generate fresh wallets on your own machine (`npm run keygen`, see DEPLOYMENT.md §1):
      mainnet seller, mainnet test buyer, Sepolia seller, Sepolia buyer. Decide the cold sweep address.

## B. Sepolia validation (Stage 2, live)

- [ ] **[YOU]** Fund the two Sepolia wallets with ~0.01 Sepolia ETH each (faucet).
- [ ] Run `SELLER_KEY_FILE=… BUYER_KEY_FILE=… DEEPSEEK_API_KEY=… npm run testnet-e2e` — expect both services
      `verified: true` with Sepolia Etherscan links.
- [ ] Deploy the Railway service with `CHAIN_ID=11155111`, the Sepolia keys, `BUYER_ALLOWLIST=<sepolia buyer>`.
- [ ] Place both order types with `zh-buyer` against the Railway worker; redeploy mid-order; confirm one delivery each.
- [ ] Send a wrong-amount payment; confirm `zh-admin review` shows it; approve the refund; confirm it arrives.
- [ ] Temporarily set `MAX_FEE_PER_GAS_GWEI=0.000001`; confirm the `gas` pause appears on `/api/status`; restore.

## C. Mainnet deployment (allowlist phase)

- [ ] **[YOU]** Approve moving to mainnet.
- [ ] **[YOU]** Fund the seller hot wallet with a small gas float only (≤ 0.005 ETH).
- [ ] **[YOU]** Fund the test buyer with ~0.002 ETH.
- [ ] Switch Railway variables: `CHAIN_ID=1`, mainnet `RPC_URL` (keyed + fallback), mainnet `SELLER_PRIVATE_KEY`,
      `START_BLOCK=<current block>`, `CONFIRMATIONS=6`, `BUYER_ALLOWLIST=<test buyer>`, `DEEPSEEK_API_KEY`,
      `SWEEP_TO_ADDRESS` (strongly recommended: anything sent to zerohuman.eth lands in the hot wallet). **Use a fresh volume or a new `DATABASE_PATH`** (never reuse the Sepolia DB).
- [ ] Confirm `/health` is 200 and `/api/status` shows `mode: allowlist`, `chainId: 1`, the expected `seller`.

## D. Make zerohuman.eth the seller (requires your approval and signatures) — see ENS-SETUP.md

- [ ] Worker is running on mainnet and shows the `ens` pause ("… resolves to 0xa5D2…, not this seller"). Expected.
- [ ] `SELLER_ADDRESS=0x<seller> RPC_URL=<mainnet> npm run ens -- plan` → copy the target values.
- [ ] **[YOU]** Confirm nothing still relies on the old address `0xa5D2…26Ce` receiving ETH via the name.
- [ ] **[YOU]** ENS app, signed by the name owner (cold wallet): set **ETH address = seller** and add text
      **`com.zerohuman.services` = catalog value**. Leave the other records alone.
- [ ] **[YOU]** Approve the seller wallet's primary-name transaction (~0.00001 ETH):
      `… npm run ens -- primary-name --send` with `CONFIRM_SEND=zerohuman.eth`.
- [ ] `RPC_URL=<mainnet> npm run ens -- check` → `ok: true`, `primaryNameMatches: true`.
- [ ] Within 10 min `/api/status` shows `identity.ok: true` and the `ens` pause has cleared.

## E. First real orders (allowlisted)

- [ ] `zh-buyer decision "a" "b" "c"` from the test buyer → `verified: true`.
- [ ] `zh-buyer encourage "…"` → `verified: true`, `gen: "llm"`.
- [ ] Check both on Etherscan; check `/api/status` gas spend; check logs contain no secrets.
- [ ] Let it run 48 h with the test buyer only. Review `zh-admin events`.

## F. Opening to independent buyers (requires your explicit approval)

- [ ] **[YOU]** Approve public access.
- [ ] Set `PUBLIC_BUYERS=I_APPROVE_PUBLIC_BUYERS`; redeploy.
- [ ] **[YOU]** Update the ENS catalog `status` to `live` (re-run `catalog print` with `CATALOG_STATUS=live`).
- [ ] Announce the name `zerohuman.eth` + this repository so agents can find it (custom text records are not indexed).
- [ ] Weekly: `zh-admin review`, sweep check, DeepSeek balance, gas spend.

