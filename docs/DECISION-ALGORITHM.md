# Decision selection algorithm: `zh-blockhash-v1`

The Decision service picks one of 2–5 options **without any language model**. The choice comes
from a fixed formula over public chain data, so any buyer can recompute it.

## Specification (fixed before any order is processed)

```
orderBlock  = block number that included the order transaction
targetBlock = orderBlock + 5                                  (offset is a protocol constant)
seed        = keccak256( blockhash(targetBlock) ‖ orderTxHash )   — 64 raw bytes in, 32 out
index       = uint256(seed) mod n                             (n = number of options, 2..5)
selected    = opts[index]
```

- `‖` is byte concatenation of the two 32-byte values (not their hex strings).
- `opts` are the exact strings in the order transaction's data. `ctx` is ignored.
- Modulo bias for n ≤ 5 is below 5/2²⁵⁶ and is deliberately ignored so the rule stays one line.
- The seller cannot deliver before `targetBlock + confirmations`, so the target block is final-ish
  when used.

### Reproduce by hand

```bash
# with foundry's cast
ORDER=0x<order tx hash>
OB=$(cast tx $ORDER blockNumber --rpc-url $RPC)
BH=$(cast block $((OB + 5)) hash --rpc-url $RPC)
SEED=$(cast keccak $BH${ORDER#0x})
python3 -c "print(int('$SEED', 16) % N)"     # N = number of options
```

or in TypeScript: `computeDecision({ options, orderTxHash, orderBlock, targetBlockHash })` from
`zerohuman/protocol`, or `verifyDelivery()` which also checks the delivery transaction.

## Why this design

- **The seller cannot pick a favourable block.** The target block is a function of where the
  buyer's transaction landed; the seller has no input. A response with any other block fails verification.
- **The seller cannot grind.** The seed depends only on the block hash and the order hash, both fixed
  before the seller acts. Re-sending the delivery cannot change the result, and only one delivery is sent.
- **The buyer cannot predict it.** At signing time the buyer does not know the hash of a block five
  blocks in the future.
- **Anyone can verify** with a public RPC and keccak256. No trusted server or signature is involved.

## Limitations — read before relying on it

This is **not** trustless, manipulation-resistant randomness (it is not a VRF and not a commit-reveal
beacon). It is suitable for **low-stakes** tie-breaking between options the agent already finds
acceptable. Do **not** use it for consequential financial, security, safety, legal, medical, or
fairness-critical decisions.

Known ways the outcome can be influenced:

1. **Block proposer influence.** The proposer of `targetBlock` determines its contents and therefore
   its hash. A proposer who knew about a specific order could try alternative block contents (or skip
   proposing, forfeiting rewards) to change the result. Cost to them is real but can be far below the
   value of a high-stakes decision. The order transaction and the requested options are public in
   the mempool and in block `orderBlock`.
2. **Proposer–buyer or proposer–seller collusion** amplifies (1).
3. **Reorgs.** If `targetBlock` is reorganised after delivery, the canonical hash changes and the
   delivered proof no longer verifies against the canonical chain. The seller waits
   `confirmations` (6 on mainnet) past the target block to make this unlikely; post-finality
   (~13 minutes) it cannot happen.
4. **Order placement timing.** A buyer can choose *when* to send, but not the resulting hash, so this
   gives no useful control.
5. **Selective non-delivery.** A dishonest seller could see the result and decide not to deliver.
   It cannot deliver a *different* valid result. Non-delivery is visible on-chain and is handled by
   the refund policy.

## Test evidence

`test/unit/decision.test.ts`:

- **Reference vectors** produced independently of the TypeScript code (foundry `cast keccak` + Python
  big-integer modulo) match exactly.
- **Determinism:** 2,000 random input sets produce identical results on repeated evaluation.
- **Uniformity:** for each n ∈ {2,3,4,5}, 200,000 trials with uniformly random 32-byte block and
  transaction hashes. Every option's share is within ±1 percentage point of 1/n and a chi-square
  goodness-of-fit test passes at α = 10⁻⁴. Results from the latest run:

| n | counts | shares | χ² | critical (α=1e-4) |
|---|---|---|---|---|
| 2 | 100221 / 99779 | .5011 / .4989 | 0.98 | 15.14 |
| 3 | 66643 / 66572 / 66785 | .3332 / .3329 / .3339 | 0.35 | 18.42 |
| 4 | 49961 / 49794 / 50170 / 50075 | .2498 / .2490 / .2509 / .2504 | 1.57 | 21.11 |
| 5 | 40339 / 39711 / 39935 / 39913 / 40102 | .2017 / .1986 / .1997 / .1996 / .2005 | 5.52 | 23.51 |

- **Forgery checks:** a proof using a different block hash, a shifted target block, a tampered seed,
  or a different index is rejected. In the end-to-end suite a buyer detects a forged index against
  real anvil block hashes.
