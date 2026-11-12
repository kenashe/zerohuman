import { keccak256, parseTransaction, recoverTransactionAddress, toHex, type Address, type Hex, type TransactionSerialized } from 'viem';
import type { ChainBlock, ChainClient, ChainReceipt, ChainTx } from '../../src/seller/chain.js';

interface PendingTx extends Omit<ChainTx, 'blockNumber' | 'blockHash' | 'transactionIndex'> {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
}

/** Intrinsic gas incl. EIP-7623 calldata floor for a plain transfer with data. */
export function intrinsicGas(data: Hex): bigint {
  const bytes = data === '0x' ? [] : (data.slice(2).match(/../g) ?? []);
  let zero = 0n, nonzero = 0n;
  for (const b of bytes) (b === '00' ? zero++ : nonzero++);
  const standard = 21000n + zero * 4n + nonzero * 16n;
  const floor = 21000n + (zero + nonzero * 4n) * 10n;
  return standard > floor ? standard : floor;
}

/**
 * In-memory Ethereum good enough to exercise the seller's state machine: blocks, a
 * mempool with replacement-by-fee, nonces, balances, base fee, receipts, and fault injection.
 */
export class MockChain implements ChainClient {
  chainId = 31337;
  blocks: ChainBlock[] = [];
  receipts = new Map<Hex, ChainReceipt>();
  txs = new Map<Hex, ChainTx>();
  mempool = new Map<Hex, PendingTx>();
  nonces = new Map<string, number>();
  balances = new Map<string, bigint>();
  baseFee = 1_000_000_000n; // 1 gwei
  priorityFee = 10_000_000n;
  /** Minimum tip a tx needs to be included (simulates congestion / stuck txs). */
  minTipToMine = 0n;
  /** Methods that should throw next call(s): name → remaining failures. */
  failures = new Map<string, number>();
  /** If set, sendRawTransaction accepts the tx but then throws (uncertain broadcast). */
  acceptThenThrow = false;
  /** If set, sendRawTransaction silently drops the tx (node "forgets" it). */
  dropOnSend = false;
  sentRaw: Hex[] = [];
  /** Optional: addresses that revert when called (simulates contract buyers). */
  revertingRecipients = new Set<string>();
  expensiveRecipients = new Map<string, bigint>();

  constructor() {
    this.mine(); // genesis
  }

  private maybeFail(name: string) {
    const n = this.failures.get(name) ?? 0;
    if (n > 0) {
      this.failures.set(name, n - 1);
      throw new Error(`mock RPC error in ${name}`);
    }
  }

  fund(a: Address, wei: bigint) {
    this.balances.set(a.toLowerCase(), (this.balances.get(a.toLowerCase()) ?? 0n) + wei);
  }

  /** Inject a tx from an arbitrary (unsigned) sender directly into the mempool. */
  inject(p: { from: Address; to: Address; value: bigint; input?: Hex; chainId?: number | undefined; tip?: bigint }): Hex {
    const nonce = this.pendingNonce(p.from);
    const hash = keccak256(toHex(`${p.from}-${nonce}-${Math.random()}`));
    this.mempool.set(hash, {
      hash,
      from: p.from,
      to: p.to,
      value: p.value,
      input: p.input ?? '0x',
      chainId: 'chainId' in p ? p.chainId : this.chainId,
      nonce,
      maxFeePerGas: 10n ** 12n,
      maxPriorityFeePerGas: p.tip ?? 10n ** 9n,
      gas: 100_000n,
    });
    return hash;
  }

  private pendingNonce(a: Address): number {
    let n = this.nonces.get(a.toLowerCase()) ?? 0;
    const mine = [...this.mempool.values()].filter((t) => t.from.toLowerCase() === a.toLowerCase()).map((t) => t.nonce);
    while (mine.includes(n)) n++;
    return n;
  }

  /** Mine one block including eligible mempool txs (by nonce order). */
  mine(): ChainBlock {
    const number = BigInt(this.blocks.length);
    const hash = keccak256(toHex(`block-${number}-${Math.random()}`));
    const included: ChainTx[] = [];
    const pending = [...this.mempool.values()].sort((a, b) => a.nonce - b.nonce);
    for (const p of pending) {
      const from = p.from.toLowerCase();
      if ((this.nonces.get(from) ?? 0) !== p.nonce) continue;
      const tip = p.maxPriorityFeePerGas < p.maxFeePerGas - this.baseFee ? p.maxPriorityFeePerGas : p.maxFeePerGas - this.baseFee;
      if (p.maxFeePerGas < this.baseFee || tip < this.minTipToMine) continue;
      const egp = this.baseFee + tip;
      const reverts = p.to ? this.revertingRecipients.has(p.to.toLowerCase()) : false;
      const gasUsed = intrinsicGas(p.input) + (p.to ? this.expensiveRecipients.get(p.to.toLowerCase()) ?? 0n : 0n);
      const tx: ChainTx = { hash: p.hash, from: p.from, to: p.to, value: p.value, input: p.input, chainId: p.chainId, blockNumber: number, blockHash: hash, transactionIndex: included.length };
      included.push(tx);
      this.txs.set(p.hash, tx);
      this.nonces.set(from, p.nonce + 1);
      const fee = gasUsed * egp;
      this.balances.set(from, (this.balances.get(from) ?? 0n) - fee - (reverts ? 0n : p.value));
      if (p.to && !reverts) this.balances.set(p.to.toLowerCase(), (this.balances.get(p.to.toLowerCase()) ?? 0n) + p.value);
      this.receipts.set(p.hash, { status: reverts ? 'reverted' : 'success', blockNumber: number, blockHash: hash, gasUsed, effectiveGasPrice: egp });
      this.mempool.delete(p.hash);
      // Drop any other mempool txs with the same sender+nonce (replaced / now invalid).
      for (const [h, q] of this.mempool) if (q.from.toLowerCase() === from && q.nonce === p.nonce) this.mempool.delete(h);
    }
    const block: ChainBlock = { number, hash, baseFeePerGas: this.baseFee, transactions: included };
    this.blocks.push(block);
    return block;
  }

  mineN(n: number) {
    for (let i = 0; i < n; i++) this.mine();
  }

  // ---------------------------------------------------------------- ChainClient
  async getChainId() {
    this.maybeFail('getChainId');
    return this.chainId;
  }
  async getBlockNumber() {
    this.maybeFail('getBlockNumber');
    return BigInt(this.blocks.length - 1);
  }
  async getBlock(n: bigint) {
    this.maybeFail('getBlock');
    const b = this.blocks[Number(n)];
    if (!b) throw new Error(`block ${n} not found`);
    return b;
  }
  async getBlockHash(n: bigint) {
    this.maybeFail('getBlockHash');
    return (await this.getBlock(n)).hash;
  }
  async getReceipt(hash: Hex) {
    this.maybeFail('getReceipt');
    return this.receipts.get(hash) ?? null;
  }
  async hasTransaction(hash: Hex) {
    return this.mempool.has(hash) || this.txs.has(hash);
  }
  async getNonce(a: Address, tag: 'latest' | 'pending') {
    this.maybeFail('getNonce');
    return tag === 'latest' ? this.nonces.get(a.toLowerCase()) ?? 0 : this.pendingNonce(a);
  }
  async getBalance(a: Address) {
    return this.balances.get(a.toLowerCase()) ?? 0n;
  }
  async getBaseFee() {
    this.maybeFail('getBaseFee');
    return this.baseFee;
  }
  async getPriorityFee() {
    return this.priorityFee;
  }
  async estimateGas(p: { from: Address; to: Address; value: bigint; data: Hex }) {
    this.maybeFail('estimateGas');
    if (this.revertingRecipients.has(p.to.toLowerCase())) throw new Error('execution reverted');
    return intrinsicGas(p.data) + (this.expensiveRecipients.get(p.to.toLowerCase()) ?? 0n);
  }
  async sendRawTransaction(raw: Hex) {
    this.maybeFail('sendRawTransaction');
    this.sentRaw.push(raw);
    const hash = keccak256(raw);
    if (this.dropOnSend) throw new Error('mock: connection reset');
    if (this.txs.has(hash)) throw new Error('already known');
    const tx = parseTransaction(raw as TransactionSerialized);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
    if (tx.chainId !== this.chainId) throw new Error('invalid chain id');
    const confirmed = this.nonces.get(from.toLowerCase()) ?? 0;
    if (tx.nonce! < confirmed) throw new Error('nonce too low');
    // Replacement rule: same nonce requires ≥10% higher fees.
    for (const [h, q] of this.mempool) {
      if (q.from.toLowerCase() === from.toLowerCase() && q.nonce === tx.nonce) {
        if (h === hash) throw new Error('already known');
        if (tx.maxFeePerGas! * 10n < q.maxFeePerGas * 11n || tx.maxPriorityFeePerGas! * 10n < q.maxPriorityFeePerGas * 11n) throw new Error('replacement transaction underpriced');
        this.mempool.delete(h);
      }
    }
    this.mempool.set(hash, {
      hash,
      from,
      to: tx.to!,
      value: tx.value ?? 0n,
      input: tx.data ?? '0x',
      chainId: tx.chainId,
      nonce: tx.nonce!,
      maxFeePerGas: tx.maxFeePerGas!,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas!,
      gas: tx.gas!,
    });
    if (this.acceptThenThrow) throw new Error('mock: timeout after accept');
    return hash;
  }

  /** All txs ever mined from `from` to `to`. */
  minedBetween(from: Address, to?: Address): ChainTx[] {
    return [...this.txs.values()].filter((t) => t.from.toLowerCase() === from.toLowerCase() && (!to || t.to?.toLowerCase() === to.toLowerCase()));
  }
}
