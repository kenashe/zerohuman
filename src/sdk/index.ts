/**
 * ZeroHuman buyer SDK (zh/1).
 *
 * Everything here works against public Ethereum RPC + ENS only. A buyer never needs
 * ZeroHuman's servers, dashboard, or API to discover, order, receive, or verify.
 */
import {
  getAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { normalize } from 'viem/ens';
import { ENS_CATALOG_KEY, ENS_NAME, LIMITS, PRICE_WEI, type EncouragementTone } from '../protocol/constants.js';
import { decodeRequest, decodeResponse, encodeRequest, responseMentionsOrder } from '../protocol/codec.js';
import { verifyDecisionResult, targetBlockFor, type ProofCheck } from '../protocol/decision.js';
import { parseCatalog } from '../protocol/catalog.js';
import {
  canonicalise,
  type Catalog,
  type DecisionRequest,
  type EncouragementRequest,
  type ZhRequest,
  type ZhResponse,
} from '../protocol/schemas.js';

export * from '../protocol/index.js';

export interface Delivery {
  orderTxHash: Hex;
  deliveryTxHash: Hex;
  deliveryBlock: bigint;
  response: ZhResponse;
}

export interface Verification extends ProofCheck {
  order: { hash: Hex; block: bigint; from: Address; to: Address; value: bigint; request: ZhRequest | null };
  delivery: { hash: Hex; block: bigint; from: Address; to: Address; value: bigint };
}

/** Read and validate the catalog from ENS (`com.zerohuman.services` on zerohuman.eth). */
export async function readCatalog(ensClient: PublicClient, name: string = ENS_NAME): Promise<Catalog> {
  const text = await ensClient.getEnsText({ name: normalize(name), key: ENS_CATALOG_KEY });
  if (!text) throw new Error(`ENS text record ${ENS_CATALOG_KEY} not found on ${name}`);
  return parseCatalog(text);
}

export function decisionRequest(options: string[], context?: string, ref?: string): DecisionRequest {
  const opts = options.map(canonicalise);
  const req: DecisionRequest = { zh: 1, svc: 'decision', opts };
  if (context) req.ctx = canonicalise(context);
  if (ref) req.ref = canonicalise(ref);
  encodeRequest(req); // throws with a precise message if anything is out of bounds
  return req;
}

export function encouragementRequest(message: string, tone?: EncouragementTone, ref?: string): EncouragementRequest {
  const req: EncouragementRequest = { zh: 1, svc: 'encouragement', msg: canonicalise(message) };
  if (tone) req.tone = tone;
  if (ref) req.ref = canonicalise(ref);
  encodeRequest(req);
  return req;
}

export interface BuyerOptions {
  /** Client for the settlement chain (mainnet in production). */
  publicClient: PublicClient;
  /** Wallet used to pay; required only for submitting orders. */
  walletClient?: WalletClient<Transport, Chain, Account>;
  /** Client used for ENS reads (defaults to publicClient; ENS lives on mainnet). */
  ensClient?: PublicClient;
  ensName?: string;
  /** Skip ENS and use this catalog (testnets / local devnets). */
  catalog?: Catalog;
}

export class ZeroHumanBuyer {
  private catalogCache: Catalog | null;
  constructor(private readonly o: BuyerOptions) {
    this.catalogCache = o.catalog ?? null;
  }

  async getCatalog(refresh = false): Promise<Catalog> {
    if (this.catalogCache && !refresh) return this.catalogCache;
    this.catalogCache = await readCatalog(this.o.ensClient ?? this.o.publicClient, this.o.ensName);
    return this.catalogCache;
  }

  /** Pay for and submit an order. Returns the order transaction hash (= order id). */
  async submit(req: ZhRequest): Promise<Hex> {
    const w = this.o.walletClient;
    if (!w) throw new Error('walletClient required to submit orders');
    const cat = await this.getCatalog();
    const chainId = await this.o.publicClient.getChainId();
    if (cat.chainId !== chainId) throw new Error(`catalog chainId ${cat.chainId} != connected chain ${chainId}`);
    if (cat.status === 'paused' || cat.status === 'retired') throw new Error(`ZeroHuman catalog status is ${cat.status}`);
    const price = BigInt(cat.services[req.svc].price);
    if (price !== PRICE_WEI) throw new Error(`catalog price ${price} differs from the zh/1 protocol price ${PRICE_WEI}; refusing`);
    const data = encodeRequest(req);
    return w.sendTransaction({ to: getAddress(cat.seller), value: price, data, chain: w.chain, account: w.account });
  }

  async waitForConfirmation(orderTxHash: Hex, confirmations = 1, timeoutMs = 600_000) {
    const r = await this.o.publicClient.waitForTransactionReceipt({ hash: orderTxHash, confirmations, timeout: timeoutMs });
    if (r.status !== 'success') throw new Error('order transaction reverted');
    return r;
  }

  /**
   * Wait for the seller's delivery transaction by scanning blocks after the order.
   * Looks for a tx from the catalog seller to the order sender whose data is a valid
   * zh/1 response referencing this order.
   */
  async waitForDelivery(orderTxHash: Hex, opts: { timeoutMs?: number; pollMs?: number; maxBlocks?: number; once?: boolean } = {}): Promise<Delivery> {
    const pc = this.o.publicClient;
    const cat = await this.getCatalog();
    const seller = getAddress(cat.seller).toLowerCase();
    const deadlineAll = Date.now() + (opts.timeoutMs ?? 3_600_000);
    const rcpt = await pc.waitForTransactionReceipt({ hash: orderTxHash, timeout: Math.max(1, deadlineAll - Date.now()), pollingInterval: opts.pollMs ?? 4_000 });
    if (rcpt.status !== 'success') throw new Error('order transaction reverted');
    const orderTx = await pc.getTransaction({ hash: orderTxHash });
    if (!orderTx.blockNumber) throw new Error('order not mined yet');
    const buyer = orderTx.from.toLowerCase();
    const deadline = deadlineAll;
    const maxBlocks = BigInt(opts.maxBlocks ?? 2_000);
    let next = orderTx.blockNumber + 1n;
    for (;;) {
      const head = await pc.getBlockNumber({ cacheTime: 0 });
      while (next <= head && next <= orderTx.blockNumber + maxBlocks) {
        const b = await pc.getBlock({ blockNumber: next, includeTransactions: true });
        for (const t of b.transactions) {
          if (t.from.toLowerCase() !== seller || t.to?.toLowerCase() !== buyer) continue;
          if (!responseMentionsOrder(t.input, orderTxHash)) continue;
          const d = decodeResponse(t.input);
          if (d.ok && d.value.re.toLowerCase() === orderTxHash.toLowerCase())
            return { orderTxHash, deliveryTxHash: t.hash, deliveryBlock: b.number!, response: d.value };
        }
        next++;
      }
      if (opts.once || next > orderTx.blockNumber + maxBlocks || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 4_000));
    }
    throw new Error('timed out waiting for delivery');
  }

  /** Independently verify a delivery (and, for decisions, the random-selection proof). */
  async verify(delivery: Delivery): Promise<Verification> {
    return verifyDelivery(this.o.publicClient, delivery, getAddress((await this.getCatalog()).seller));
  }

  /** Convenience: submit → confirm → wait for delivery → verify. */
  async order(req: ZhRequest, opts: { timeoutMs?: number; pollMs?: number } = {}) {
    const orderTxHash = await this.submit(req);
    await this.waitForConfirmation(orderTxHash);
    const delivery = await this.waitForDelivery(orderTxHash, opts);
    const verification = await this.verify(delivery);
    return { orderTxHash, delivery, verification };
  }
}

/**
 * Verify a delivery using only the buyer's own RPC view of the chain.
 * Checks: order paid exact price to seller; delivery is zero-value from seller to the order's
 * sender; response references the order; for decisions, recomputes the selection from the
 * canonical block hash and the options in the order transaction itself.
 */
export async function verifyDelivery(pc: PublicClient, d: Delivery, seller: Address): Promise<Verification> {
  const problems: string[] = [];
  const [otx, orcpt, dtx, drcpt] = await Promise.all([
    pc.getTransaction({ hash: d.orderTxHash }),
    pc.getTransactionReceipt({ hash: d.orderTxHash }),
    pc.getTransaction({ hash: d.deliveryTxHash }),
    pc.getTransactionReceipt({ hash: d.deliveryTxHash }),
  ]);
  const s = seller.toLowerCase();
  const decoded = decodeRequest(otx.input);
  const request = decoded.ok ? decoded.value : null;
  if (orcpt.status !== 'success') problems.push('order transaction reverted');
  if (otx.to?.toLowerCase() !== s) problems.push('order was not sent to the seller');
  if (otx.value !== PRICE_WEI) problems.push(`order value ${otx.value} != ${PRICE_WEI}`);
  if (drcpt.status !== 'success') problems.push('delivery transaction reverted');
  if (dtx.from.toLowerCase() !== s) problems.push('delivery not sent by the seller');
  if (dtx.to?.toLowerCase() !== otx.from.toLowerCase()) problems.push('delivery not addressed to the order sender');
  if (dtx.value !== 0n) problems.push('delivery carries value');
  if (dtx.blockNumber! <= otx.blockNumber!) problems.push('delivery is not after the order');
  const resp = decodeResponse(dtx.input);
  if (!resp.ok) problems.push('delivery data is not a valid zh/1 response');
  else {
    if (resp.value.re.toLowerCase() !== d.orderTxHash.toLowerCase()) problems.push('response does not reference this order');
    if (JSON.stringify(resp.value) !== JSON.stringify(d.response)) problems.push('response differs from on-chain delivery data');
    if (resp.value.ok && request && resp.value.svc !== request.svc) problems.push('response service differs from request service');
    if (resp.value.ok && resp.value.svc === 'decision') {
      if (!request || request.svc !== 'decision') problems.push('decision response for a non-decision order');
      else {
        const target = targetBlockFor(otx.blockNumber!);
        const tb = await pc.getBlock({ blockNumber: target });
        const check = verifyDecisionResult(resp.value.out, {
          options: request.opts,
          orderTxHash: d.orderTxHash,
          orderBlock: otx.blockNumber!,
          targetBlockHash: tb.hash!,
        });
        problems.push(...check.problems);
      }
    }
    if (resp.value.ok && resp.value.svc === 'encouragement') {
      const o = resp.value.out;
      if (o.message.length > LIMITS.encouragementOutMessageMaxChars || o.nextStep.length > LIMITS.encouragementOutStepMaxChars) problems.push('encouragement exceeds length limits');
    }
  }
  return {
    valid: problems.length === 0,
    problems,
    order: { hash: d.orderTxHash, block: otx.blockNumber!, from: otx.from, to: otx.to!, value: otx.value, request },
    delivery: { hash: d.deliveryTxHash, block: dtx.blockNumber!, from: dtx.from, to: dtx.to!, value: dtx.value },
  };
}

/** Locate the delivery for an order without a buyer instance (used by verifiers/CLIs). */
export async function findDelivery(pc: PublicClient, orderTxHash: Hex, seller: Address, maxBlocks = 2_000): Promise<Delivery | null> {
  const b = new ZeroHumanBuyer({
    publicClient: pc,
    catalog: { seller, chainId: await pc.getChainId(), services: { decision: { price: PRICE_WEI.toString() }, encouragement: { price: PRICE_WEI.toString() } } } as unknown as Catalog,
  });
  try {
    return await b.waitForDelivery(orderTxHash, { timeoutMs: 30_000, maxBlocks, once: true });
  } catch {
    return null;
  }
}
