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
    store.setOrderState(o.hash, 'confirmed', 'admitted_by_operator', { refund_status: 'none' });
    out({ ok: true });
    break;
  }
  case 'requeue': {
    const o = need(_[0]);
    const ob = store.db.prepare("SELECT * FROM outbox WHERE kind = 'delivery' AND order_hash = ?").get(o.hash) as { id: number; status: string } | undefined;
    if (!ob || ob.status !== 'review') die('no delivery in review for this order');
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
    if (!_[0]) die('usage: zh-admin resume <operator|nonce|gas|budget|balance|order_cap>  (config is controlled by PAUSED)');
    store.clearPause(_[0]!);
    out(store.pauses());
    break;
  default:
    die('commands: status | review | events | order | approve-refund | decline-refund | admit | requeue | pause | resume');
}
store.close();
