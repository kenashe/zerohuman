/**
 * Read-only mainnet shadow scan: runs the real watcher + classifier over recent mainnet
 * blocks, pretending to be a seller at SHADOW_SELLER (default: a busy public address), and
 * reports what it would have recorded. Never signs or sends anything (no key is loaded;
 * a throwaway signer is used and the send step is never invoked).
 *
 *   RPC_URL=https://ethereum-rpc.publicnode.com BLOCKS=20 npx tsx scripts/shadow-scan.ts
 */
import { generatePrivateKey } from 'viem/accounts';
import { ViemChain } from '../src/seller/chain.js';
import { loadConfig } from '../src/seller/config.js';
import { Engine } from '../src/seller/engine.js';
import { setLogSink } from '../src/seller/log.js';
import { Store } from '../src/seller/store.js';
import type { Signer } from '../src/seller/chain.js';

setLogSink(() => {});
const rpc = process.env.RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const target = (process.env.SHADOW_SELLER ?? '0xdAC17F958D2ee523a2206206994597C13D831ec7') as `0x${string}`; // USDT: many inbound txs
const blocks = Number(process.env.BLOCKS ?? 20);
const chain = new ViemChain([rpc], 1);
const head = await chain.getBlockNumber();
const cfg = loadConfig({ RPC_URL: rpc, SELLER_PRIVATE_KEY: generatePrivateKey(), DEEPSEEK_API_KEY: 'unused-shadow', DATABASE_PATH: ':memory:', START_BLOCK: String(head - 6n - BigInt(blocks)), MAX_BLOCKS_PER_TICK: String(blocks), INSTANCE_ID: 'shadow' });
const signer: Signer = { address: target, sign: async () => { throw new Error('shadow mode never signs'); } };
const store = new Store(':memory:');
const engine = new Engine({ cfg, store, chain, signer, provider: null });
const t0 = Date.now();
const r = await engine.scan();
await engine.classifyDetected();
const types = new Map<string, number>();
for (let n = head - 6n - BigInt(blocks); n <= r.to!; n++) {
  const b = await chain.client.getBlock({ blockNumber: n, includeTransactions: true });
  for (const t of b.transactions) types.set(t.type, (types.get(t.type) ?? 0) + 1);
}
console.log(JSON.stringify({ head: head.toString(), scannedTo: r.to?.toString(), blocks, seconds: (Date.now() - t0) / 1000, inboundTxsRecorded: r.added, classification: store.stateCounts(), reasons: store.db.prepare('SELECT reason, COUNT(*) c FROM orders GROUP BY reason').all(), txTypesSeen: Object.fromEntries(types) }, null, 2));
