import type { Address, PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../src/protocol/catalog.js';
import type { EnsView } from '../../src/seller/engine.js';
import { encouragementRequest, IdentityMismatchError, resolveIdentity } from '../../src/sdk/index.js';
import { harness } from '../helpers/setup.js';

/** A controllable fake of mainnet ENS for zerohuman.eth. */
class FakeEns implements EnsView {
  addr: Address | null = null;
  catalog: string | null = null;
  reverse: string | null = null;
  fail = false;
  async address() { if (this.fail) throw new Error('rpc down'); return this.addr; }
  async text() { if (this.fail) throw new Error('rpc down'); return this.catalog; }
  async primaryName() { return this.reverse; }
  // viem-client-shaped methods so the same fake drives the buyer SDK
  getEnsAddress = async () => this.addr;
  getEnsText = async () => this.catalog;
  getEnsName = async () => this.reverse;
}
const other = () => privateKeyToAccount(generatePrivateKey()).address;
const ENS_ON = { ENS_CHECK: 'true', ENS_RPC_URL: 'http://mainnet-ens', ENS_CHECK_INTERVAL_MS: '10000' };

describe('seller identity guard: addr(zerohuman.eth) must be this wallet', () => {
  it('signs nothing until the name resolves to the seller, then delivers', async () => {
    const ens = new FakeEns();
    const h = harness(ENS_ON, undefined, ens);
    const order = h.order(encouragementRequest('identity test'));
    await h.run(6);
    expect(h.chain.sentRaw).toHaveLength(0);
    expect(h.store.pauses().ens?.reason).toMatch(/no ETH address record/);
    // Owner points zerohuman.eth at the seller and publishes the catalog.
    ens.addr = h.seller;
    ens.catalog = JSON.stringify(buildCatalog({ seller: h.seller, chainId: 31337, status: 'allowlist', confirmations: 2 }));
    h.clock.t += 20_000;
    await h.run(6, () => h.store.getOrder(order)?.state === 'fulfilled');
    expect(h.store.getOrder(order)?.state).toBe('fulfilled');
    expect(h.store.pauses()).not.toHaveProperty('ens');
    expect(h.engine.identity).toMatchObject({ name: 'zerohuman.eth', ok: true });
  });

  it('pauses if the name is moved to another address, or the catalog disagrees', async () => {
    const ens = new FakeEns();
    const h = harness(ENS_ON, undefined, ens);
    ens.addr = other();
    ens.catalog = JSON.stringify(buildCatalog({ seller: h.seller, chainId: 31337, status: 'allowlist', confirmations: 2 }));
    await h.engine.checkEns(true);
    expect(h.store.pauses().ens?.reason).toMatch(/resolves to .* not this seller/);
    ens.addr = h.seller;
    ens.catalog = JSON.stringify(buildCatalog({ seller: other(), chainId: 31337, status: 'allowlist', confirmations: 2 }));
    await h.engine.checkEns(true);
    expect(h.store.pauses().ens?.reason).toMatch(/catalog seller/);
    ens.catalog = JSON.stringify(buildCatalog({ seller: h.seller, chainId: 1, status: 'allowlist', confirmations: 2 }));
    await h.engine.checkEns(true);
    expect(h.store.pauses().ens?.reason).toMatch(/chainId/);
  });

  it('an ENS RPC outage keeps the last verdict (does not unpause, does not crash)', async () => {
    const ens = new FakeEns();
    const h = harness(ENS_ON, undefined, ens);
    ens.fail = true;
    const rep = await h.engine.tick();
    expect(rep.errors.join()).toMatch(/ens/);
    expect(h.store.pauses()).toHaveProperty('ens');
  });
});

describe('buyer SDK: pay the name, trust only the name', () => {
  const pc = (e: FakeEns) => e as unknown as PublicClient;
  it('resolves zerohuman.eth → address and cross-checks the catalog', async () => {
    const e = new FakeEns();
    const seller = other();
    e.addr = seller;
    e.catalog = JSON.stringify(buildCatalog({ seller, chainId: 1, status: 'live', confirmations: 6 }));
    e.reverse = 'zerohuman.eth';
    const id = await resolveIdentity(pc(e));
    expect(id.address).toBe(seller);
    expect(id.primaryNameMatches).toBe(true);
  });
  it('refuses when the ETH address record and the catalog seller disagree', async () => {
    const e = new FakeEns();
    e.addr = other();
    e.catalog = JSON.stringify(buildCatalog({ seller: other(), chainId: 1, status: 'live', confirmations: 6 }));
    await expect(resolveIdentity(pc(e))).rejects.toBeInstanceOf(IdentityMismatchError);
  });
  it('refuses when the name has no ETH address', async () => {
    const e = new FakeEns();
    e.catalog = JSON.stringify(buildCatalog({ seller: other(), chainId: 1, status: 'live', confirmations: 6 }));
    await expect(resolveIdentity(pc(e))).rejects.toThrow(/no ETH address/);
  });
});

