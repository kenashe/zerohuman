import { getAddress, isAddress, parseGwei, type Address, type Hex } from 'viem';
import { MAINNET_CHAIN_ID, PRICE_WEI } from '../protocol/constants.js';

export interface SellerConfig {
  chainId: number;
  rpcUrls: string[];
  privateKey: Hex;
  databasePath: string;
  confirmations: number;
  startBlock: bigint | null;
  pollIntervalMs: number;
  maxBlocksPerTick: number;
  allowlist: Set<string> | null; // null = public (requires explicit approval flag)
  operatorPaused: boolean;
  gas: {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    maxDeliveryCostWei: bigint;
    deliveryGasLimitCap: bigint;
    dailyGasBudgetWei: bigint;
    minBalanceWei: bigint;
    stuckAfterMs: number;
    feeBumpPercent: number;
    maxReplacements: number;
  };
  maxOrdersPerDay: number;
  llm: {
    provider: 'deepseek' | 'mock' | 'none';
    apiKey: string | null;
    model: string;
    baseUrl: string;
    timeoutMs: number;
    maxTokens: number;
    dailyCallLimit: number;
  };
  http: { enabled: boolean; port: number; host: string; dashboardDir: string | null };
  sweep: { to: Address; aboveWei: bigint; keepWei: bigint } | null;
  instanceId: string;
  leaseTtlMs: number;
  publicStatusUrl: string | null;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const req = (env: Env, k: string): string => {
  const v = env[k]?.trim();
  if (!v) throw new ConfigError(`missing required env ${k}`);
  return v;
};
const int = (env: Env, k: string, d: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const raw = env[k]?.trim();
  if (!raw) return d;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`env ${k} must be an integer in [${min}, ${max}]`);
  return n;
};
const big = (env: Env, k: string, d: bigint): bigint => {
  const raw = env[k]?.trim();
  if (!raw) return d;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigError(`env ${k} must be a non-negative integer (wei)`);
  return BigInt(raw);
};
const gwei = (env: Env, k: string, d: string): bigint => {
  const raw = env[k]?.trim() || d;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw)) throw new ConfigError(`env ${k} must be a decimal gwei amount`);
  return parseGwei(raw);
};
const bool = (env: Env, k: string, d: boolean): boolean => {
  const raw = env[k]?.trim().toLowerCase();
  if (!raw) return d;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`env ${k} must be a boolean`);
};

/** The exact phrase an operator must set to remove the buyer allowlist. */
export const PUBLIC_APPROVAL_PHRASE = 'I_APPROVE_PUBLIC_BUYERS';

export function loadConfig(env: Env = process.env): SellerConfig {
  const chainId = int(env, 'CHAIN_ID', MAINNET_CHAIN_ID, 1);
  const rpcUrls = req(env, 'RPC_URL').split(',').map((s) => s.trim()).filter(Boolean);
  if (rpcUrls.some((u) => !/^https?:\/\//.test(u))) throw new ConfigError('RPC_URL entries must be http(s) URLs');

  const privateKey = req(env, 'SELLER_PRIVATE_KEY') as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new ConfigError('SELLER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');

  const allowRaw = env.BUYER_ALLOWLIST?.trim() ?? '';
  const publicMode = env.PUBLIC_BUYERS?.trim() === PUBLIC_APPROVAL_PHRASE;
  let allowlist: Set<string> | null = null;
  if (!publicMode) {
    const list = allowRaw.split(',').map((s) => s.trim()).filter(Boolean);
    for (const a of list) if (!isAddress(a)) throw new ConfigError(`BUYER_ALLOWLIST contains invalid address ${a}`);
    allowlist = new Set(list.map((a) => a.toLowerCase()));
    // An empty allowlist is allowed: the service then fulfils nobody (safe default).
  }

  const sweepTo = env.SWEEP_TO_ADDRESS?.trim();
  if (sweepTo && !isAddress(sweepTo)) throw new ConfigError('SWEEP_TO_ADDRESS is not a valid address');

  const llmProvider = (env.LLM_PROVIDER?.trim() || 'deepseek') as SellerConfig['llm']['provider'];
  if (!['deepseek', 'mock', 'none'].includes(llmProvider)) throw new ConfigError('LLM_PROVIDER must be deepseek, mock, or none');
  if (llmProvider === 'mock' && chainId === MAINNET_CHAIN_ID) throw new ConfigError('LLM_PROVIDER=mock is not allowed on mainnet');

  const startRaw = env.START_BLOCK?.trim();
  if (startRaw && !/^[0-9]+$/.test(startRaw)) throw new ConfigError('START_BLOCK must be a block number');

  const cfg: SellerConfig = {
    chainId,
    rpcUrls,
    privateKey,
    databasePath: env.DATABASE_PATH?.trim() || './data/zerohuman.db',
    confirmations: int(env, 'CONFIRMATIONS', chainId === MAINNET_CHAIN_ID ? 6 : 2, 0, 64),
    startBlock: startRaw ? BigInt(startRaw) : null,
    pollIntervalMs: int(env, 'POLL_INTERVAL_MS', 6000, 200),
    maxBlocksPerTick: int(env, 'MAX_BLOCKS_PER_TICK', 25, 1, 1000),
    allowlist,
    operatorPaused: bool(env, 'PAUSED', false),
    gas: {
      maxFeePerGas: gwei(env, 'MAX_FEE_PER_GAS_GWEI', '3'),
      maxPriorityFeePerGas: gwei(env, 'MAX_PRIORITY_FEE_GWEI', '0.05'),
      // Default: a delivery's WORST-CASE gas (gasLimit × maxFeePerGas) may not exceed 75% of the price.
      maxDeliveryCostWei: big(env, 'MAX_DELIVERY_COST_WEI', (PRICE_WEI * 3n) / 4n),
      deliveryGasLimitCap: big(env, 'DELIVERY_GAS_LIMIT_CAP', 80_000n),
      dailyGasBudgetWei: big(env, 'DAILY_GAS_BUDGET_WEI', 2_000_000_000_000_000n), // 0.002 ETH / rolling 24h
      minBalanceWei: big(env, 'MIN_BALANCE_WEI', 0n),
      stuckAfterMs: int(env, 'STUCK_AFTER_MS', 180_000, 1000),
      feeBumpPercent: int(env, 'FEE_BUMP_PERCENT', 20, 11, 200),
      maxReplacements: int(env, 'MAX_REPLACEMENTS', 3, 0, 10),
    },
    maxOrdersPerDay: int(env, 'MAX_ORDERS_PER_DAY', 300, 1),
    llm: {
      provider: llmProvider,
      apiKey: env.DEEPSEEK_API_KEY?.trim() || null,
      model: env.LLM_MODEL?.trim() || 'deepseek-flash',
      baseUrl: env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
      timeoutMs: int(env, 'LLM_TIMEOUT_MS', 15_000, 1000, 60_000),
      maxTokens: int(env, 'LLM_MAX_TOKENS', 220, 32, 1000),
      dailyCallLimit: int(env, 'LLM_DAILY_CALL_LIMIT', 500, 0),
    },
    http: {
      enabled: bool(env, 'HTTP_ENABLED', true),
      port: int(env, 'PORT', 8080, 1, 65535),
      host: env.HTTP_HOST?.trim() || '0.0.0.0',
      dashboardDir: env.DASHBOARD_DIR?.trim() || 'dashboard',
    },
    sweep: sweepTo
      ? { to: getAddress(sweepTo), aboveWei: big(env, 'SWEEP_ABOVE_WEI', 10_000_000_000_000_000n), keepWei: big(env, 'SWEEP_KEEP_WEI', 3_000_000_000_000_000n) }
      : null,
    instanceId: env.RAILWAY_DEPLOYMENT_ID?.trim() || env.INSTANCE_ID?.trim() || `local-${process.pid}-${Date.now()}`,
    leaseTtlMs: int(env, 'LEASE_TTL_MS', 90_000, 5_000),
    publicStatusUrl: env.PUBLIC_STATUS_URL?.trim() || null,
  };
  if (cfg.llm.provider === 'deepseek' && !cfg.llm.apiKey) throw new ConfigError('DEEPSEEK_API_KEY is required when LLM_PROVIDER=deepseek');
  if (cfg.sweep && cfg.sweep.keepWei >= cfg.sweep.aboveWei) throw new ConfigError('SWEEP_KEEP_WEI must be below SWEEP_ABOVE_WEI');
  if (cfg.gas.maxPriorityFeePerGas > cfg.gas.maxFeePerGas) throw new ConfigError('MAX_PRIORITY_FEE_GWEI exceeds MAX_FEE_PER_GAS_GWEI');
  return cfg;
}

/** Remove secrets from the process environment once they have been loaded. */
export function scrubSecretsFromEnv(env: Env = process.env): void {
  delete env.SELLER_PRIVATE_KEY;
  delete env.DEEPSEEK_API_KEY;
}
