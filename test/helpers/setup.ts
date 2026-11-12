import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeRequest } from '../../src/protocol/codec.js';
import { PRICE_WEI } from '../../src/protocol/constants.js';
import type { ZhRequest } from '../../src/protocol/schemas.js';
import { LocalSigner } from '../../src/seller/chain.js';
import { loadConfig, type SellerConfig } from '../../src/seller/config.js';
import { Engine, type FaultPoint } from '../../src/seller/engine.js';
import { setLogSink } from '../../src/seller/log.js';
import { Store } from '../../src/seller/store.js';
import type { TextProvider } from '../../src/services/llm/provider.js';
import { MockProvider } from '../../src/services/llm/mock.js';
import { MockChain } from './mockchain.js';

export const logs: string[] = [];
setLogSink((l) => logs.push(l));

export function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'zh-')), 'state.db');
}

export interface Harness {
  chain: MockChain;
  cfg: SellerConfig;
  sellerKey: Hex;
  seller: Address;
  buyer: Address;
  dbPath: string;
  store: Store;
  engine: Engine;
  provider: TextProvider | null;
  clock: { t: number };
  /** Build a fresh Engine on the same DB (simulates a process restart). */
  restart(opts?: { faultHook?: (p: FaultPoint) => void; instanceId?: string }): Engine;
  order(req: ZhRequest | Hex, opts?: { from?: Address; value?: bigint; chainId?: number | undefined }): Hex;
  /** Run ticks, mining a block between each, until predicate or limit. */
  run(ticks: number, until?: () => boolean): Promise<void>;
}

export function harness(overrides: Record<string, string> = {}, provider: TextProvider | null = new MockProvider()): Harness {
  const chain = new MockChain();
  const sellerKey = generatePrivateKey();
  const seller = privateKeyToAccount(sellerKey).address;
  const buyer = privateKeyToAccount(generatePrivateKey()).address;
  const dbPath = tmpDb();
  chain.fund(seller, 10n ** 17n);
  chain.fund(buyer, 10n ** 18n);
  const cfg = loadConfig({
    CHAIN_ID: '31337',
    RPC_URL: 'http://mock',
    SELLER_PRIVATE_KEY: sellerKey,
    DATABASE_PATH: dbPath,
    CONFIRMATIONS: '2',
    START_BLOCK: '1',
    BUYER_ALLOWLIST: buyer,
    LLM_PROVIDER: 'mock',
    MAX_FEE_PER_GAS_GWEI: '3',
    MAX_PRIORITY_FEE_GWEI: '0.05',
    STUCK_AFTER_MS: '60000',
    INSTANCE_ID: 'test-a',
    ...overrides,
  });
  const clock = { t: 1_800_000_000_000 };
  const now = () => clock.t;
  const store = new Store(dbPath);
  const mk = (faultHook?: (p: FaultPoint) => void, instanceId?: string) =>
    new Engine({ cfg: instanceId ? { ...cfg, instanceId } : cfg, store: h.store, chain, signer: new LocalSigner(sellerKey), provider, now, faultHook });
  const h: Harness = {
    chain,
    cfg,
    sellerKey,
    seller,
    buyer,
    dbPath,
    store,
    engine: null as unknown as Engine,
    provider,
    clock,
    restart(opts = {}) {
      h.store.close();
      h.store = new Store(dbPath);
      // A restarted process gets a new instance id; the old lease must expire first,
      // except when the test passes the same id (same Railway deployment restarting).
      h.engine = mk(opts.faultHook, opts.instanceId ?? cfg.instanceId);
      return h.engine;
    },
    order(req, o = {}) {
      const input = typeof req === 'string' ? req : encodeRequest(req);
      return chain.inject({ from: o.from ?? buyer, to: seller, value: o.value ?? PRICE_WEI, input, ...('chainId' in o ? { chainId: o.chainId } : {}) });
    },
    async run(ticks, until) {
      for (let i = 0; i < ticks; i++) {
        await h.engine.tick();
        if (until?.()) return;
        chain.mine();
        clock.t += 12_000;
      }
    },
  };
  h.engine = mk();
  return h;
}
