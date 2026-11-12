import {
  createPublicClient,
  fallback,
  http,
  keccak256,
  serializeTransaction,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { mainnet, sepolia, foundry } from 'viem/chains';

/** Minimal chain view the seller needs. Implemented by viem (production) and a mock (tests). */
export interface ChainTx {
  hash: Hex;
  from: Address;
  to: Address | null;
  value: bigint;
  input: Hex;
  chainId: number | undefined;
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
}
export interface ChainBlock {
  number: bigint;
  hash: Hex;
  baseFeePerGas: bigint | null;
  transactions: ChainTx[];
}
export interface ChainReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: Hex;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}
export interface TxRequest {
  to: Address;
  value: bigint;
  data: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  chainId: number;
}

export interface ChainClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  /** Block with full transactions. */
  getBlock(n: bigint): Promise<ChainBlock>;
  getBlockHash(n: bigint): Promise<Hex>;
  getReceipt(hash: Hex): Promise<ChainReceipt | null>;
  /** Whether the node knows this tx at all (mempool or chain). */
  hasTransaction(hash: Hex): Promise<boolean>;
  getNonce(address: Address, tag: 'latest' | 'pending'): Promise<number>;
  getBalance(address: Address): Promise<bigint>;
  getBaseFee(): Promise<bigint>;
  getPriorityFee(): Promise<bigint>;
  estimateGas(p: { from: Address; to: Address; value: bigint; data: Hex }): Promise<bigint>;
  sendRawTransaction(raw: Hex): Promise<Hex>;
}

/** Signs transactions. Holds the only reference to the private key. */
export interface Signer {
  readonly address: Address;
  sign(tx: TxRequest): Promise<{ raw: Hex; hash: Hex }>;
}

export class LocalSigner implements Signer {
  readonly #account: PrivateKeyAccount;
  readonly address: Address;
  constructor(privateKey: Hex) {
    this.#account = privateKeyToAccount(privateKey);
    this.address = this.#account.address;
  }
  async sign(tx: TxRequest): Promise<{ raw: Hex; hash: Hex }> {
    const raw = await this.#account.signTransaction({
      type: 'eip1559',
      chainId: tx.chainId,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      nonce: tx.nonce,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    });
    return { raw, hash: keccak256(raw) };
  }
  // Prevent accidental serialisation of the account object.
  toJSON(): unknown {
    return { address: this.address };
  }
}

export const chainFor = (id: number): Chain => (id === 1 ? mainnet : id === 11155111 ? sepolia : { ...foundry, id });

export class ViemChain implements ChainClient {
  readonly client: PublicClient;
  constructor(rpcUrls: string[], chainId: number, timeoutMs = 15_000) {
    const transports = rpcUrls.map((u) => http(u, { timeout: timeoutMs, retryCount: 2, retryDelay: 500 }));
    this.client = createPublicClient({
      chain: chainFor(chainId),
      transport: transports.length > 1 ? fallback(transports) : transports[0]!,
    }) as PublicClient;
  }
  getChainId() {
    return this.client.getChainId();
  }
  getBlockNumber() {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }
  async getBlock(n: bigint): Promise<ChainBlock> {
    const b = await this.client.getBlock({ blockNumber: n, includeTransactions: true });
    return {
      number: b.number!,
      hash: b.hash!,
      baseFeePerGas: b.baseFeePerGas ?? null,
      transactions: b.transactions.map((t) => ({
        hash: t.hash,
        from: t.from,
        to: t.to ?? null,
        value: t.value,
        input: t.input,
        chainId: t.chainId,
        blockNumber: t.blockNumber!,
        blockHash: t.blockHash!,
        transactionIndex: t.transactionIndex!,
      })),
    };
  }
  async getBlockHash(n: bigint): Promise<Hex> {
    const b = await this.client.getBlock({ blockNumber: n, includeTransactions: false });
    return b.hash!;
  }
  async getReceipt(hash: Hex): Promise<ChainReceipt | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash });
      return { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice };
    } catch (e) {
      if ((e as Error).name === 'TransactionReceiptNotFoundError') return null;
      throw e;
    }
  }
  async hasTransaction(hash: Hex): Promise<boolean> {
    try {
      await this.client.getTransaction({ hash });
      return true;
    } catch (e) {
      if ((e as Error).name === 'TransactionNotFoundError') return false;
      throw e;
    }
  }
  getNonce(address: Address, tag: 'latest' | 'pending') {
    return this.client.getTransactionCount({ address, blockTag: tag });
  }
  getBalance(address: Address) {
    return this.client.getBalance({ address });
  }
  async getBaseFee(): Promise<bigint> {
    const b = await this.client.getBlock({ blockTag: 'latest' });
    return b.baseFeePerGas ?? 0n;
  }
  async getPriorityFee(): Promise<bigint> {
    try {
      return await this.client.estimateMaxPriorityFeePerGas();
    } catch {
      return 0n;
    }
  }
  estimateGas(p: { from: Address; to: Address; value: bigint; data: Hex }) {
    return this.client.estimateGas({ account: p.from, to: p.to, value: p.value, data: p.data });
  }
  sendRawTransaction(raw: Hex) {
    return this.client.sendRawTransaction({ serializedTransaction: raw });
  }
}

// Re-export for tests that need to construct raw txs.
export { serializeTransaction };
