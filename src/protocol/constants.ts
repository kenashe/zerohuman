/**
 * ZeroHuman protocol zh/1 — fixed constants.
 *
 * Everything in this file is part of the public protocol. Changing any value
 * here is a protocol change and requires a new protocol version.
 */

/** Protocol version number carried in every request and response as `"zh": 1`. */
export const PROTOCOL_VERSION = 1 as const;
/** Human-readable protocol identifier used in the ENS catalog. */
export const PROTOCOL_ID = 'zh/1' as const;

/** Exact price of every zh/1 service: 0.0001 ETH. */
export const PRICE_WEI = 100_000_000_000_000n;

/** Ethereum mainnet chain id. Testing deployments may use Sepolia (11155111) or a local devnet (31337). */
export const MAINNET_CHAIN_ID = 1 as const;
export const SEPOLIA_CHAIN_ID = 11155111 as const;

/** ENS name and custom text record key that publish the service catalog. */
export const ENS_NAME = 'zerohuman.eth' as const;
export const ENS_CATALOG_KEY = 'com.zerohuman.services' as const;

export const SERVICE_IDS = ['decision', 'encouragement'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

/** Hard payload ceilings (bytes of UTF-8 JSON in transaction input data). */
export const LIMITS = {
  /** Maximum request size accepted by the seller. */
  requestBytes: 768,
  /** Maximum response size the seller will ever emit. */
  responseBytes: 1024,
  /** Decision: number of options. */
  decisionMinOptions: 2,
  decisionMaxOptions: 5,
  /** Decision: per-option length in UTF-8 bytes (after NFC normalisation + trim). */
  decisionOptionMaxBytes: 96,
  /** Decision: optional context length. */
  decisionContextMaxBytes: 160,
  /** Encouragement: obstacle description length. */
  encouragementMessageMaxBytes: 280,
  /** Encouragement: generated output lengths (characters). */
  encouragementOutMessageMaxChars: 240,
  encouragementOutStepMaxChars: 200,
  /** Optional buyer correlation reference. */
  refMaxBytes: 32,
} as const;

/**
 * Decision randomness — fixed before any order is processed.
 *
 * targetBlock = orderBlockNumber + DECISION_BLOCK_OFFSET
 * seed        = keccak256(blockhash(targetBlock) ‖ orderTxHash)      (64 raw bytes in)
 * index       = uint256(seed) mod optionCount
 */
export const DECISION_METHOD = 'zh-blockhash-v1' as const;
export const DECISION_BLOCK_OFFSET = 5 as const;

export const ENCOURAGEMENT_TONES = ['supportive', 'playful'] as const;
export type EncouragementTone = (typeof ENCOURAGEMENT_TONES)[number];

/** Machine-readable error codes returned in `ok:false` responses. */
export const ERROR_CODES = [
  'bad_json',
  'bad_version',
  'unknown_service',
  'invalid_input',
  'too_large',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
