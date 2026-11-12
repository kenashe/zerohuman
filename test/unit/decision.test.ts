import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bytesToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { computeDecision, decisionSeed, selectIndex, targetBlockFor, verifyDecisionResult } from '../../src/protocol/decision.js';
import { DECISION_BLOCK_OFFSET } from '../../src/protocol/constants.js';

const rnd = (): Hex => bytesToHex(randomBytes(32));
const vectors = JSON.parse(readFileSync(new URL('../vectors/decision-vectors.json', import.meta.url), 'utf8')).vectors as Array<{
  targetBlockHash: Hex; orderTxHash: Hex; n: number; seed: Hex; index: number;
}>;

describe('zh-blockhash-v1 decision algorithm', () => {
  it('matches independently generated vectors (foundry cast keccak + python)', () => {
    for (const v of vectors) {
      expect(decisionSeed(v.targetBlockHash, v.orderTxHash)).toBe(v.seed);
      expect(selectIndex(v.seed, v.n)).toBe(v.index);
    }
  });

  it('always produces the same selection for the same inputs', () => {
    for (let i = 0; i < 2_000; i++) {
      const bh = rnd(), th = rnd();
      const options = ['a', 'b', 'c', 'd', 'e'].slice(0, 2 + (i % 4));
      const a = computeDecision({ options, orderTxHash: th, orderBlock: 1000 + i, targetBlockHash: bh });
      const b = computeDecision({ options: [...options], orderTxHash: th, orderBlock: 1000 + i, targetBlockHash: bh });
      expect(b).toEqual(a);
      expect(a.option).toBe(options[a.index]);
    }
  });

  it('is case-insensitive in hex inputs (canonicalises to lowercase)', () => {
    const bh = rnd(), th = rnd();
    expect(decisionSeed(bh.toUpperCase().replace('0X', '0x') as Hex, th)).toBe(decisionSeed(bh, th));
  });

  it('fixes the target block at orderBlock + offset', () => {
    expect(DECISION_BLOCK_OFFSET).toBe(5);
    expect(targetBlockFor(100)).toBe(105n);
    const r = computeDecision({ options: ['x', 'y'], orderTxHash: rnd(), orderBlock: 100, targetBlockHash: rnd() });
    expect(r.proof.targetBlock).toBe(105);
    expect(r.proof.offset).toBe(5);
  });

  // Chi-square goodness-of-fit at α = 1e-4 under uniformly random inputs.
  const CRIT: Record<number, number> = { 2: 15.14, 3: 18.42, 4: 21.11, 5: 23.51 };
  for (const n of [2, 3, 4, 5]) {
    it(`selects each of ${n} options with ~equal probability (200k trials, chi-square)`, () => {
      const N = 200_000;
      const counts = new Array(n).fill(0);
      const options = Array.from({ length: n }, (_, i) => `opt${i}`);
      for (let i = 0; i < N; i++) counts[computeDecision({ options, orderTxHash: rnd(), orderBlock: i, targetBlockHash: rnd() }).index]++;
      const exp = N / n;
      const chi2 = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
      for (const c of counts) expect(Math.abs(c / N - 1 / n)).toBeLessThan(0.01);
      expect(chi2).toBeLessThan(CRIT[n]!);
      // eslint-disable-next-line no-console
      console.log(`n=${n} counts=${JSON.stringify(counts)} share=${counts.map((c) => (c / N).toFixed(4)).join('/')} chi2=${chi2.toFixed(2)} (crit ${CRIT[n]})`);
    });
  }

  describe('verification', () => {
    const facts = { options: ['red', 'green', 'blue'], orderTxHash: rnd(), orderBlock: 500, targetBlockHash: rnd() };
    const good = computeDecision(facts);

    it('accepts a correct proof', () => {
      expect(verifyDecisionResult(good, facts)).toEqual({ valid: true, problems: [] });
    });
    it('rejects a different selected index / option', () => {
      const bad = { ...good, index: (good.index + 1) % 3, option: facts.options[(good.index + 1) % 3]! };
      expect(verifyDecisionResult(bad, facts).valid).toBe(false);
    });
    it('rejects a proof built from a block the seller chose', () => {
      const otherHash = rnd();
      const forged = computeDecision({ ...facts, targetBlockHash: otherHash });
      const res = verifyDecisionResult(forged, facts);
      expect(res.valid).toBe(false);
      expect(res.problems.join()).toMatch(/targetBlockHash/);
    });
    it('rejects a shifted target block', () => {
      const forged = { ...good, proof: { ...good.proof, targetBlock: good.proof.targetBlock + 1, offset: 6 } };
      expect(verifyDecisionResult(forged, facts).valid).toBe(false);
    });
    it('rejects a tampered seed', () => {
      expect(verifyDecisionResult({ ...good, proof: { ...good.proof, seed: rnd() } }, facts).valid).toBe(false);
    });
  });
});
