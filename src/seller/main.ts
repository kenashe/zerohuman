#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { LocalSigner, ViemChain } from './chain.js';
import { loadConfig, scrubSecretsFromEnv, ConfigError } from './config.js';
import { Engine } from './engine.js';
import { startHttp } from './http.js';
import { logger, registerSecret } from './log.js';
import { Store } from './store.js';
import { DeepSeekProvider } from '../services/llm/deepseek.js';
import { MockProvider } from '../services/llm/mock.js';
import type { TextProvider } from '../services/llm/provider.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      logger.error('configuration error', { error: e.message });
      process.exit(2);
    }
    throw e;
  }
  registerSecret(cfg.privateKey);
  registerSecret(cfg.llm.apiKey);
  scrubSecretsFromEnv();

  const signer = new LocalSigner(cfg.privateKey);
  // Drop our reference to the key string; only the signer closure keeps it.
  (cfg as { privateKey: string }).privateKey = '0x[REDACTED]';
  const chain = new ViemChain(cfg.rpcUrls, cfg.chainId);
  const store = new Store(cfg.databasePath);
  const provider: TextProvider | null =
    cfg.llm.provider === 'deepseek' ? new DeepSeekProvider({ apiKey: cfg.llm.apiKey!, model: cfg.llm.model, baseUrl: cfg.llm.baseUrl })
    : cfg.llm.provider === 'mock' ? new MockProvider()
    : null;
  const engine = new Engine({ cfg, store, chain, signer, provider });

  logger.info('zerohuman seller starting', {
    seller: signer.address,
    chainId: cfg.chainId,
    mode: cfg.allowlist ? `allowlist(${cfg.allowlist.size})` : 'PUBLIC',
    confirmations: cfg.confirmations,
    llm: provider?.name ?? 'none',
    instance: cfg.instanceId,
  });

  const server = cfg.http.enabled ? startHttp(engine, cfg.http) : null;
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal: sig });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (!stopping) {
    const started = Date.now();
    const rep = await engine.tick();
    if (rep.newOrders || rep.prepared || rep.sent || rep.reconciled === 'done' || rep.errors.length)
      logger.info('tick', { ...rep, scannedTo: rep.scannedTo?.toString() });
    const wait = Math.max(250, cfg.pollIntervalMs - (Date.now() - started));
    // Sleep in small slices so SIGTERM is honoured promptly.
    for (let t = 0; t < wait && !stopping; t += 250) await sleep(Math.min(250, wait - t));
  }
  store.releaseLease(cfg.instanceId);
  server?.close();
  store.close();
  logger.info('stopped cleanly');
}

main().catch((e) => {
  logger.error('fatal', { error: e });
  process.exit(1);
});
