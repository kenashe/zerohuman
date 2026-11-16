import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttp } from '../../src/seller/http.js';
import { ERC8004_IDENTITY_REGISTRY } from '../../src/seller/agentdocs.js';
import { harness, type Harness } from '../helpers/setup.js';

describe('agent discovery documents (served by the worker)', () => {
  let h: Harness;
  let base: string;
  let server: ReturnType<typeof startHttp>;
  beforeAll(async () => {
    h = harness({ PUBLIC_BASE_URL: 'https://zh.example', ERC8004_AGENT_ID: '4242' });
    server = startHttp(h.engine, { port: 0, host: '127.0.0.1', dashboardDir: null });
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('ERC-8004 registration file has the required shape and the registry back-reference', async () => {
    const r = await fetch(`${base}/.well-known/agent-registration.json`);
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.type).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
    for (const k of ['name', 'description', 'image', 'services', 'active']) expect(d).toHaveProperty(k);
    expect(d.name).toBe('zerohuman.eth');
    expect(d.services).toContainEqual({ name: 'ENS', endpoint: 'zerohuman.eth', version: 'v1' });
    expect(d.services.find((s: any) => s.name === 'A2A').endpoint).toBe('https://zh.example/.well-known/agent-card.json');
    expect(d.registrations).toEqual([{ agentId: 4242, agentRegistry: `eip155:31337:${ERC8004_IDENTITY_REGISTRY}` }]);
    expect(d.x402Support).toBe(false);
  });

  it('A2A v1.0 agent card has every required field and a real interface', async () => {
    const d: any = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    for (const k of ['name', 'description', 'version', 'supportedInterfaces', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) expect(d).toHaveProperty(k);
    expect(d.supportedInterfaces[0]).toEqual({ url: 'https://zh.example/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' });
    for (const s of d.skills) for (const k of ['id', 'name', 'description', 'tags']) expect(s).toHaveProperty(k);
    expect(d).not.toHaveProperty('protocolVersion'); // v1.0 moved it into supportedInterfaces
  });

  it('llms.txt explains ordering and the icon is served', async () => {
    const t = await (await fetch(`${base}/llms.txt`)).text();
    expect(t).toMatch(/Send exactly 100000000000000 wei to zerohuman\.eth/);
    expect(t).toMatch(/ERC-8004: agent 4242/);
    const i = await fetch(`${base}/icon.svg`);
    expect(i.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('A2A SendMessage returns the catalog and ordering steps (v1.0 and v0.3 method names)', async () => {
    const call = (method: string) => fetch(`${base}/a2a/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { message: { role: 'ROLE_USER', parts: [{ text: 'how do I order?' }] } } }) }).then((r) => r.json() as Promise<any>);
    const v1 = await call('SendMessage');
    expect(v1.id).toBe(7);
    expect(v1.result.message.role).toBe('ROLE_AGENT');
    expect(v1.result.message.parts[0].text).toMatch(/How to order/);
    expect(v1.result.message.parts[1].data.catalog.seller).toBe(h.seller);
    const v03 = await call('message/send');
    expect(v03.result.kind).toBe('message');
    expect(v03.result.parts[1].data.catalog.services.decision.price).toBe('100000000000000');
  });

  it('A2A endpoint rejects unknown methods, bad JSON and oversized bodies; other routes stay read-only', async () => {
    const unknown: any = await (await fetch(`${base}/a2a/v1`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/cancel' }) })).json();
    expect(unknown.error.code).toBe(-32601);
    expect((await fetch(`${base}/a2a/v1`, { method: 'POST', body: '{not json' })).status).toBe(400);
    expect((await fetch(`${base}/a2a/v1`, { method: 'POST', body: 'x'.repeat(10_000) })).status).toBe(413);
    expect((await fetch(`${base}/api/status`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await fetch(`${base}/a2a/v1`, { method: 'PUT', body: '{}' })).status).toBe(405);
    expect(h.chain.sentRaw).toHaveLength(0);
  });
});
