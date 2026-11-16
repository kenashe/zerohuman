import { getAddress, type Address, type Hex } from 'viem';
import { ENS_CATALOG_KEY, PRICE_WEI } from '../protocol/constants.js';
import { parseCatalog } from '../protocol/catalog.js';
import { decodeRequest, encodeResponse, hasData, decodeResponse, ERROR_TEXT } from '../protocol/codec.js';
import { computeDecision, targetBlockFor } from '../protocol/decision.js';
import type { ZhResponse } from '../protocol/schemas.js';
import { fallbackResult, runEncouragement } from '../services/encouragement.js';
import type { TextProvider } from '../services/llm/provider.js';
import type { ChainClient, ChainReceipt, Signer } from './chain.js';
import type { SellerConfig } from './config.js';
import { logger } from './log.js';
import type { AttemptRow, OrderRow, OutboxRow, Store } from './store.js';

const DAY_MS = 86_400_000;

/** Intrinsic gas of a plain call carrying `data`, including the EIP-7623 calldata floor. */
export function intrinsicGas(data: Hex): bigint {
  let zero = 0n;
  let nonzero = 0n;
  for (let i = 2; i < data.length; i += 2) (data.slice(i, i + 2) === '00' ? zero++ : nonzero++);
  const standard = 21000n + zero * 4n + nonzero * 16n;
  const floor = 21000n + (zero + nonzero * 4n) * 10n;
  return standard > floor ? standard : floor;
}
const lc = (a: string) => a.toLowerCase();
const today = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ceilPct = (v: bigint, pct: number) => (v * BigInt(100 + pct) + 99n) / 100n;
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

/** Pause kinds that clear themselves when the condition goes away. */
export const AUTO_PAUSES = ['gas', 'budget', 'balance', 'order_cap', 'rpc', 'ens', 'stall', 'nonce_lag'] as const;
/** Gas of an ordinary delivery; used to tell a globally high fee from one expensive order. */
const TYPICAL_DELIVERY_GAS = 45_000n;
/** Broadcast failures in a row before the worker reports itself stalled (F4). */
const STALL_AFTER_BROADCAST_ERRORS = 5;
/** How long the RPC may report a nonce below what we already signed before we flag it (F1). */
const NONCE_LAG_ALARM_MS = 600_000;
/** Pause kinds that require an operator (`zh-admin resume <kind>`). */
export const MANUAL_PAUSES = ['operator', 'nonce', 'config'] as const;
/** Reason recorded by older versions when PAUSED=true was stored as an operator pause. */
export const LEGACY_ENV_PAUSE_REASON = 'PAUSED env set';

/** Minimal ENS view (mainnet). Implemented with viem in production, faked in tests. */
export interface EnsView {
  address(name: string): Promise<Address | null>;
  text(name: string, key: string): Promise<string | null>;
  primaryName(address: Address): Promise<string | null>;
}

export interface EngineDeps {
  ens?: EnsView | null;
  cfg: SellerConfig;
  store: Store;
  chain: ChainClient;
  signer: Signer;
  provider: TextProvider | null;
  now?: () => number;
  /** Test hook: called at named points so tests can simulate crashes. */
  faultHook?: (point: FaultPoint) => void;
}
export type FaultPoint = 'after-sign-before-broadcast' | 'after-broadcast' | 'after-prepare';

export interface TickReport {
  lease: boolean;
  scannedTo: bigint | null;
  newOrders: number;
  classified: number;
  prepared: Hex | null;
  sent: number | null;
  reconciled: 'none' | 'pending' | 'done';
  paused: string[];
  errors: string[];
}

export class Engine {
  readonly cfg: SellerConfig;
  readonly store: Store;
  readonly chain: ChainClient;
  readonly signer: Signer;
  readonly provider: TextProvider | null;
  readonly seller: Address;
  private now: () => number;
  private fault: (p: FaultPoint) => void;
  private chainVerified = false;
  readonly ens: EnsView | null;
  private lastEnsCheck = 0;
  identity: { name: string; ensAddress: string | null; catalogSeller: string | null; primaryName: string | null; ok: boolean; checkedAt: string | null } | null = null;
  lastTickAt = 0;
  lastTickOk = false;
  lastHead: bigint | null = null;
  lastBaseFee: bigint | null = null;

  constructor(d: EngineDeps) {
    this.cfg = d.cfg;
    this.store = d.store;
    this.chain = d.chain;
    this.signer = d.signer;
    this.provider = d.provider;
    this.seller = getAddress(d.signer.address);
    this.now = d.now ?? (() => Date.now());
    this.store.now = this.now;
    this.fault = d.faultHook ?? (() => {});
    // PAUSED is controlled by configuration: it is re-applied or cleared on every start.
    // It never clears an operator pause set by zh-admin or a security guard.
    if (this.cfg.operatorPaused) this.store.setPause('config', 'PAUSED=true');
    else this.store.clearPause('config');
    const legacy = this.store.pauses().operator;
    if (!this.cfg.operatorPaused && legacy?.reason === LEGACY_ENV_PAUSE_REASON) this.store.clearPause('operator');
    this.ens = d.ens ?? null;
    if (this.cfg.ens.check) {
      if (!this.ens) throw new Error('ENS check enabled but no ENS view provided');
      // Nothing is signed until the name has been verified to point at this wallet.
      this.store.setPause('ens', `not yet verified that ${this.cfg.ens.name} resolves to ${this.seller}`);
    }
  }

  /**
   * Identity guard: ZeroHuman's public identity is the ENS name. Orders are paid to
   * addr(name) and deliveries come from it, so this worker only signs while
   * addr(name) == its own wallet and the catalog's `seller` agrees.
   * RPC failures keep the previous verdict.
   */
  async checkEns(force = false): Promise<void> {
    if (!this.cfg.ens.check || !this.ens) return;
    if (!force && this.now() - this.lastEnsCheck < this.cfg.ens.intervalMs && this.lastEnsCheck !== 0) return;
    const name = this.cfg.ens.name;
    const [addr, text] = await Promise.all([this.ens.address(name), this.ens.text(name, ENS_CATALOG_KEY)]);
    let catalogSeller: string | null = null;
    let problem: string | null = null;
    if (!addr) problem = `${name} has no ETH address record`;
    else if (lc(addr) !== lc(this.seller)) problem = `${name} resolves to ${addr}, not this seller ${this.seller}`;
    if (!problem) {
      if (!text) problem = `${name} has no ${ENS_CATALOG_KEY} record`;
      else {
        try {
          catalogSeller = parseCatalog(text).seller;
          if (lc(catalogSeller) !== lc(this.seller)) problem = `catalog seller ${catalogSeller} != ${this.seller}`;
          else if (parseCatalog(text).chainId !== this.cfg.chainId) problem = `catalog chainId != ${this.cfg.chainId}`;
        } catch (e) {
          problem = `catalog record invalid: ${(e as Error).message.slice(0, 120)}`;
        }
      }
    }
    let primaryName: string | null = null;
    try {
      primaryName = await this.ens.primaryName(this.seller);
    } catch {
      primaryName = null;
    }
    this.lastEnsCheck = this.now();
    this.identity = { name, ensAddress: addr, catalogSeller, primaryName, ok: !problem, checkedAt: new Date(this.now()).toISOString() };
    if (problem) this.store.setPause('ens', problem);
    else this.store.clearPause('ens');
  }

  // ======================================================================= tick
  async tick(): Promise<TickReport> {
    const rep: TickReport = { lease: false, scannedTo: null, newOrders: 0, classified: 0, prepared: null, sent: null, reconciled: 'none', paused: [], errors: [] };
    rep.lease = this.store.acquireLease(this.cfg.instanceId, this.cfg.leaseTtlMs);
    if (!rep.lease) {
      logger.warn('another worker holds the lease; standing by');
      return rep;
    }
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        const msg = `${name}: ${(e as Error).message?.split('\n')[0] ?? String(e)}`;
        rep.errors.push(msg);
        logger.error('step failed', { step: name, error: msg });
      }
    };
    if (!this.chainVerified) {
      await step('chain', async () => {
        const id = await this.chain.getChainId();
        if (id !== this.cfg.chainId) {
          this.store.setPause('operator', `RPC chain id ${id} != configured ${this.cfg.chainId}`);
          throw new Error(`chain id mismatch: rpc=${id} cfg=${this.cfg.chainId}`);
        }
        this.chainVerified = true;
      });
      if (!this.chainVerified) return this.finish(rep);
    }
    await step('ens', async () => {
      await this.checkEns();
    });
    // 1. Reconcile anything already broadcast before doing anything new.
    await step('reconcile', async () => {
      rep.reconciled = await this.reconcileInFlight();
    });
    // 2. Discover new payments (resumes from the durable cursor; catches missed blocks).
    await step('scan', async () => {
      const r = await this.scan();
      rep.scannedTo = r.to;
      rep.newOrders = r.added;
    });
    // 3. Validate detected payments.
    await step('classify', async () => {
      rep.classified = await this.classifyDetected();
    });
    // While an operator has the worker paused they may send from the wallet themselves
    // (e.g. setting the primary name). Adopt the chain's nonce so that is not an alarm later.
    if (this.manualPaused() && !('nonce' in this.store.pauses()) && !this.store.inFlight()) {
      await step('nonce-resync', async () => {
        const latest = await this.chain.getNonce(this.seller, 'latest');
        this.store.setMeta('next_nonce', String(latest));
      });
    }
    // 4. If nothing is in flight, prepare at most one order and send at most one tx.
    if (rep.reconciled !== 'pending') {
      await step('prepare', async () => {
        rep.prepared = await this.prepareNext();
      });
      await step('send', async () => {
        rep.sent = await this.sendNext();
      });
    }
    return this.finish(rep);
  }

  private finish(rep: TickReport): TickReport {
    rep.paused = Object.keys(this.store.pauses());
    this.lastTickAt = this.now();
    this.lastTickOk = rep.errors.length === 0;
    if (rep.errors.length) this.store.setPause('rpc', rep.errors[0]!.slice(0, 200));
    else this.store.clearPause('rpc');
    return rep;
  }

  /** Any pause (manual or automatic) — used for status reporting. */
  isPaused(): boolean {
    return Object.keys(this.store.pauses()).filter((k) => k !== 'rpc').length > 0;
  }

  /** Manual pauses block everything; automatic pauses are re-evaluated by the send guards. */
  manualPaused(): boolean {
    const p = this.store.pauses();
    return MANUAL_PAUSES.some((k) => k in p);
  }

  // ======================================================================= scan
  async scan(): Promise<{ to: bigint | null; added: number }> {
    const head = await this.chain.getBlockNumber();
    this.lastHead = head;
    const safeHead = head - BigInt(this.cfg.confirmations);
    let cursor = this.store.getCursor();
    if (cursor === null) {
      const start = this.cfg.startBlock ?? (safeHead > 0n ? safeHead : 0n);
      cursor = start - 1n;
      this.store.setCursor(cursor);
      this.store.event('info', 'cursor_init', null, `scanning from block ${start}`);
    }
    if (safeHead <= cursor) return { to: cursor, added: 0 };
    const to = minBig(safeHead, cursor + BigInt(this.cfg.maxBlocksPerTick));
    let added = 0;
    const me = lc(this.seller);
    for (let n = cursor + 1n; n <= to; n++) {
      const block = await this.chain.getBlock(n);
      this.store.tx(() => {
        for (const t of block.transactions) {
          if (lc(t.from) === me) {
            this.observeOwnTx(t.hash, t.input, Number(t.blockNumber));
            continue;
          }
          if (!t.to || lc(t.to) !== me) continue;
          const inserted = this.store.insertOrder({
            hash: t.hash,
            block_number: Number(t.blockNumber),
            block_hash: t.blockHash,
            tx_index: t.transactionIndex,
            buyer: t.from,
            value: t.value.toString(),
            chain_id: t.chainId ?? null,
            input: t.input,
          });
          if (inserted) added++;
        }
        this.store.setCursor(n);
      });
    }
    return { to, added };
  }

  /**
   * The seller's own transactions, seen on-chain. If one is a delivery for an order that our
   * database does not consider delivered (e.g. the volume was lost and rebuilt from START_BLOCK),
   * adopt it as the fulfilment instead of ever delivering again. Runs inside the scan transaction.
   */
  private observeOwnTx(hash: Hex, input: Hex, blockNumber: number): void {
    if (!hasData(input)) return;
    const d = decodeResponse(input);
    if (!d.ok) return;
    const order = this.store.getOrder(d.value.re);
    if (!order) {
      // The order may sit in a block the scanner has not reached yet (rebuilt database).
      this.store.rememberOwnDelivery(d.value.re, hash, input);
      return;
    }
    const knownAttempt = this.store.db.prepare('SELECT 1 FROM attempts WHERE tx_hash = ?').get(hash);
    if (knownAttempt) return; // normal reconcile path handles our own recorded attempts
    if (order.state === 'fulfilled') {
      if (order.delivery_tx && lc(order.delivery_tx) !== lc(hash)) this.store.event('error', 'duplicate_delivery_observed', order.hash, `${hash} in block ${blockNumber}`);
      return;
    }
    const existing = this.store.db.prepare("SELECT id, status FROM outbox WHERE kind = 'delivery' AND order_hash = ?").get(order.hash) as { id: number; status: string } | undefined;
    if (existing && existing.status === 'signed') {
      // A delivery we did not record mined while ours is in flight: nonce conflict path will flag it.
      this.store.event('error', 'unrecorded_delivery_observed', order.hash, hash);
      return;
    }
    if (existing) this.store.updateOutbox(existing.id, { status: 'mined', mined_hash: hash, last_error: 'adopted from chain' });
    this.store.setOrderState(order.hash, 'fulfilled', 'adopted_from_chain', { delivery_tx: hash, response_hex: input, outcome: d.value.ok ? 'ok' : 'error', fulfilled_at: this.now() });
  }

  // ======================================================================= classify
  /** Decide whether a detected payment is a valid order. Pure apart from the receipt. */
  classify(o: OrderRow): { state: 'confirmed' | 'ignored' | 'needs_review'; reason: string | null; refund: boolean } {
    if (lc(o.buyer) === lc(this.seller)) return { state: 'ignored', reason: 'self_transfer', refund: false };
    const withData = hasData(o.input);
    const value = BigInt(o.value);
    if (!withData) {
      return value === PRICE_WEI
        ? { state: 'needs_review', reason: 'missing_request_data', refund: true }
        : { state: 'ignored', reason: 'plain_transfer', refund: false };
    }
    // Zero-value and underpaid requests cost almost nothing to send; ignore them before any
    // check that could put them in the review queue (documented in REFUNDS.md).
    if (value === 0n) return { state: 'ignored', reason: 'unpaid_request', refund: false };
    if (value < PRICE_WEI) return { state: 'ignored', reason: 'underpaid', refund: false };
    if (o.chain_id !== this.cfg.chainId) return { state: 'needs_review', reason: 'missing_or_wrong_chain_id', refund: true };
    if (value !== PRICE_WEI) return { state: 'needs_review', reason: 'wrong_amount', refund: true };
    if (this.cfg.allowlist && !this.cfg.allowlist.has(lc(o.buyer))) return { state: 'needs_review', reason: 'buyer_not_allowlisted', refund: true };
    return { state: 'confirmed', reason: null, refund: false };
  }

  async classifyDetected(): Promise<number> {
    // Bulk-ignore zero-value inbound txs in one statement (no RPC, no per-row events) so a
    // flood of free spam can never delay classification of real, paid orders.
    const bulk = this.store.db
      .prepare("UPDATE orders SET state = 'ignored', reason = CASE WHEN input = '0x' THEN 'plain_transfer' ELSE 'unpaid_request' END, updated_at = ? WHERE state = 'detected' AND value = '0'")
      .run(this.now());
    let n = Number(bulk.changes);
    for (const o of this.store.ordersInState('detected', 200)) {
      const pre = this.classify(o);
      if (pre.state === 'ignored') {
        // Nothing to deliver or refund: no receipt lookup needed (cheap under spam).
        this.store.setOrderState(o.hash, 'ignored', pre.reason);
        n++;
        continue;
      }
      const r = await this.chain.getReceipt(o.hash);
      if (!r) {
        if (this.lastHead !== null && this.lastHead - BigInt(o.block_number) > 128n) this.store.setOrderState(o.hash, 'needs_review', 'receipt_missing');
        continue;
      }
      if (lc(r.blockHash) !== lc(o.block_hash)) {
        // Re-included in another block after a reorg: track the new location; wait for depth.
        this.store.updateOrder(o.hash, { block_hash: r.blockHash, block_number: Number(r.blockNumber) });
        this.store.event('warn', 'reorg', o.hash, `moved to block ${r.blockNumber}`);
        continue;
      }
      if (r.status !== 'success') {
        this.store.setOrderState(o.hash, 'ignored', 'order_tx_reverted');
        n++;
        continue;
      }
      this.store.setOrderState(o.hash, pre.state, pre.reason, pre.refund ? { refund_status: 'eligible' } : {});
      n++;
    }
    return n;
  }

  // ======================================================================= prepare
  /** Build the response for the oldest ready order and enqueue its delivery atomically. */
  async prepareNext(): Promise<Hex | null> {
    // Deferred (temporarily unaffordable) items do not block preparing other orders (F2).
    if (this.store.inFlight() || this.store.nextQueued()) return null;
    if (this.manualPaused()) return null;
    if (this.store.countOrdersSince(this.now() - DAY_MS) >= this.cfg.maxOrdersPerDay) {
      this.store.setPause('order_cap', `>= ${this.cfg.maxOrdersPerDay} orders in 24h`);
      return null;
    }
    this.store.clearPause('order_cap');
    const head = this.lastHead ?? (await this.chain.getBlockNumber());
    // Never fulfil while catching up on history: a later block may already contain our delivery
    // (e.g. after a database restore), which the scanner must see first.
    const cursor = this.store.getCursor();
    const safeHead = head - BigInt(this.cfg.confirmations);
    if (cursor === null || safeHead - cursor > BigInt(this.cfg.maxBlocksPerTick)) return null;
    await this.scanUnconfirmedOwnTxsOnce(cursor, head);
    for (const o of this.store.ordersInState('confirmed', 25)) {
      const seen = this.store.ownDeliveryFor(o.hash);
      if (seen && !this.store.hasAttempt(seen.tx_hash)) {
        this.store.setOrderState(o.hash, 'fulfilled', 'adopted_from_chain', { delivery_tx: seen.tx_hash as Hex, response_hex: seen.input as Hex, fulfilled_at: this.now() });
        continue;
      }
      const decoded = decodeRequest(o.input);
      let res: ZhResponse;
      let resultJson: string | null = null;
      if (!decoded.ok) {
        // Signed by zerohuman.eth: fixed text only, never anything the buyer wrote (F5).
        const svc = decoded.svc === 'decision' || decoded.svc === 'encouragement' ? decoded.svc : undefined;
        res = { zh: 1, re: o.hash, ok: false, ...(svc ? { svc } : {}), err: { code: decoded.code, msg: ERROR_TEXT[decoded.code] } };
      } else if (decoded.value.svc === 'decision') {
        const target = targetBlockFor(o.block_number);
        if (head < target + BigInt(this.cfg.confirmations)) continue; // not ready yet; try next order
        const targetBlockHash = await this.chain.getBlockHash(target);
        const out = computeDecision({ options: decoded.value.opts, orderTxHash: o.hash, orderBlock: o.block_number, targetBlockHash });
        res = { zh: 1, re: o.hash, svc: 'decision', ok: true, out };
        resultJson = JSON.stringify(out);
      } else {
        const req = decoded.value;
        const day = today(this.now());
        const out = await runEncouragement(req, o.hash, {
          provider: this.provider,
          timeoutMs: this.cfg.llm.timeoutMs,
          maxTokens: this.cfg.llm.maxTokens,
          allowLlmCall: () => this.store.llmUsage(day).calls < this.cfg.llm.dailyCallLimit,
          onLlmCall: (i) => this.store.recordLlm(day, i.ok, i.inputTokens ?? 0, i.outputTokens ?? 0),
        });
        res = { zh: 1, re: o.hash, svc: 'encouragement', ok: true, out };
        resultJson = JSON.stringify(out);
      }
      let data: Hex;
      try {
        data = encodeResponse(res);
      } catch (e) {
        // Oversized model output (multi-byte text) → deterministic fallback.
        if (decoded.ok && decoded.value.svc === 'encouragement') {
          const out = fallbackResult(o.hash, decoded.value.tone ?? 'supportive');
          res = { zh: 1, re: o.hash, svc: 'encouragement', ok: true, out };
          resultJson = JSON.stringify(out);
          data = encodeResponse(res);
        } else {
          res = { zh: 1, re: o.hash, ok: false, err: { code: 'internal', msg: 'response encoding failed' } };
          data = encodeResponse(res);
        }
      }
      const outcome = res.ok ? 'ok' : 'error';
      this.store.tx(() => {
        // Re-check inside the transaction: never enqueue twice.
        const cur = this.store.getOrder(o.hash);
        if (!cur || cur.state !== 'confirmed') return;
        this.store.enqueue({ kind: 'delivery', order_hash: o.hash, to_addr: o.buyer, value: 0n, data });
        this.store.setOrderState(o.hash, 'processing', null, {
          service: decoded.ok ? decoded.value.svc : decoded.svc === 'decision' || decoded.svc === 'encouragement' ? decoded.svc : null,
          request_json: decoded.ok ? JSON.stringify(decoded.value) : null,
          result_json: resultJson,
          response_hex: data,
          outcome,
        });
      });
      this.fault('after-prepare');
      return o.hash;
    }
    // Nothing to deliver: turn operator-approved refunds and sweeps into outbox items.
    this.queueRefundsAndSweep();
    return null;
  }

  /**
   * After an empty or rebuilt database, deliveries mined in the last few (not yet confirmed)
   * blocks would be invisible to the confirmed-depth scanner. Check them once before the
   * first send so a delivery is never repeated (F9).
   */
  private async scanUnconfirmedOwnTxsOnce(cursor: bigint, head: bigint): Promise<void> {
    if (this.store.getMeta('own_tx_scan') === '1') return;
    const me = lc(this.seller);
    for (let n = cursor + 1n; n <= head; n++) {
      const block = await this.chain.getBlock(n);
      this.store.tx(() => {
        for (const t of block.transactions) if (lc(t.from) === me) this.observeOwnTx(t.hash, t.input, Number(t.blockNumber));
      });
    }
    this.store.setMeta('own_tx_scan', '1');
  }

  private queueRefundsAndSweep(): void {
    for (const o of this.store.db.prepare("SELECT * FROM orders WHERE refund_status = 'approved' AND state NOT IN ('processing','fulfilled') ORDER BY block_number LIMIT 5").all() as unknown as OrderRow[]) {
      this.store.tx(() => {
        this.store.enqueue({ kind: 'refund', order_hash: o.hash, to_addr: o.buyer, value: BigInt(o.value), data: '0x' });
        this.store.updateOrder(o.hash, { refund_status: 'queued' });
        this.store.event('info', 'refund_queued', o.hash, `value ${o.value}`);
      });
    }
  }

  private async maybeQueueSweep(): Promise<void> {
    const s = this.cfg.sweep;
    if (!s || this.store.inFlight() || this.store.nextQueued()) return;
    const bal = await this.chain.getBalance(this.seller);
    if (bal <= s.aboveWei) return;
    // A sweep in review needs the operator; do not queue another every tick (F8).
    const pendingSweep = this.store.db.prepare("SELECT id FROM outbox WHERE kind = 'sweep' AND status IN ('queued','signed','review')").get();
    if (pendingSweep) return;
    const reserved = this.store.pendingRefundWei();
    if (bal <= s.aboveWei + reserved) return;
    const value = bal - s.keepWei - reserved;
    if (value <= 0n) return;
    this.store.enqueue({ kind: 'sweep', order_hash: null, to_addr: s.to, value, data: '0x' });
    this.store.event('info', 'sweep_queued', null, `value ${value} to ${s.to}`);
  }

  // ======================================================================= invariants
  /**
   * Last line of defence before a key is used. Whatever produced the outbox row (including
   * any model output embedded in `data`), the recipient and value are re-derived from the
   * original on-chain order and fixed configuration only.
   */
  assertInvariants(item: OutboxRow): void {
    const fail = (m: string) => {
      throw new Error(`INVARIANT VIOLATION (${item.kind} #${item.id}): ${m}`);
    };
    if (lc(item.to_addr) === lc(this.seller)) fail('recipient is the seller');
    if (item.kind === 'delivery') {
      const o = item.order_hash ? this.store.getOrder(item.order_hash) : null;
      if (!o) fail('delivery without order');
      if (BigInt(item.value) !== 0n) fail('delivery must carry zero value');
      if (lc(item.to_addr) !== lc(o!.buyer)) fail('delivery recipient is not the order sender');
      const d = decodeResponse(item.data);
      if (!d.ok || lc(d.value.re) !== lc(o!.hash)) fail('delivery data does not reference the order');
    } else if (item.kind === 'refund') {
      const o = item.order_hash ? this.store.getOrder(item.order_hash) : null;
      if (!o) fail('refund without order');
      if (lc(item.to_addr) !== lc(o!.buyer)) fail('refund recipient is not the order sender');
      if (BigInt(item.value) !== BigInt(o!.value)) fail('refund value differs from amount paid');
      if (o!.refund_status !== 'queued') fail('refund not approved by operator');
      if (item.data !== '0x') fail('refund must not carry data');
    } else if (item.kind === 'sweep') {
      if (!this.cfg.sweep || lc(item.to_addr) !== lc(this.cfg.sweep.to)) fail('sweep recipient is not SWEEP_TO_ADDRESS');
      if (item.data !== '0x') fail('sweep must not carry data');
    } else fail('unknown kind');
  }

  // ======================================================================= send
  async sendNext(): Promise<number | null> {
    if (this.store.inFlight()) return null;
    if (this.manualPaused()) return null;
    if ('ens' in this.store.pauses()) return null; // identity not verified: sign nothing
    let item = this.store.nextQueued();
    if (!item) {
      await this.maybeQueueSweep();
      item = this.store.nextQueued();
      if (!item) {
        await this.refreshGasPause();
        return null;
      }
    }
    try {
      this.assertInvariants(item);
    } catch (e) {
      this.toReview(item, (e as Error).message);
      this.store.setPause('operator', 'invariant violation — see events');
      return null;
    }
    // If this item was requeued by an operator, make sure no earlier attempt actually landed.
    for (const a of this.store.attemptsFor(item.id)) {
      const r = await this.chain.getReceipt(a.tx_hash);
      if (r) {
        // Already on chain: let reconcile finalize it once it is deep enough.
        this.store.updateOutbox(item.id, { status: 'signed', nonce: a.nonce });
        return null;
      }
    }

    // ---- recipient must be a plain account (F6): no buyer code may run in a tx we originate.
    if (item.kind === 'delivery') {
      const code = await this.chain.getCode(item.to_addr as Address);
      if (code && code !== '0x') {
        this.toReview(item, 'recipient_has_code: deliveries go only to plain accounts (no contract or EIP-7702 delegation)');
        return null;
      }
    }

    // ---- global fee guard: is the network itself too expensive right now?
    const baseFee = await this.chain.getBaseFee();
    this.lastBaseFee = baseFee;
    const suggested = await this.chain.getPriorityFee();
    const prio = suggested > 0n ? minBig(suggested, this.cfg.gas.maxPriorityFeePerGas) : this.cfg.gas.maxPriorityFeePerGas;
    // 1.5× base fee headroom (~3 consecutive full blocks) keeps worst-case cost tight.
    const maxFee = minBig((baseFee * 3n) / 2n + prio, this.cfg.gas.maxFeePerGas);
    if (baseFee + prio > this.cfg.gas.maxFeePerGas || TYPICAL_DELIVERY_GAS * maxFee > this.cfg.gas.maxDeliveryCostWei) {
      this.store.setPause('gas', `base fee ${baseFee} + tip ${prio} too high for an ordinary delivery (caps: maxFee ${this.cfg.gas.maxFeePerGas}, cost ${this.cfg.gas.maxDeliveryCostWei})`);
      return null;
    }
    this.store.clearPause('gas');

    // ---- balance before estimation, so an oversized refund pauses instead of erroring (F7).
    const bal = await this.chain.getBalance(this.seller);
    if (bal < BigInt(item.value) + this.cfg.gas.minBalanceWei) {
      // A refund (or sweep) the wallet cannot cover waits without blocking deliveries (R1).
      this.store.updateOutbox(item.id, { retry_at: this.now() + 300_000 });
      this.store.event('warn', 'insufficient_balance', item.order_hash, `${item.kind} of ${item.value} wei waits: balance ${bal}`);
      return null;
    }

    let est: bigint;
    try {
      est = await this.chain.estimateGas({ from: this.seller, to: item.to_addr as Address, value: BigInt(item.value), data: item.data });
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0] ?? '';
      // Only a real execution revert is permanent; timeouts and transport errors retry (F4).
      if (/revert/i.test(msg)) this.toReview(item, `gas estimation reverted: ${msg}`);
      else throw new Error(`gas estimation failed (will retry): ${msg}`);
      return null;
    }
    if (est > this.cfg.gas.deliveryGasLimitCap) {
      this.toReview(item, `estimated gas ${est} exceeds cap ${this.cfg.gas.deliveryGasLimitCap}`);
      return null;
    }
    // Plain-account deliveries are deterministic: the exact estimate is the limit, so nothing extra can run.
    const floor = intrinsicGas(item.data);
    const exact = est > floor ? est : floor; // do not depend on the RPC's estimate being right
    const gasLimit = item.kind === 'delivery' ? exact : minBig(this.cfg.gas.deliveryGasLimitCap, (exact * 11n) / 10n + 1n);
    const worst = gasLimit * maxFee;

    // ---- this order alone too expensive (e.g. a maximum-size response): defer it, keep serving others (F2).
    if (item.kind === 'delivery' && worst > this.cfg.gas.maxDeliveryCostWei) {
      const since = item.defer_since ?? this.now();
      if (this.now() - since >= this.cfg.deferToReviewMs) {
        this.toReview(item, `delivery cost ${worst} wei stayed above MAX_DELIVERY_COST_WEI for ${Math.round((this.now() - since) / 60000)} min`);
      } else {
        this.store.updateOutbox(item.id, { defer_since: since, retry_at: this.now() + 60_000 });
        this.store.event('info', 'deferred', item.order_hash, `worst-case cost ${worst} > ${this.cfg.gas.maxDeliveryCostWei}; retrying later`);
      }
      return null;
    }

    const spent = this.store.gasSpentSince(this.now() - DAY_MS);
    const budget = this.dailyBudget();
    if (spent + worst > budget) {
      this.store.setPause('budget', `24h gas ${spent} + ${worst} would exceed ${budget}`);
      return null;
    }
    this.store.clearPause('budget');
    if (bal < BigInt(item.value) + worst + this.cfg.gas.minBalanceWei) {
      this.store.setPause('balance', `balance ${bal} insufficient for value ${item.value} + gas ${worst}`);
      return null;
    }
    this.store.clearPause('balance');

    // ---- nonce discipline (F1). We are the only signer; never sign below what we already used,
    // and treat a chain nonce that lags our own record as a stale RPC read, not as an attack.
    const latest = await this.chain.getNonce(this.seller, 'latest');
    const pending = await this.chain.getNonce(this.seller, 'pending');
    if (this.store.getMeta('nonce_resync') !== null) {
      // Set by `zh-admin resume nonce`: the operator has reviewed the wallet; adopt the chain's nonce.
      this.store.setMeta('next_nonce', String(latest));
      this.store.delMeta('nonce_resync');
      this.store.event('info', 'nonce_resynced', null, `adopted chain nonce ${latest} after operator review`);
    }
    const recorded = this.store.getMeta('next_nonce');
    const maxSigned = this.store.maxSignedNonce();
    const expected = Math.max(recorded === null ? 0 : Number(recorded), maxSigned === null ? 0 : maxSigned + 1);
    if (latest < expected && (await this.ownNonceStillLive(latest))) {
      const since = Number(this.store.getMeta('nonce_lag_since') ?? this.now());
      this.store.setMeta('nonce_lag_since', String(since));
      if (this.now() - since > NONCE_LAG_ALARM_MS) this.store.setPause('nonce_lag', `RPC reports nonce ${latest}, but nonce ${expected - 1} was already used; waiting`);
      return null;
    }
    this.store.delMeta('nonce_lag_since');
    this.store.clearPause('nonce_lag');
    if (pending > latest) {
      this.store.setPause('nonce', `pending transaction(s) from the seller wallet that this worker did not sign (latest ${latest}, pending ${pending}) — possible key misuse`);
      return null;
    }
    if (recorded !== null && latest > expected) {
      this.store.setPause('nonce', `seller wallet nonce ${latest} is ahead of this worker's records (${expected}): a transaction was sent from the wallet outside this worker, or the database was restored from an older backup — investigate, then zh-admin resume nonce`);
      return null;
    }
    const nonce = latest;

    const signed = await this.signer.sign({
      to: item.to_addr as Address,
      value: BigInt(item.value),
      data: item.data,
      nonce,
      gas: gasLimit,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: prio,
      chainId: this.cfg.chainId,
    });
    // Write-ahead: persist the signed tx BEFORE broadcasting so a crash can only ever
    // lead to re-broadcasting the identical transaction, never a second one.
    const attempt = this.store.tx(() => {
      // Deterministic signing: identical parameters give an identical transaction. Reuse it.
      const existing = this.store.attemptsFor(item!.id).find((x) => x.tx_hash === signed.hash);
      const a = existing ?? this.store.addAttempt({ outbox_id: item!.id, tx_hash: signed.hash, raw: signed.raw, nonce, max_fee: maxFee.toString(), priority_fee: prio.toString(), gas_limit: gasLimit.toString() });
      this.store.updateOutbox(item!.id, { status: 'signed', nonce, broadcast_errors: 0, retry_at: null });
      this.store.setMeta('next_nonce', String(nonce + 1));
      this.store.event('info', 'signed', item!.order_hash, `${item!.kind} tx ${signed.hash} nonce ${nonce}`);
      return a;
    });
    this.fault('after-sign-before-broadcast');
    await this.broadcast(attempt, item.id);
    this.fault('after-broadcast');
    return item.id;
  }

  /**
   * The chain says nonce `from` is unused, but we have signed transactions at or above it.
   * If any of them is mined (receipt) or known to the node, the RPC is just behind: wait.
   * If none is known anywhere, they were dropped and the nonce is genuinely free again.
   */
  private async ownNonceStillLive(from: number): Promise<boolean> {
    const rows = this.store.db.prepare('SELECT * FROM attempts WHERE nonce >= ? ORDER BY id DESC LIMIT 20').all(from) as unknown as AttemptRow[];
    for (const a of rows) {
      if (await this.chain.getReceipt(a.tx_hash)) return true;
      if (await this.chain.hasTransaction(a.tx_hash)) return true;
    }
    if (rows.length) this.store.event('warn', 'nonce_dropped', null, `own transactions at nonce >= ${from} are unknown to the node; reusing nonce ${from}`);
    return false;
  }

  /** Gas budget for the rolling 24 h: the configured floor, or a share of revenue if larger (F3). */
  dailyBudget(): bigint {
    const revenue = this.store.revenueSince(this.now() - DAY_MS, PRICE_WEI);
    const share = (revenue * BigInt(this.cfg.gas.revenueBudgetPercent)) / 100n;
    const b = share > this.cfg.gas.dailyGasBudgetWei ? share : this.cfg.gas.dailyGasBudgetWei;
    return b < this.cfg.gas.dailyGasBudgetMaxWei ? b : this.cfg.gas.dailyGasBudgetMaxWei;
  }

  /** Keep the gas pause flag honest while idle so the dashboard is accurate. */
  private lastGasRefresh = 0;
  private async refreshGasPause(): Promise<void> {
    // Idle: refresh at most once a minute, unless a gas pause needs clearing.
    if (!('gas' in this.store.pauses()) && this.now() - this.lastGasRefresh < 60_000) return;
    this.lastGasRefresh = this.now();
    const baseFee = await this.chain.getBaseFee();
    this.lastBaseFee = baseFee;
    const maxFee = minBig((baseFee * 3n) / 2n + this.cfg.gas.maxPriorityFeePerGas, this.cfg.gas.maxFeePerGas);
    if (baseFee + this.cfg.gas.maxPriorityFeePerGas > this.cfg.gas.maxFeePerGas || TYPICAL_DELIVERY_GAS * maxFee > this.cfg.gas.maxDeliveryCostWei)
      this.store.setPause('gas', `base fee ${baseFee} above cap`);
    else if ('gas' in this.store.pauses()) this.store.clearPause('gas');
  }

  private async broadcast(a: AttemptRow, outboxId: number): Promise<void> {
    try {
      await this.chain.sendRawTransaction(a.raw);
      this.store.markBroadcast(a.id);
    } catch (e) {
      const m = (e as Error).message.toLowerCase();
      if (m.includes('already known') || m.includes('known transaction') || m.includes('already imported')) {
        this.store.markBroadcast(a.id);
        return;
      }
      // Uncertain: the node may or may not have accepted it. Reconcile decides later, but a
      // rejection that keeps repeating must be visible, not a silent stall (F4).
      const item = this.store.getOutbox(outboxId);
      const n = (item?.broadcast_errors ?? 0) + 1;
      this.store.updateOutbox(outboxId, { broadcast_errors: n });
      this.store.event('warn', 'broadcast_error', item?.order_hash ?? null, `${a.tx_hash}: ${m.split('\n')[0]}`);
      if (n >= STALL_AFTER_BROADCAST_ERRORS) this.store.setPause('stall', `transaction ${a.tx_hash} rejected ${n} times in a row: ${m.split('\n')[0]?.slice(0, 120)}`);
    }
  }

  // ======================================================================= reconcile
  async reconcileInFlight(): Promise<'none' | 'pending' | 'done'> {
    const item = this.store.inFlight();
    if (!item) return 'none';
    const attempts = this.store.attemptsFor(item.id);
    for (const a of attempts) {
      const r = await this.chain.getReceipt(a.tx_hash);
      if (r) {
        // Final only once it is buried deep enough; a reorg before then removes the receipt
        // and the identical signed tx is re-broadcast below on a later tick (F1).
        const head = this.lastHead ?? (await this.chain.getBlockNumber());
        if (r.blockNumber + BigInt(this.cfg.finalityConfirmations) > head) return 'pending';
        this.finalize(item, a, r);
        return 'done';
      }
    }
    const last = attempts.at(-1);
    if (!last) {
      this.store.updateOutbox(item.id, { status: 'queued' });
      return 'done';
    }
    const latest = await this.chain.getNonce(this.seller, 'latest');
    if (latest > item.nonce!) {
      // Was the nonce used by one of OUR other transactions? Then this signature is void:
      // re-queue the item for a fresh nonce instead of raising a compromise alarm (F1).
      for (const other of this.store.attemptsWithNonce(item.nonce!, item.id)) {
        if (await this.chain.getReceipt(other.tx_hash)) {
          this.store.updateOutbox(item.id, { status: 'queued', nonce: null, broadcast_errors: 0 });
          this.store.event('warn', 'nonce_reused_own', item.order_hash, `nonce ${item.nonce} was used by our own tx ${other.tx_hash}; re-queued`);
          return 'done';
        }
      }
      // Allow a grace period, counted from when we FIRST saw the nonce consumed, for a lagging
      // receipt read. Every tick re-checks this item's receipts above, so a late receipt wins (R3).
      const key = `nonce_seen:${item.id}`;
      const firstSeen = Number(this.store.getMeta(key) ?? this.now());
      this.store.setMeta(key, String(firstSeen));
      if (this.now() - firstSeen < 120_000) return 'pending';
      for (const a of attempts) if (await this.chain.getReceipt(a.tx_hash)) return 'pending'; // final re-check
      this.store.delMeta(key);
      this.toReview(item, `nonce ${item.nonce} consumed by an unknown transaction`);
      this.store.setPause('nonce', `nonce ${item.nonce} consumed by unknown tx — investigate possible key compromise`);
      return 'done';
    }
    const pauses = this.store.pauses();
    const mayResign = !this.manualPaused() && !('ens' in pauses); // pauses stop fee-bump re-signing (F14)
    const age = this.now() - (last.broadcast_at ?? last.created_at);
    if (mayResign && age > this.cfg.gas.stuckAfterMs && attempts.length - 1 < this.cfg.gas.maxReplacements) {
      const baseFee = await this.chain.getBaseFee();
      const prio = ceilPct(BigInt(last.priority_fee), this.cfg.gas.feeBumpPercent);
      let maxFee = ceilPct(BigInt(last.max_fee), this.cfg.gas.feeBumpPercent);
      if (maxFee < baseFee + prio) maxFee = (baseFee * 3n) / 2n + prio;
      const worst = BigInt(last.gas_limit) * maxFee;
      const okCost = item.kind !== 'delivery' || worst <= this.cfg.gas.maxDeliveryCostWei;
      if (maxFee <= this.cfg.gas.maxFeePerGas && okCost) {
        const signed = await this.signer.sign({
          to: item.to_addr as Address,
          value: BigInt(item.value),
          data: item.data,
          nonce: item.nonce!,
          gas: BigInt(last.gas_limit),
          maxFeePerGas: maxFee,
          maxPriorityFeePerGas: prio,
          chainId: this.cfg.chainId,
        });
        const a = this.store.tx(() => {
          const a = this.store.addAttempt({ outbox_id: item.id, tx_hash: signed.hash, raw: signed.raw, nonce: item.nonce!, max_fee: maxFee.toString(), priority_fee: prio.toString(), gas_limit: last.gas_limit });
          this.store.updateOutbox(item.id, { broadcast_errors: 0 });
          this.store.event('warn', 'fee_bump', item.order_hash, `replacement ${signed.hash} maxFee ${maxFee}`);
          return a;
        });
        await this.broadcast(a, item.id);
        return 'pending';
      }
      this.store.setPause('gas', 'in-flight transaction stuck and fee bump would exceed caps');
    }
    // Re-broadcast the latest identical signed tx if the node has forgotten it (no new signature).
    if (!(await this.chain.hasTransaction(last.tx_hash))) await this.broadcast(last, item.id);
    return 'pending';
  }

  private finalize(item: OutboxRow, a: AttemptRow, r: ChainReceipt): void {
    this.store.delMeta(`nonce_seen:${item.id}`);
    const cost = r.gasUsed * r.effectiveGasPrice;
    const ok = r.status === 'success';
    this.store.tx(() => {
      this.store.updateOutbox(item.id, {
        status: ok ? 'mined' : 'failed',
        mined_hash: a.tx_hash,
        gas_used: r.gasUsed.toString(),
        effective_gas_price: r.effectiveGasPrice.toString(),
        cost_wei: cost.toString(),
      });
      if (item.kind === 'delivery' && item.order_hash) {
        if (ok) this.store.setOrderState(item.order_hash, 'fulfilled', null, { delivery_tx: a.tx_hash, gas_cost_wei: cost.toString(), fulfilled_at: this.now() });
        else this.store.setOrderState(item.order_hash, 'failed', 'delivery_reverted', { delivery_tx: a.tx_hash, gas_cost_wei: cost.toString(), refund_status: 'eligible' });
      } else if (item.kind === 'refund' && item.order_hash) {
        // A reverted refund is marked failed so it is visible, never silently stuck at "queued" (F7).
        this.store.updateOrder(item.order_hash, ok ? { refund_status: 'sent', refund_tx: a.tx_hash } : { refund_status: 'failed' });
        this.store.event(ok ? 'info' : 'warn', ok ? 'refund_sent' : 'refund_reverted', item.order_hash, a.tx_hash);
      } else {
        this.store.event('info', ok ? 'sweep_sent' : 'sweep_reverted', null, a.tx_hash);
      }
      this.store.clearPause('stall');
    });
    logger.info('transaction mined', { kind: item.kind, order: item.order_hash, tx: a.tx_hash, status: r.status, gasUsed: r.gasUsed, costWei: cost });
  }

  private toReview(item: OutboxRow, reason: string): void {
    this.store.tx(() => {
      this.store.updateOutbox(item.id, { status: 'review', last_error: reason.slice(0, 500) });
      if (item.kind === 'delivery' && item.order_hash) {
        const o = this.store.getOrder(item.order_hash);
        this.store.setOrderState(item.order_hash, 'needs_review', reason.slice(0, 200), o && o.refund_status === 'none' && BigInt(o.value) > 0n ? { refund_status: 'eligible' } : {});
      }
      else this.store.event('warn', 'outbox_review', item.order_hash, reason);
    });
    logger.warn('outbox item needs review', { id: item.id, kind: item.kind, reason });
  }

  // ======================================================================= status
  status() {
    const pauses = this.store.pauses();
    const dayAgo = this.now() - DAY_MS;
    return {
      seller: this.seller,
      chainId: this.cfg.chainId,
      head: this.lastHead?.toString() ?? null,
      cursor: this.store.getCursor()?.toString() ?? null,
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      healthy: this.lastTickOk && !('stall' in pauses) && this.now() - this.lastTickAt < Math.max(120_000, this.cfg.pollIntervalMs * 5),
      paused: Object.keys(pauses).filter((k) => k !== 'rpc').length > 0,
      pauses,
      mode: this.cfg.allowlist ? 'allowlist' : 'public',
      identity: this.identity ?? (this.cfg.ens.check ? { name: this.cfg.ens.name, ok: false, checkedAt: null } : null),
      orders: this.store.stateCounts(),
      outbox: this.store.outboxByStatus(),
      gas: {
        lastBaseFeeWei: this.lastBaseFee?.toString() ?? null,
        maxFeePerGasWei: this.cfg.gas.maxFeePerGas.toString(),
        maxDeliveryCostWei: this.cfg.gas.maxDeliveryCostWei.toString(),
        spent24hWei: this.store.gasSpentSince(dayAgo).toString(),
        dailyBudgetWei: this.dailyBudget().toString(),
        dailyBudgetFloorWei: this.cfg.gas.dailyGasBudgetWei.toString(),
      },
      llm: { provider: this.provider?.name ?? 'none', model: this.cfg.llm.model, today: this.store.llmUsage(today(this.now())), dailyLimit: this.cfg.llm.dailyCallLimit },
    };
  }
}
