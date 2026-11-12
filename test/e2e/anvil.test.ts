/**
 * End-to-end on a real EVM (foundry anvil, Prague/Osaka rules incl. EIP-7623 calldata floor).
 * Fresh random wallets every run. The buyer uses only the public SDK + RPC.
 * Requires `anvil` on PATH (or ANVIL_BIN). Skipped automatically if unavailable.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, stringToHex, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../src/protocol/catalog.js';
import { PRICE_WEI } from '../../src/protocol/constants.js';
import { LocalSigner, ViemChain } from '../../src/seller/chain.js';
import { loadConfig } from '../../src/seller/config.js';
import { Engine } from '../../src/seller/engine.js';
import { startHttp } from '../../src/seller/http.js';
import { setLogSink } from '../../src/seller/log.js';
import { Store } from '../../src/seller/store.js';
import { MockProvider } from '../../src/services/llm/mock.js';
import { decisionRequest, encouragementRequest, findDelivery, verifyDelivery, ZeroHumanBuyer } from '../../src/sdk/index.js';
import { tmpDb } from '../helpers/setup.js';

const ANVIL = process.env.ANVIL_BIN ?? (existsSync('/agent/bin/anvil') ? '/agent/bin/anvil' : 'anvil');
const hasAnvil = spawnSync(ANVIL, ['--version']).status === 0;
const PORT = 18545;
const RPC = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
setLogSink(() => {});

export const results: Record<string, unknown> = {};

describe.skipIf(!hasAnvil)('e2e on anvil', () => {
  let anvil: ChildProcess;
  let pc: PublicClient;
  const sellerKey = generatePrivateKey();
  const buyerKey = generatePrivateKey();
  const seller = privateKeyToAccount(sellerKey).address;
  const buyerAcct = privateKeyToAccount(buyerKey);
  let engine: Engine;
  let store: Store;
  let loop: NodeJS.Timeout | null = null;
  let server: ReturnType<typeof startHttp>;

  const rpc = (method: string, params: unknown[]) =>
    fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());

  beforeAll(async () => {
    anvil = spawn(ANVIL, ['--port', String(PORT), '--block-time', '1', '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        await rpc('eth_blockNumber', []);
        break;
      } catch {
        await sleep(200);
      }
    }
    pc = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
    // Fund fresh wallets (anvil's equivalent of a faucet).
    await rpc('anvil_setBalance', [seller, '0x' + parseEther('0.05').toString(16)]);
    await rpc('anvil_setBalance', [buyerAcct.address, '0x' + parseEther('1').toString(16)]);
    const head = await pc.getBlockNumber();
    const cfg = loadConfig({
      CHAIN_ID: '31337', RPC_URL: RPC, SELLER_PRIVATE_KEY: sellerKey, DATABASE_PATH: tmpDb(), CONFIRMATIONS: '1',
      START_BLOCK: String(head), BUYER_ALLOWLIST: buyerAcct.address, LLM_PROVIDER: 'mock', POLL_INTERVAL_MS: '300', INSTANCE_ID: 'e2e',
    });
    store = new Store(cfg.databasePath);
    engine = new Engine({ cfg, store, chain: new ViemChain(cfg.rpcUrls, cfg.chainId), signer: new LocalSigner(sellerKey), provider: new MockProvider() });
    server = startHttp(engine, { port: 18546, host: '127.0.0.1', dashboardDir: 'dashboard' });
    let busy = false;
    loop = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await engine.tick(); } finally { busy = false; }
    }, 300);
  });

  afterAll(async () => {
    if (loop) clearInterval(loop);
    server?.close();
    await sleep(400);
    store?.close();
    anvil?.kill('SIGKILL');
  });

  const buyer = () =>
    new ZeroHumanBuyer({
      publicClient: pc,
      walletClient: createWalletClient({ account: buyerAcct, chain: foundry, transport: http(RPC) }),
      catalog: buildCatalog({ seller, chainId: 31337, status: 'allowlist', confirmations: 1 }),
    });

  it('Decision: discover → pay → deliver → independently verify proof', async () => {
    const t0 = Date.now();
    const { orderTxHash, delivery, verification } = await buyer().order(decisionRequest(['retry now', 'back off 30s', 'escalate'], 'rate limited'), { pollMs: 300, timeoutMs: 60_000 });
    expect(verification).toMatchObject({ valid: true, problems: [] });
    expect(delivery.response.ok).toBe(true);
    const rcpt = await pc.getTransactionReceipt({ hash: delivery.deliveryTxHash });
    const bytes = ((await pc.getTransaction({ hash: delivery.deliveryTxHash })).input.length - 2) / 2;
    results.decision = { orderTxHash, deliveryTxHash: delivery.deliveryTxHash, gasUsed: rcpt.gasUsed.toString(), responseBytes: bytes, seconds: (Date.now() - t0) / 1000, response: delivery.response };
    expect(rcpt.gasUsed).toBeLessThan(60_000n);
  });

  it('Encouragement: pay → deliver → verify', async () => {
    const { delivery, verification } = await buyer().order(encouragementRequest('My scraper hits CAPTCHAs after 50 pages', 'supportive'), { pollMs: 300, timeoutMs: 60_000 });
    expect(verification.valid).toBe(true);
    const rcpt = await pc.getTransactionReceipt({ hash: delivery.deliveryTxHash });
    const bytes = ((await pc.getTransaction({ hash: delivery.deliveryTxHash })).input.length - 2) / 2;
    results.encouragement = { gasUsed: rcpt.gasUsed.toString(), responseBytes: bytes, response: delivery.response };
  });

  it('a forged decision proof fails independent verification', async () => {
    const b = buyer();
    const orderTxHash = await b.submit(decisionRequest(['a', 'b', 'c', 'd', 'e']));
    await b.waitForConfirmation(orderTxHash);
    const d = await b.waitForDelivery(orderTxHash, { pollMs: 300, timeoutMs: 60_000 });
    if (!d.response.ok || d.response.svc !== 'decision') throw new Error('unexpected');
    const forged = { ...d, response: { ...d.response, out: { ...d.response.out, index: (d.response.out.index + 1) % 5 } } };
    const v = await verifyDelivery(pc, forged, seller);
    expect(v.valid).toBe(false);
  });

  it('invalid payments are held for review and never delivered', async () => {
    const w = createWalletClient({ account: buyerAcct, chain: foundry, transport: http(RPC) });
    const data = stringToHex(JSON.stringify(decisionRequest(['a', 'b'])));
    const wrong = await w.sendTransaction({ to: seller, value: PRICE_WEI + 1n, data });
    const stranger = privateKeyToAccount(generatePrivateKey());
    await rpc('anvil_setBalance', [stranger.address, '0x' + parseEther('1').toString(16)]);
    const notAllowed = await createWalletClient({ account: stranger, chain: foundry, transport: http(RPC) }).sendTransaction({ to: seller, value: PRICE_WEI, data });
    for (let i = 0; i < 40 && (store.getOrder(wrong)?.state !== 'needs_review' || store.getOrder(notAllowed)?.state !== 'needs_review'); i++) await sleep(300);
    expect(store.getOrder(wrong)).toMatchObject({ state: 'needs_review', reason: 'wrong_amount' });
    expect(store.getOrder(notAllowed)).toMatchObject({ state: 'needs_review', reason: 'buyer_not_allowlisted' });
    await sleep(2000);
    expect(await findDelivery(pc, wrong, seller, 50)).toBeNull();
  });

  it('high base fee pauses fulfilment; it resumes when fees fall', async () => {
    await rpc('anvil_setNextBlockBaseFeePerGas', ['0x' + (20n * 10n ** 9n).toString(16)]); // 20 gwei
    await sleep(1500);
    const b = buyer();
    const orderTxHash = await b.submit(encouragementRequest('gas test'));
    for (let i = 0; i < 30 && !('gas' in store.pauses()); i++) await sleep(300);
    expect(store.pauses()).toHaveProperty('gas');
    expect(store.getOrder(orderTxHash)?.state).not.toBe('fulfilled');
    // Base fee decays ~12.5%/block on empty blocks; force it down instead of waiting.
    await rpc('anvil_setNextBlockBaseFeePerGas', ['0x' + (10n ** 8n).toString(16)]);
    const d = await b.waitForDelivery(orderTxHash, { pollMs: 300, timeoutMs: 90_000 });
    expect((await b.verify(d)).valid).toBe(true);
    expect(store.pauses()).not.toHaveProperty('gas');
  });

  it('read-only HTTP API serves status/orders and rejects writes', async () => {
    const s: any = await (await fetch('http://127.0.0.1:18546/api/status')).json();
    expect(s.seller).toBe(seller);
    expect(s.services.map((x: { id: string }) => x.id)).toEqual(['decision', 'encouragement']);
    const o: any = await (await fetch('http://127.0.0.1:18546/api/orders')).json();
    expect(o.orders.length).toBeGreaterThanOrEqual(4);
    expect((await fetch('http://127.0.0.1:18546/api/status', { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await fetch('http://127.0.0.1:18546/')).status).toBe(200);
    expect(JSON.stringify(s)).not.toContain(sellerKey.slice(2));
    results.status = s;
  });
});

describe.skipIf(!hasAnvil)('e2e chaos: SIGKILL the real seller process repeatedly', () => {
  it('every order is delivered exactly once despite random kill -9', async () => {
    const port = 18555;
    const rpcUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn(ANVIL, ['--port', String(port), '--block-time', '1', '--silent'], { stdio: 'ignore' });
    const rpc = (method: string, params: unknown[]) =>
      fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
    for (let i = 0; i < 50; i++) { try { await rpc('eth_blockNumber', []); break; } catch { await sleep(200); } }
    const pc = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
    const sk = generatePrivateKey(), bk = generatePrivateKey();
    const seller = privateKeyToAccount(sk).address, buyer = privateKeyToAccount(bk);
    await rpc('anvil_setBalance', [seller, '0x' + parseEther('0.05').toString(16)]);
    await rpc('anvil_setBalance', [buyer.address, '0x' + parseEther('1').toString(16)]);
    const head = await pc.getBlockNumber();
    const env = {
      ...process.env, CHAIN_ID: '31337', RPC_URL: rpcUrl, SELLER_PRIVATE_KEY: sk, DATABASE_PATH: tmpDb(), CONFIRMATIONS: '1', START_BLOCK: String(head),
      BUYER_ALLOWLIST: buyer.address, LLM_PROVIDER: 'mock', POLL_INTERVAL_MS: '200', INSTANCE_ID: 'chaos-deployment', HTTP_ENABLED: 'false', LOG_LEVEL: 'error',
    };
    const startSeller = () => spawn(process.execPath, ['--import', 'tsx', 'src/seller/main.ts'], { env, stdio: 'ignore' });
    const zh = new ZeroHumanBuyer({ publicClient: pc, walletClient: createWalletClient({ account: buyer, chain: foundry, transport: http(rpcUrl) }), catalog: buildCatalog({ seller, chainId: 31337, status: 'allowlist', confirmations: 1 }) });
    const orders: Hex[] = [];
    for (let i = 0; i < 6; i++) orders.push(await zh.submit(i % 2 ? encouragementRequest(`chaos ${i}`) : decisionRequest([`a${i}`, `b${i}`, `c${i}`])));
    let kills = 0;
    let proc = startSeller();
    const deadline = Date.now() + 150_000;
    const delivered = new Map<Hex, Hex[]>();
    const countDeliveries = async () => {
      delivered.clear();
      const now = await pc.getBlockNumber();
      for (let n = head; n <= now; n++) {
        const b = await pc.getBlock({ blockNumber: n, includeTransactions: true });
        for (const t of b.transactions) {
          if (t.from.toLowerCase() !== seller.toLowerCase()) continue;
          for (const o of orders) if (t.input.includes(stringToHex(o).slice(2))) delivered.set(o, [...(delivered.get(o) ?? []), t.hash]);
        }
      }
    };
    while (Date.now() < deadline) {
      await sleep(400 + Math.floor(Math.random() * 1600));
      proc.kill('SIGKILL');
      kills++;
      await new Promise((r) => proc.once('exit', r));
      await countDeliveries();
      if (orders.every((o) => delivered.has(o))) break;
      proc = startSeller();
    }
    await sleep(3000); // let any stray in-flight tx land
    await countDeliveries();
    anvil.kill('SIGKILL');
    results.chaos = { kills, orders: orders.length, deliveries: [...delivered.values()].map((v) => v.length) };
    expect(orders.every((o) => delivered.get(o)?.length === 1)).toBe(true);
    // eslint-disable-next-line no-console
    console.log('chaos', JSON.stringify(results.chaos));
  }, 200_000);
});

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log('E2E_RESULTS ' + JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
});
