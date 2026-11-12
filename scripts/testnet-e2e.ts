/**
 * Live Sepolia end-to-end run (Stage 2 "Sepolia" validation).
 *
 * Runs a real seller engine in-process against Sepolia and a real buyer via the public SDK,
 * for BOTH services, then verifies everything from the chain. Uses two NEW test-only wallets.
 *
 *   npm run keygen -- --label sepolia-seller --out ./wallets/sepolia-seller.key
 *   npm run keygen -- --label sepolia-buyer  --out ./wallets/sepolia-buyer.key
 *   # fund both addresses with ~0.01 Sepolia ETH from a faucet, then:
 *   SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
 *   SELLER_KEY_FILE=./wallets/sepolia-seller.key BUYER_KEY_FILE=./wallets/sepolia-buyer.key \
 *   [DEEPSEEK_API_KEY=sk-...] npx tsx scripts/testnet-e2e.ts
 *
 * Without DEEPSEEK_API_KEY, Encouragement uses the deterministic fallback (gen:"fallback").
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { buildCatalog } from '../src/protocol/catalog.js';
import { LocalSigner, ViemChain } from '../src/seller/chain.js';
import { loadConfig } from '../src/seller/config.js';
import { Engine } from '../src/seller/engine.js';
import { Store } from '../src/seller/store.js';
import { DeepSeekProvider } from '../src/services/llm/deepseek.js';
import { decisionRequest, encouragementRequest, ZeroHumanBuyer } from '../src/sdk/index.js';

const rpc = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const sk = readFileSync(process.env.SELLER_KEY_FILE ?? './wallets/sepolia-seller.key', 'utf8').trim() as Hex;
const bk = readFileSync(process.env.BUYER_KEY_FILE ?? './wallets/sepolia-buyer.key', 'utf8').trim() as Hex;
const buyer = privateKeyToAccount(bk);
const pc = createPublicClient({ chain: sepolia, transport: http(rpc) }) as PublicClient;
const head = await pc.getBlockNumber();
const cfg = loadConfig({
  CHAIN_ID: '11155111', RPC_URL: rpc, SELLER_PRIVATE_KEY: sk, DATABASE_PATH: process.env.DATABASE_PATH ?? './data/sepolia.db', CONFIRMATIONS: '2',
  START_BLOCK: process.env.START_BLOCK ?? String(head), BUYER_ALLOWLIST: buyer.address, LLM_PROVIDER: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'none',
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, MAX_FEE_PER_GAS_GWEI: process.env.MAX_FEE_PER_GAS_GWEI ?? '50', MAX_DELIVERY_COST_WEI: '2000000000000000', INSTANCE_ID: 'sepolia-e2e', POLL_INTERVAL_MS: '4000',
});
const store = new Store(cfg.databasePath);
const engine = new Engine({ cfg, store, chain: new ViemChain(cfg.rpcUrls, cfg.chainId), signer: new LocalSigner(sk), provider: cfg.llm.apiKey ? new DeepSeekProvider({ apiKey: cfg.llm.apiKey }) : null });
let stop = false;
(async () => { while (!stop) { const r = await engine.tick(); if (r.errors.length || r.sent || r.prepared) console.error('tick', JSON.stringify(r, (_k, v) => typeof v === 'bigint' ? v.toString() : v)); await new Promise((x) => setTimeout(x, cfg.pollIntervalMs)); } })();

const zh = new ZeroHumanBuyer({ publicClient: pc, walletClient: createWalletClient({ account: buyer, chain: sepolia, transport: http(rpc) }), catalog: buildCatalog({ seller: engine.seller, chainId: 11155111, status: 'allowlist', confirmations: 2 }) });
const results: unknown[] = [];
for (const req of [decisionRequest(['deploy', 'wait', 'rollback'], 'sepolia e2e'), encouragementRequest('Sepolia test: my RPC keeps rate-limiting me', 'playful')]) {
  const t0 = Date.now();
  const r = await zh.order(req, { pollMs: 4000, timeoutMs: 900_000 });
  const rc = await pc.getTransactionReceipt({ hash: r.delivery.deliveryTxHash });
  results.push({ service: req.svc, order: `https://sepolia.etherscan.io/tx/${r.orderTxHash}`, delivery: `https://sepolia.etherscan.io/tx/${r.delivery.deliveryTxHash}`, verified: r.verification.valid, problems: r.verification.problems, gasUsed: rc.gasUsed.toString(), seconds: (Date.now() - t0) / 1000, response: r.delivery.response });
}
stop = true;
console.log(JSON.stringify({ seller: engine.seller, buyer: buyer.address, results, status: engine.status() }, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
process.exit(0);
