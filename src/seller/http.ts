import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRICE_WEI, PROTOCOL_ID, DECISION_BLOCK_OFFSET, DECISION_METHOD } from '../protocol/constants.js';
import type { Engine } from './engine.js';
import { buildCatalog } from '../protocol/catalog.js';
import { agentCard, agentRegistration, handleA2a, ICON_SVG, llmsTxt, type DocsContext } from './agentdocs.js';

const MAX_A2A_BODY = 4096;

/**
 * Read-only HTTP surface: fixed routes, no query parameters are interpreted, nothing here
 * can reach the signer. GET only, except POST /a2a/v1 (stateless A2A "how to order" replies,
 * body capped at 4 KB). Exposes the data
 * the public dashboard needs (all of which is already public on-chain).
 */
export function publicOrders(engine: Engine, limit = 50) {
  return engine.store.recentOrders(limit).map((o) => ({
    order: o.hash,
    block: o.block_number,
    buyer: o.buyer,
    valueWei: o.value,
    service: o.service,
    state: o.state,
    reason: o.reason,
    outcome: o.outcome,
    delivery: o.delivery_tx,
    gasCostWei: o.gas_cost_wei,
    result: o.result_json ? JSON.parse(o.result_json) : null,
    request: o.request_json ? JSON.parse(o.request_json) : null,
    refund: o.refund_status === 'none' ? null : { status: o.refund_status, tx: o.refund_tx },
    detectedAt: new Date(o.detected_at).toISOString(),
    fulfilledAt: o.fulfilled_at ? new Date(o.fulfilled_at).toISOString() : null,
  }));
}

export function publicStatus(engine: Engine) {
  const s = engine.status();
  return {
    protocol: PROTOCOL_ID,
    // The git commit this deployment was built from (Railway sets RAILWAY_GIT_COMMIT_SHA).
    version: (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? '').slice(0, 7) || null,
    services: [
      { id: 'decision', priceWei: PRICE_WEI.toString(), method: DECISION_METHOD, blockOffset: DECISION_BLOCK_OFFSET },
      { id: 'encouragement', priceWei: PRICE_WEI.toString(), tones: ['supportive', 'playful'] },
    ],
    ...s,
  };
}

export function startHttp(engine: Engine, opts: { port: number; host: string; dashboardDir: string | null }): Server {
  const dashPath = opts.dashboardDir ? resolve(opts.dashboardDir, 'index.html') : null;
  const dashboard = dashPath && existsSync(dashPath) ? readFileSync(dashPath) : null;
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  };
  const ctx = (): DocsContext => ({ baseUrl: engine.cfg.publicBaseUrl, seller: engine.seller, chainId: engine.cfg.chainId, agentId: engine.cfg.erc8004AgentId, ensName: engine.cfg.ens.name });
  const catalog = () => buildCatalog({ seller: engine.seller, name: engine.cfg.ens.name, chainId: engine.cfg.chainId, status: engine.cfg.allowlist ? 'allowlist' : 'live', confirmations: engine.cfg.confirmations });
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    };
    if (req.method === 'POST' && path === '/a2a/v1') {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_A2A_BODY) {
          json(413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request too large' } });
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (size > MAX_A2A_BODY) return;
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        }
        try {
          const r = handleA2a(body, ctx(), catalog());
          json(r.status, r.body);
        } catch {
          json(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
        }
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      if (path === '/health') {
        const s = engine.status();
        return json(s.healthy ? 200 : 503, { ok: s.healthy, lastTickAt: s.lastTickAt, paused: s.paused });
      }
      if (path === '/api/status') return json(200, publicStatus(engine));
      if (path === '/.well-known/agent-registration.json') return json(200, agentRegistration(ctx()));
      if (path === '/.well-known/agent-card.json' || path === '/.well-known/agent.json') return json(200, agentCard(ctx()));
      if (path === '/llms.txt') {
        res.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
        return res.end(llmsTxt(ctx()));
      }
      if (path === '/icon.svg') {
        res.writeHead(200, { ...headers, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
        return res.end(ICON_SVG);
      }
      if (path === '/api/orders') return json(200, { orders: publicOrders(engine) });
      if ((path === '/' || path === '/index.html') && dashboard) {
        res.writeHead(200, {
          ...headers,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://esm.sh; connect-src *; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
        });
        return res.end(dashboard);
      }
      json(404, { error: 'not found' });
    } catch {
      json(500, { error: 'internal' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.listen(opts.port, opts.host);
  return server;
}

