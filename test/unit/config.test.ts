import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { loadConfig, PUBLIC_APPROVAL_PHRASE, scrubSecretsFromEnv } from '../../src/seller/config.js';
import { log, registerSecret, setLogSink } from '../../src/seller/log.js';
import { buildCatalog, parseCatalog } from '../../src/protocol/catalog.js';

const base = () => ({ RPC_URL: 'https://rpc.example', SELLER_PRIVATE_KEY: generatePrivateKey(), DEEPSEEK_API_KEY: 'sk-abcdefgh12345' });

describe('config', () => {
  it('defaults to mainnet, allowlist mode with nobody allowed, 6 confirmations', () => {
    const c = loadConfig(base());
    expect(c.chainId).toBe(1);
    expect(c.allowlist?.size).toBe(0);
    expect(c.confirmations).toBe(6);
    expect(c.gas.maxDeliveryCostWei).toBe(75_000_000_000_000n);
    expect(c.llm.model).toBe('deepseek-flash');
  });
  it('requires the exact approval phrase to accept public buyers', () => {
    expect(loadConfig({ ...base(), PUBLIC_BUYERS: 'true' }).allowlist).not.toBeNull();
    expect(loadConfig({ ...base(), PUBLIC_BUYERS: PUBLIC_APPROVAL_PHRASE }).allowlist).toBeNull();
  });
  it('rejects invalid keys, addresses and mock LLM on mainnet', () => {
    expect(() => loadConfig({ ...base(), SELLER_PRIVATE_KEY: '0x1234' })).toThrow(/SELLER_PRIVATE_KEY/);
    expect(() => loadConfig({ ...base(), BUYER_ALLOWLIST: '0xnope' })).toThrow(/BUYER_ALLOWLIST/);
    expect(() => loadConfig({ ...base(), LLM_PROVIDER: 'mock' })).toThrow(/mainnet/);
    expect(() => loadConfig({ ...base(), DEEPSEEK_API_KEY: '' })).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => loadConfig({ ...base(), RPC_URL: 'ws://x' })).toThrow(/RPC_URL/);
  });
  it('scrubs secrets from env after load', () => {
    const env: Record<string, string | undefined> = base();
    loadConfig(env);
    scrubSecretsFromEnv(env);
    expect(env.SELLER_PRIVATE_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });
});

describe('logger', () => {
  it('redacts registered secrets and secret-looking keys', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    const key = generatePrivateKey();
    registerSecret(key);
    log('error', `boom ${key}`, { privateKey: key, nested: { note: `x${key.slice(2)}y` }, apiKey: 'sk-1' });
    const out = lines.join('\n');
    expect(out).not.toContain(key.slice(2));
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-1');
  });
});

describe('catalog', () => {
  it('builds a valid catalog with exact prices and parses it back', () => {
    const c = buildCatalog({ seller: '0x000000000000000000000000000000000000dEaD', chainId: 1, status: 'allowlist', confirmations: 6 });
    expect(c.services.decision.price).toBe('100000000000000');
    expect(c.services.encouragement.price).toBe('100000000000000');
    const text = JSON.stringify(c);
    expect(parseCatalog(text)).toEqual(c);
    expect(text.length).toBeLessThan(800);
  });
  it('rejects malformed catalogs', () => {
    expect(() => parseCatalog('{"v":"zh/2"}')).toThrow();
    expect(() => parseCatalog('not json')).toThrow();
  });
});
