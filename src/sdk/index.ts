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

export interface Identity {
  /** The ENS name buyers pay, e.g. zerohuman.eth. */
  name: string;
  /** addr(name) — the address that receives orders and sends deliveries. */
  address: Address;
  catalog: Catalog;
  /** Reverse record of `address` (ENSIP-19 primary name), if set and forward-verified. */
  primaryName: string | null;
  /** True when address's primary name is `name` (explorers then show deliveries "from zerohuman.eth"). */
  primaryNameMatches: boolean;
}

export class IdentityMismatchError extends Error {}

/**
 * Resolve ZeroHuman's identity from ENS. The ETH address record of the name is
 * authoritative: buyers pay `addr(zerohuman.eth)` and accept deliveries only from it.
 * The catalog's `seller` field must agree, otherwise the buyer refuses (a stale or
 * tampered record is never paid).
 */
export async function resolveIdentity(ensClient: PublicClient, name: string = ENS_NAME): Promise<Identity> {
  const n = normalize(name);
  const [address, catalog] = await Promise.all([ensClient.getEnsAddress({ name: n }), readCatalog(ensClient, n)]);
  if (!address) throw new IdentityMismatchError(`${name} has no ETH address record`);
  if (getAddress(catalog.seller) !== getAddress(address))
    throw new IdentityMismatchError(`${name} resolves to ${address} but its catalog names seller ${catalog.seller}; refusing`);
  if (catalog.name && normalize(catalog.name) !== n) throw new IdentityMismatchError(`catalog is for ${catalog.name}, not ${name}`);
  let primaryName: string | null = null;
  try {
    primaryName = await ensClient.getEnsName({ address });
  } catch {
    primaryName = null;
  }
  return { name: n, address: getAddress(address), catalog, primaryName, primaryNameMatches: primaryName === n };
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
  private identityCache: Identity | null = null;
  constructor(private readonly o: BuyerOptions) {
    this.catalogCache = o.catalog ?? null;
  }

  /** Resolve name → address + catalog (cross-checked). Not available with a catalog override. */
  async getIdentity(refresh = false): Promise<Identity> {
    if (this.o.catalog) throw new Error('identity is resolved from ENS; a catalog override is in use');
    if (this.identityCache && !refresh) return this.identityCache;
    this.identityCache = await resolveIdentity(this.o.ensClient ?? this.o.publicClient, this.o.ensName ?? ENS_NAME);
    this.catalogCache = this.identityCache.catalog;
    return this.identityCache;
  }

  async getCatalog(refresh = false): Promise<Catalog> {
    if (this.o.catalog) return this.o.catalog;
    if (this.catalogCache && !refresh) return this.catalogCache;
    return (await this.getIdentity(refresh)).catalog;
  }

  /** The address orders are paid to and deliveries come from: addr(zerohuman.eth). */
  async sellerAddress(refresh = false): Promise<Address> {
    if (this.o.catalog) return getAddress(this.o.catalog.seller);
    return (await this.getIdentity(refresh)).address;
  }

  /** Pay for and submit an order. Returns the order transaction hash (= order id). */
  async submit(req: ZhRequest): Promise<Hex> {
    const w = this.o.walletClient;
    if (!w) throw new Error('walletClient required to submit orders');
    // Re-resolve the name right before paying so a just-changed record is honoured.
    const to = await this.sellerAddress(true);
    const cat = await this.getCatalog();
    const chainId = await this.o.publicClient.getChainId();
    if (cat.chainId !== chainId) throw new Error(`catalog chainId ${cat.chainId} != connected chain ${chainId}`);
    if (cat.status === 'paused' || cat.status === 'retired') throw new Error(`ZeroHuman catalog status is ${cat.status}`);
    const price = BigInt(cat.services[req.svc].price);
    if (price !== PRICE_WEI) throw new Error(`catalog price ${price} differs from the zh/1 protocol price ${PRICE_WEI}; refusing`);
    const data = encodeRequest(req);
    return w.sendTransaction({ to, value: price, data, chain: w.chain, account: w.account });
  }

  async waitForConfirmation(orderTxHash: Hex, confirmations = 1, timeoutMs = 600_000) {
    const r = await this.o.publicClient.waitForTransactionReceipt({ hash: orderTxHash, confirmations, timeout: timeoutMs });
    if (r.status !== 'success') throw new Error('order transaction reverted');
    return r;
  }

  /**
   * Wait for the seller's delivery transaction by scanning blocks after the order.
   * Looks for a tx from addr(zerohuman.eth) to the order sender whose data is a valid
   * zh/1 response referencing this order.
   */
  async waitForDelivery(orderTxHash: Hex, opts: { timeoutMs?: number; pollMs?: number; maxBlocks?: number; once?: boolean } = {}): Promise<Delivery> {
    const pc = this.o.publicClient;
    // The order itself records who was paid; deliveries must come from that same address.
    const deadlineAll = Date.now() + (opts.timeoutMs ?? 3_600_000);
    const rcpt = await pc.waitForTransactionReceipt({ hash: orderTxHash, timeout: Math.max(1, deadlineAll - Date.now()), pollingInterval: opts.pollMs ?? 4_000 });
    if (rcpt.status !== 'success') throw new Error('order transaction reverted');
    const orderTx = await pc.getTransaction({ hash: orderTxHash });
    if (!orderTx.blockNumber) throw new Error('order not mined yet');
    const buyer = orderTx.from.toLowerCase();
    const seller = (await this.sellerAddress()).toLowerCase();
    if (orderTx.to?.toLowerCase() !== seller) throw new Error(`order was paid to ${orderTx.to}, not ${seller}`);
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
    return verifyDelivery(this.o.publicClient, delivery, await this.sellerAddress());
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
