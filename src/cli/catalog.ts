#!/usr/bin/env node
/**
 * Generate or check the ENS catalog record value.
 *
 *   SELLER_ADDRESS=0x... [CHAIN_ID=1] [CATALOG_STATUS=allowlist] [CONFIRMATIONS=6] [PUBLIC_STATUS_URL=...] npm run catalog -- print
 *   RPC_URL=<mainnet rpc> npm run catalog -- check     # read the live record via the ENS Universal Resolver
 *
 * `print` only prints. Publishing the record is a manual, owner-signed ENS transaction.
 */
import { createPublicClient, http, isAddress, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { buildCatalog } from '../protocol/catalog.js';
import { ENS_CATALOG_KEY, ENS_NAME } from '../protocol/constants.js';
import { readCatalog } from '../sdk/index.js';
import { die, out, parseArgs } from './args.js';

const { _ } = parseArgs(process.argv.slice(2));
const cmd = _[0] ?? 'print';
if (cmd === 'print') {
  const seller = process.env.SELLER_ADDRESS;
  if (!seller || !isAddress(seller)) die('SELLER_ADDRESS (the new seller wallet address) is required');
  const c = buildCatalog({
    seller: seller as Address,
    chainId: Number(process.env.CHAIN_ID ?? 1),
    status: (process.env.CATALOG_STATUS as 'allowlist') ?? 'allowlist',
    confirmations: Number(process.env.CONFIRMATIONS ?? 6),
    statusUrl: process.env.PUBLIC_STATUS_URL || undefined,
  });
  process.stderr.write(`Set this as the text record "${ENS_CATALOG_KEY}" on ${ENS_NAME} (value is the single line below):\n\n`);
  process.stdout.write(JSON.stringify(c) + '\n');
} else if (cmd === 'check') {
  const pc = createPublicClient({ chain: mainnet, transport: http(process.env.RPC_URL ?? die('RPC_URL (mainnet) required')) }) as PublicClient;
  const name = process.env.ENS_NAME ?? ENS_NAME;
  const resolver = await pc.getEnsResolver({ name: normalize(name) });
  const raw = await pc.getEnsText({ name: normalize(name), key: ENS_CATALOG_KEY });
  if (!raw) {
    out({ name, resolver, key: ENS_CATALOG_KEY, present: false });
  } else {
    try {
      out({ name, resolver, key: ENS_CATALOG_KEY, present: true, valid: true, catalog: await readCatalog(pc, name) });
    } catch (e) {
      out({ name, resolver, key: ENS_CATALOG_KEY, present: true, valid: false, error: (e as Error).message, raw });
    }
  }
} else die('commands: print | check');
