import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Hex } from 'viem';

/**
 * Durable state (SQLite, WAL). One file on a persistent volume holds:
 *  - orders:   every payment seen, with its state machine position
 *  - outbox:   every transaction the seller intends to send (delivery / refund / sweep)
 *  - attempts: every signed transaction for an outbox item, persisted BEFORE broadcast
 *  - events:   append-only audit log
 *  - meta:     scan cursor, pause flags, worker lease
 */

export const ORDER_STATES = ['detected', 'confirmed', 'processing', 'fulfilled', 'failed', 'needs_review', 'ignored'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export type RefundStatus = 'none' | 'eligible' | 'approved' | 'queued' | 'sent' | 'declined';
export type OutboxKind = 'delivery' | 'refund' | 'sweep';
export type OutboxStatus = 'queued' | 'signed' | 'mined' | 'failed' | 'review';

export interface OrderRow {
  hash: Hex;
  block_number: number;
  block_hash: Hex;
  tx_index: number;
  buyer: Hex;
  value: string;
  chain_id: number | null;
  input: Hex;
  state: OrderState;
  reason: string | null;
  service: string | null;
  request_json: string | null;
  result_json: string | null;
  response_hex: Hex | null;
  outcome: 'ok' | 'error' | null;
  delivery_tx: Hex | null;
  gas_cost_wei: string | null;
  refund_status: RefundStatus;
  refund_tx: Hex | null;
  detected_at: number;
  updated_at: number;
  fulfilled_at: number | null;
}

export interface OutboxRow {
  id: number;
  kind: OutboxKind;
  order_hash: Hex | null;
  to_addr: Hex;
  value: string;
  data: Hex;
  status: OutboxStatus;
  nonce: number | null;
  mined_hash: Hex | null;
  gas_used: string | null;
  effective_gas_price: string | null;
  cost_wei: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface AttemptRow {
  id: number;
  outbox_id: number;
  tx_hash: Hex;
  raw: Hex;
  nonce: number;
  max_fee: string;
  priority_fee: string;
  gas_limit: string;
  created_at: number;
  broadcast_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  hash TEXT PRIMARY KEY,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_index INTEGER NOT NULL,
  buyer TEXT NOT NULL,
  value TEXT NOT NULL,
  chain_id INTEGER,
  input TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  service TEXT,
  request_json TEXT,
  result_json TEXT,
  response_hex TEXT,
  outcome TEXT,
  delivery_tx TEXT,
  gas_cost_wei TEXT,
  refund_status TEXT NOT NULL DEFAULT 'none',
  refund_tx TEXT,
  detected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  fulfilled_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_state ON orders(state, block_number, tx_index);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  order_hash TEXT,
  to_addr TEXT NOT NULL,
  value TEXT NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  nonce INTEGER,
  mined_hash TEXT,
  gas_used TEXT,
  effective_gas_price TEXT,
  cost_wei TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, order_hash)
);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, id);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL REFERENCES outbox(id),
  tx_hash TEXT NOT NULL UNIQUE,
  raw TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  max_fee TEXT NOT NULL,
  priority_fee TEXT NOT NULL,
  gas_limit TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  broadcast_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  order_hash TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS llm_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, failures INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL);
`;

export class Store {
  readonly db: DatabaseSync;
  now: () => number = () => Date.now();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run fn inside an IMMEDIATE transaction (all-or-nothing). */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ------------------------------------------------------------------ meta
  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  delMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  getCursor(): bigint | null {
    const v = this.getMeta('scan_cursor');
    return v === null ? null : BigInt(v);
  }
  setCursor(n: bigint): void {
    this.setMeta('scan_cursor', n.toString());
  }

  // ------------------------------------------------------------------ pauses
  /** Pause flags. `operator` and `nonce` need a human to clear; others auto-clear. */
  setPause(kind: string, reason: string): void {
    if (this.getMeta(`pause:${kind}`) === null) this.event('warn', 'paused', null, `${kind}: ${reason}`);
    this.setMeta(`pause:${kind}`, JSON.stringify({ reason, at: this.now() }));
  }
  clearPause(kind: string): void {
    if (this.getMeta(`pause:${kind}`) !== null) {
      this.delMeta(`pause:${kind}`);
      this.event('info', 'resumed', null, kind);
    }
  }
  pauses(): Record<string, { reason: string; at: number }> {
    const rows = this.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'pause:%'").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key.slice(6), JSON.parse(r.value)]));
  }

  // ------------------------------------------------------------------ lease
  /** Single-active-worker lease. Returns true if this instance holds it after the call. */
  acquireLease(instanceId: string, ttlMs: number): boolean {
    return this.tx(() => {
      const cur = this.getMeta('lease');
      const now = this.now();
      if (cur) {
        const l = JSON.parse(cur) as { id: string; until: number };
        if (l.id !== instanceId && l.until > now) return false;
      }
      this.setMeta('lease', JSON.stringify({ id: instanceId, until: now + ttlMs }));
      return true;
    });
  }
  releaseLease(instanceId: string): void {
    this.tx(() => {
      const cur = this.getMeta('lease');
      if (cur && (JSON.parse(cur) as { id: string }).id === instanceId) this.delMeta('lease');
    });
  }

  // ------------------------------------------------------------------ events
  event(level: 'info' | 'warn' | 'error', kind: string, orderHash: string | null, detail: string): void {
    this.db.prepare('INSERT INTO events(ts, level, kind, order_hash, detail) VALUES(?, ?, ?, ?, ?)').run(this.now(), level, kind, orderHash, detail.slice(0, 1000));
  }
  recentEvents(limit = 100): Array<{ id: number; ts: number; level: string; kind: string; order_hash: string | null; detail: string }> {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as any;
  }

  // ------------------------------------------------------------------ orders
  /** Insert a newly seen payment. Idempotent: returns false if the hash was already known. */
  insertOrder(o: Pick<OrderRow, 'hash' | 'block_number' | 'block_hash' | 'tx_index' | 'buyer' | 'value' | 'chain_id' | 'input'>): boolean {
    const now = this.now();
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO orders(hash, block_number, block_hash, tx_index, buyer, value, chain_id, input, state, detected_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'detected', ?, ?)`,
      )
      .run(o.hash.toLowerCase(), o.block_number, o.block_hash, o.tx_index, o.buyer.toLowerCase(), o.value, o.chain_id, o.input, now, now);
    if (r.changes > 0) this.event('info', 'detected', o.hash.toLowerCase(), `block ${o.block_number} value ${o.value}`);
    return r.changes > 0;
  }

  getOrder(hash: string): OrderRow | null {
    return (this.db.prepare('SELECT * FROM orders WHERE hash = ?').get(hash.toLowerCase()) as unknown as OrderRow) ?? null;
  }

  ordersInState(state: OrderState, limit = 100): OrderRow[] {
    return this.db.prepare('SELECT * FROM orders WHERE state = ? ORDER BY block_number, tx_index LIMIT ?').all(state, limit) as unknown as OrderRow[];
  }

  recentOrders(limit = 50): OrderRow[] {
    return this.db.prepare('SELECT * FROM orders ORDER BY block_number DESC, tx_index DESC LIMIT ?').all(limit) as unknown as OrderRow[];
  }

  updateOrder(hash: string, patch: Partial<OrderRow>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => (patch as Record<string, unknown>)[k] as any);
    this.db.prepare(`UPDATE orders SET ${sets}, updated_at = ? WHERE hash = ?`).run(...vals, this.now(), hash.toLowerCase());
  }

  setOrderState(hash: string, state: OrderState, reason: string | null = null, extra: Partial<OrderRow> = {}): void {
    this.updateOrder(hash, { ...extra, state, reason });
    this.event(state === 'needs_review' || state === 'failed' ? 'warn' : 'info', state, hash.toLowerCase(), reason ?? '');
  }

  countOrdersSince(ts: number): number {
    const r = this.db.prepare("SELECT COUNT(*) c FROM orders WHERE state IN ('processing','fulfilled','failed') AND updated_at >= ?").get(ts) as { c: number };
    return r.c;
  }

  stateCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT state, COUNT(*) c FROM orders GROUP BY state').all() as Array<{ state: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.state, r.c]));
  }

  // ------------------------------------------------------------------ outbox
  /** Create an outbox item. Returns the existing one if (kind, order_hash) already exists. */
  enqueue(o: { kind: OutboxKind; order_hash: string | null; to_addr: string; value: bigint; data: Hex }): OutboxRow {
    const now = this.now();
    if (o.order_hash) {
      const existing = this.db.prepare('SELECT * FROM outbox WHERE kind = ? AND order_hash = ?').get(o.kind, o.order_hash.toLowerCase()) as unknown as OutboxRow | undefined;
      if (existing) return existing;
    }
    const r = this.db
      .prepare(`INSERT INTO outbox(kind, order_hash, to_addr, value, data, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .run(o.kind, o.order_hash?.toLowerCase() ?? null, o.to_addr.toLowerCase(), o.value.toString(), o.data, now, now);
    return this.getOutbox(Number(r.lastInsertRowid))!;
  }

  getOutbox(id: number): OutboxRow | null {
    return (this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as unknown as OutboxRow) ?? null;
  }
  /** The one item currently in flight (signed but not yet mined), if any. */
  inFlight(): OutboxRow | null {
    return (this.db.prepare("SELECT * FROM outbox WHERE status = 'signed' ORDER BY id LIMIT 1").get() as unknown as OutboxRow) ?? null;
  }
  nextQueued(): OutboxRow | null {
    return (this.db.prepare("SELECT * FROM outbox WHERE status = 'queued' ORDER BY id LIMIT 1").get() as unknown as OutboxRow) ?? null;
  }
  updateOutbox(id: number, patch: Partial<OutboxRow>): void {
    const keys = Object.keys(patch);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const vals = keys.map((k) => (patch as Record<string, unknown>)[k] as any);
    this.db.prepare(`UPDATE outbox SET ${sets}, updated_at = ? WHERE id = ?`).run(...vals, this.now(), id);
  }
  /** Sum of gas actually spent by mined seller transactions since ts. */
  gasSpentSince(ts: number): bigint {
    const rows = this.db.prepare("SELECT cost_wei FROM outbox WHERE status IN ('mined','failed') AND cost_wei IS NOT NULL AND updated_at >= ?").all(ts) as Array<{ cost_wei: string }>;
    return rows.reduce((a, r) => a + BigInt(r.cost_wei), 0n);
  }
  outboxByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) c FROM outbox GROUP BY status').all() as Array<{ status: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  // ------------------------------------------------------------------ attempts
  addAttempt(a: Omit<AttemptRow, 'id' | 'created_at' | 'broadcast_at'>): AttemptRow {
    const r = this.db
      .prepare('INSERT INTO attempts(outbox_id, tx_hash, raw, nonce, max_fee, priority_fee, gas_limit, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.outbox_id, a.tx_hash, a.raw, a.nonce, a.max_fee, a.priority_fee, a.gas_limit, this.now());
    return this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as AttemptRow;
  }
  attemptsFor(outboxId: number): AttemptRow[] {
    return this.db.prepare('SELECT * FROM attempts WHERE outbox_id = ? ORDER BY id').all(outboxId) as unknown as AttemptRow[];
  }
  markBroadcast(attemptId: number): void {
    this.db.prepare('UPDATE attempts SET broadcast_at = ? WHERE id = ? AND broadcast_at IS NULL').run(this.now(), attemptId);
  }

  // ------------------------------------------------------------------ llm usage
  llmUsage(day: string): { calls: number; failures: number; input_tokens: number; output_tokens: number } {
    return (this.db.prepare('SELECT calls, failures, input_tokens, output_tokens FROM llm_usage WHERE day = ?').get(day) as any) ?? { calls: 0, failures: 0, input_tokens: 0, output_tokens: 0 };
  }
  recordLlm(day: string, ok: boolean, inTok = 0, outTok = 0): void {
    this.db
      .prepare(
        `INSERT INTO llm_usage(day, calls, failures, input_tokens, output_tokens) VALUES(?, 1, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET calls = calls + 1, failures = failures + excluded.failures,
         input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(day, ok ? 0 : 1, inTok, outTok);
  }
}
