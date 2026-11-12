import { concat, hexToBigInt, keccak256, type Hex } from 'viem';
import { DECISION_BLOCK_OFFSET, DECISION_METHOD } from './constants.js';
import type { DecisionProof, DecisionResult } from './schemas.js';

/**
 * zh-blockhash-v1 selection algorithm (pure, deterministic).
 *
 *   targetBlock = orderBlock + 5
 *   seed        = keccak256( targetBlockHash[32 bytes] ‖ orderTxHash[32 bytes] )
 *   index       = uint256(seed) mod n
 *
 * The modulo bias for n ≤ 5 is below 5 / 2^256 and is ignored by design; this keeps
 * the algorithm reproducible in one line of any language.
 */

const isHash32 = (h: string): h is Hex => /^0x[0-9a-fA-F]{64}$/.test(h);

export const targetBlockFor = (orderBlock: number | bigint): bigint => BigInt(orderBlock) + BigInt(DECISION_BLOCK_OFFSET);

export function decisionSeed(targetBlockHash: Hex, orderTxHash: Hex): Hex {
  if (!isHash32(targetBlockHash)) throw new Error('targetBlockHash must be 32 bytes');
  if (!isHash32(orderTxHash)) throw new Error('orderTxHash must be 32 bytes');
  return keccak256(concat([targetBlockHash.toLowerCase() as Hex, orderTxHash.toLowerCase() as Hex]));
}

export function selectIndex(seed: Hex, n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be a positive integer');
  return Number(hexToBigInt(seed) % BigInt(n));
}

export function computeDecision(params: {
  options: readonly string[];
  orderTxHash: Hex;
  orderBlock: number | bigint;
  targetBlockHash: Hex;
}): DecisionResult {
  const n = params.options.length;
  const seed = decisionSeed(params.targetBlockHash, params.orderTxHash);
  const index = selectIndex(seed, n);
  const orderBlock = Number(params.orderBlock);
  const proof: DecisionProof = {
    orderBlock,
    offset: DECISION_BLOCK_OFFSET,
    targetBlock: orderBlock + DECISION_BLOCK_OFFSET,
    targetBlockHash: params.targetBlockHash.toLowerCase() as Hex,
    seed: seed.toLowerCase() as Hex,
    n,
  };
  return { index, option: params.options[index]!, method: DECISION_METHOD, proof };
}

export type ProofCheck = { valid: boolean; problems: string[] };

/**
 * Verify a decision result against independently known facts.
 * `facts` MUST come from the buyer's own view of the chain (their RPC), not from the
 * seller's response — otherwise the check is circular.
 */
export function verifyDecisionResult(
  result: DecisionResult,
  facts: { options: readonly string[]; orderTxHash: Hex; orderBlock: number | bigint; targetBlockHash: Hex },
): ProofCheck {
  const problems: string[] = [];
  const expected = computeDecision(facts);
  if (result.method !== DECISION_METHOD) problems.push(`unexpected method ${result.method}`);
  if (result.proof.offset !== DECISION_BLOCK_OFFSET) problems.push(`offset ${result.proof.offset} != ${DECISION_BLOCK_OFFSET}`);
  if (result.proof.orderBlock !== expected.proof.orderBlock) problems.push(`orderBlock ${result.proof.orderBlock} != ${expected.proof.orderBlock}`);
  if (result.proof.targetBlock !== expected.proof.targetBlock) problems.push(`targetBlock ${result.proof.targetBlock} != ${expected.proof.targetBlock}`);
  if (result.proof.targetBlockHash.toLowerCase() !== expected.proof.targetBlockHash) problems.push('targetBlockHash does not match the canonical chain');
  if (result.proof.seed.toLowerCase() !== expected.proof.seed) problems.push('seed does not match keccak256(targetBlockHash ‖ orderTxHash)');
  if (result.proof.n !== expected.proof.n) problems.push(`n ${result.proof.n} != ${expected.proof.n}`);
  if (result.index !== expected.index) problems.push(`index ${result.index} != expected ${expected.index}`);
  if (result.option !== expected.option) problems.push('option text does not match the expected option');
  return { valid: problems.length === 0, problems };
}
