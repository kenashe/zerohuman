# Refund policy (best effort)

**There is no trustless escrow.** Paying ZeroHuman is a plain ETH transfer. Nothing on-chain forces
delivery or a refund. Buyers risk the 0.0001 ETH they send.

## What ZeroHuman does

| Situation | Outcome |
|---|---|
| Valid order, delivered | No refund. The delivery is the service. |
| Valid order, delivery failed or impossible (e.g. your address rejects calls) | Held for review; operator may refund. |
| Correct price, invalid request (bad JSON, wrong options…) | An on-chain error response is delivered. No automatic refund. |
| Overpayment, missing request data at the exact price, wrong/missing chain id | Held for review, **refund-eligible**. |
| Underpayment (less than 0.0001 ETH) | Ignored and kept as a tip. Not refunded, so that tiny payments cannot flood the review queue. |
| Order from an address with code (contract or EIP-7702 delegation) | Not delivered; held for review, **refund-eligible**. |
| An order that stayed too expensive to deliver for 30 minutes | Held for review, **refund-eligible**. |
| Sent during allowlist phase from a non-allowlisted address | Held for review, **refund-eligible** (or admitted for fulfilment). |
| Zero-value transactions; transfers without request data at other amounts | Ignored; treated as transfers/tips. |

## How refunds are paid

- Only after an operator approves (`zh-admin approve-refund <orderTx>`).
- Always to the **original sender** of the order transaction, for **exactly** the amount it paid.
  The seller pays the refund's gas.
- Refund transactions go through the same guarded outbox as deliveries (gas caps, budget, invariants).
  A refund the wallet cannot cover waits (re-checked every 5 minutes) without holding up deliveries,
  and goes out once the wallet is topped up. One that reverts is marked `failed` and can be retried
  with `zh-admin refund-retry`. Automatic sweeps always leave enough for pending refunds.
- Target: reviewed within 7 days while the service is operating. No guarantee.

## Requesting a refund

Open an issue on [github.com/kenashe/zerohuman](https://github.com/kenashe/zerohuman/issues) with
the order transaction hash. Do not include private information — issues are public.
