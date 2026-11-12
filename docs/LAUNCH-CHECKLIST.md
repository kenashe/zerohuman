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
      optional `SWEEP_TO_ADDRESS`. **Use a fresh volume or a new `DATABASE_PATH`** (never reuse the Sepolia DB).
- [ ] Confirm `/health` is 200 and `/api/status` shows `mode: allowlist`, `chainId: 1`, the expected `seller`.

## D. ENS catalog (requires your approval and signature)

- [ ] Generate the value: `SELLER_ADDRESS=0x<seller> CHAIN_ID=1 CATALOG_STATUS=allowlist npm run catalog -- print`.
- [ ] **[YOU]** In the ENS app, on `zerohuman.eth`, **add** a text record `com.zerohuman.services` with that one-line value.
      Do **not** change the ETH address record (`0xa5D2…26Ce` today) or any other existing record.
- [ ] Verify: `RPC_URL=<mainnet> npm run catalog -- check` → `present: true, valid: true`.

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

## G. Only after everything above

- [ ] **[YOU]** Decide whether to change `zerohuman.eth`'s ETH address record. ZeroHuman does not need it
      (buyers use the catalog `seller` field); leaving it unchanged is fine.
