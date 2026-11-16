#!/usr/bin/env node
/**
 * zh-admin — operator tool. Works directly on the seller database (DATABASE_PATH).
 * Never needs, reads, or prints the private key. Run it inside the Railway service shell
 * (`railway ssh` / `railway run`) where the volume is mounted.
 *
 *   zh-admin status
 *   zh-admin review                       list orders needing review
 *   zh-admin events [n]
 *   zh-admin order <hash>
 *   zh-admin approve-refund <hash>        worker refunds the exact amount paid to the sender
 *   zh-admin decline-refund <hash>
 *   zh-admin admit <hash>                 accept a non-allowlisted / reviewed order for fulfilment
 *   zh-admin requeue <hash>               retry a delivery stuck in review (checks prior attempts first)
 *   zh-admin refund-retry <hash>          retry a failed or stuck refund
 *   zh-admin sweep-clear                  dismiss sweeps stuck in review
 *   zh-admin pause [reason] | resume <kind>
 */
import { Store, type OrderRow } from '../seller/store.js';
import { die, out, parseArgs } from './args.js';

const { _ } = parseArgs(process.argv.slice(2));
const cmd = _.shift();
const store = new Store(process.env.DATABASE_PATH ?? './data/zerohuman.db');
const need = (h?: string): OrderRow => {
  if (!h) die('order hash required');
  return store.getOrder(h!) ?? die('order not found');
};

switch (cmd) {
  case 'status':
    out({ cursor: store.getCursor()?.toString() ?? null, pauses: store.pauses(), orders: store.stateCounts(), outbox: store.outboxByStatus(), gas24hWei: store.gasSpentSince(Date.now() - 86_400_000).toString(), lease: store.getMeta('lease') });
    break;
  case 'refund-retry': {
    const o = need(_[0]);
    if (o.refund_status !== 'failed' && o.refund_status !== 'queued') die(`refund is ${o.refund_status}; nothing to retry`);
    store.tx(() => {
      // Keep the old row and its attempts as history (attempts reference it); retire it so a
      // fresh refund row can be created (R5).
      store.db.prepare("UPDATE outbox SET kind = 'refund_retired_' || id WHERE kind = 'refund' AND order_hash = ? AND status IN ('failed','review','queued')").run(o.hash);
      store.updateOrder(o.hash, { refund_status: 'approved' });
      store.event('info', 'refund_retry', o.hash, 'operator');
    });
    out({ ok: true, note: 'the worker re-checks balance and gas before signing' });
    break;
  }
  case 'sweep-clear': {
    // Dismiss sweeps stuck in review so future sweeps can run (R9).
    const r = store.db.prepare("UPDATE outbox SET kind = 'sweep_retired_' || id WHERE kind = 'sweep' AND status = 'review'").run();
    store.event('info', 'sweep_cleared', null, `${r.changes} sweep(s) dismissed by operator`);
    out({ ok: true, cleared: Number(r.changes) });
    break;
  }
  case 'review':
    out(store.ordersInState('needs_review', 500).map((o) => ({ hash: o.hash, buyer: o.buyer, valueWei: o.value, reason: o.reason, refund: o.refund_status })));
    break;
  case 'events':
    out(store.recentEvents(Number(_[0] ?? 50)));
    break;
  case 'order': {
    const o = need(_[0]);
    out({ ...o, outbox: store.db.prepare('SELECT id, kind, status, nonce, mined_hash, cost_wei, last_error FROM outbox WHERE order_hash = ?').all(o.hash) });
    break;
  }
  case 'approve-refund': {
    const o = need(_[0]);
    if (!['eligible', 'declined'].includes(o.refund_status) && !(o.state === 'needs_review' && o.refund_status === 'none')) die(`refund status is ${o.refund_status}; nothing to approve`);
    if (BigInt(o.value) === 0n) die('order paid nothing');
    if (o.state === 'fulfilled' || o.state === 'processing') die(`order is ${o.state}; refusing to refund a delivered/processing order`);
    const ob = store.db.prepare("SELECT status FROM outbox WHERE kind = 'delivery' AND order_hash = ?").get(o.hash) as { status: string } | undefined;
    // A delivery in review never went out; a 'failed' delivery reverted on chain. Both may be refunded (R6).
    if (ob && ob.status !== 'review' && ob.status !== 'failed') die(`a delivery for this order is ${ob.status}; refusing to refund`);
    store.updateOrder(o.hash, { refund_status: 'approved' });
    store.event('info', 'refund_approved', o.hash, 'operator');
    out({ ok: true, hash: o.hash, refundWei: o.value, to: o.buyer });
    break;
  }
  case 'decline-refund': {
    const o = need(_[0]);
    store.updateOrder(o.hash, { refund_status: 'declined' });
    store.event('info', 'refund_declined', o.hash, 'operator');
    out({ ok: true });
    break;
  }
  case 'admit': {
    const o = need(_[0]);
    if (o.state !== 'needs_review' || !['buyer_not_allowlisted'].includes(o.reason ?? '')) die('only buyer_not_allowlisted orders can be admitted');
    if (!['none', 'eligible', 'declined'].includes(o.refund_status)) die(`refund is ${o.refund_status}; refusing to admit for delivery`);
    store.setOrderState(o.hash, 'confirmed', 'admitted_by_operator', { refund_status: 'none' });
    out({ ok: true });
    break;
  }
  case 'requeue': {
    const o = need(_[0]);
    const ob = store.db.prepare("SELECT * FROM outbox WHERE kind = 'delivery' AND order_hash = ?").get(o.hash) as { id: number; status: string } | undefined;
    if (!ob || ob.status !== 'review') die('no delivery in review for this order');
    if (['approved', 'queued', 'sent'].includes(o.refund_status)) die(`refund is ${o.refund_status}; refusing to deliver as well`);
    store.tx(() => {
      store.updateOutbox(ob!.id, { status: 'queued', last_error: null });
      store.setOrderState(o.hash, 'processing', 'requeued_by_operator');
    });
    out({ ok: true, note: 'worker will check every earlier attempt for a receipt before signing again' });
    break;
  }
  case 'pause':
    store.setPause('operator', _.join(' ') || 'operator pause');
    out(store.pauses());
    break;
  case 'resume':
    // ens and config are controlled by the identity check and the PAUSED variable, never by hand.
    if (!_[0] || !['operator', 'nonce', 'gas', 'budget', 'balance', 'order_cap', 'stall', 'nonce_lag'].includes(_[0]))
      die('usage: zh-admin resume <operator|nonce|gas|budget|balance|order_cap|stall|nonce_lag>  (ens and config cannot be resumed by hand)');
    store.clearPause(_[0]!);
    // After reviewing a nonce alarm, the worker adopts the wallet's current nonce on its next send (R2).
    if (_[0] === 'nonce') store.setMeta('nonce_resync', '1');
    out(store.pauses());
    break;
  default:
    die('commands: status | review | events | order | approve-refund | decline-refund | refund-retry | sweep-clear | admit | requeue | pause | resume');
}
store.close();
