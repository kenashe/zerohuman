#!/usr/bin/env node
/**
 * zerohuman.eth identity tool. Read-only unless `primary-name --send` is used.
 *
 *   SELLER_ADDRESS=0x… RPC_URL=<mainnet> npm run ens -- plan
 *       Shows the current records of zerohuman.eth and the exact values to set so the
 *       name IS the seller: ETH address = seller, com.zerohuman.services = catalog.
 *   RPC_URL=<mainnet> npm run ens -- check
 *       Resolves the identity exactly like a buyer does and reports any mismatch.
 *   SELLER_ADDRESS=0x… RPC_URL=<mainnet> npm run ens -- primary-name
 *       Prints the transaction the SELLER wallet must send so explorers show it as
 *       zerohuman.eth (ENS reverse record / primary name).
 *   … primary-name --send   (needs SELLER_KEY_FILE and CONFIRM_SEND=zerohuman.eth)
 *
 * Record changes on zerohuman.eth itself are made by the NAME OWNER in the ENS app;
 * this tool never holds the owner key.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { buildCatalog } from '../protocol/catalog.js';
import { ENS_CATALOG_KEY, ENS_NAME } from '../protocol/constants.js';
import { resolveIdentity } from '../sdk/index.js';
import { die, out, parseArgs } from './args.js';

/** ENS ReverseRegistrar (mainnet). Still authoritative for addr.reverse after ENSv2 activation. */
export const REVERSE_REGISTRAR: Address = '0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb';
const reverseAbi = parseAbi(['function setName(string name) returns (bytes32)']);

const { _, flags } = parseArgs(process.argv.slice(2));
const cmd = _[0] ?? 'check';
const rpc = process.env.RPC_URL ?? die('RPC_URL (mainnet) is required');
const name = normalize(process.env.ENS_NAME ?? ENS_NAME);
const pc = createPublicClient({ chain: mainnet, transport: http(rpc) }) as PublicClient;
const sellerEnv = process.env.SELLER_ADDRESS;
const seller = (): Address => (sellerEnv && isAddress(sellerEnv) ? getAddress(sellerEnv) : die('SELLER_ADDRESS (new seller wallet) is required'));

if (cmd === 'plan') {
  const s = seller();
  const [addr, text, resolver, sellerPrimary] = await Promise.all([
    pc.getEnsAddress({ name }), pc.getEnsText({ name, key: ENS_CATALOG_KEY }), pc.getEnsResolver({ name }), pc.getEnsName({ address: s }).catch(() => null),
  ]);
  const catalog = JSON.stringify(buildCatalog({ seller: s, name, chainId: 1, status: (process.env.CATALOG_STATUS as 'allowlist') ?? 'allowlist', confirmations: Number(process.env.CONFIRMATIONS ?? 6), statusUrl: process.env.PUBLIC_STATUS_URL || undefined }));
  out({
    name, resolver,
    steps: [
      { who: 'name owner (ENS app)', record: 'ETH address', current: addr, target: s, change: addr?.toLowerCase() !== s.toLowerCase() },
      { who: 'name owner (ENS app)', record: `text ${ENS_CATALOG_KEY}`, current: text, target: catalog, change: text !== catalog },
      { who: 'seller wallet (npm run ens -- primary-name --send)', record: 'primary name of seller', current: sellerPrimary, target: name, change: sellerPrimary !== name, optional: true },
    ],
  });
} else if (cmd === 'check') {
  try {
    const id = await resolveIdentity(pc, name);
    out({ ok: true, ...id });
  } catch (e) {
    out({ ok: false, error: (e as Error).message, addr: await pc.getEnsAddress({ name }), catalog: await pc.getEnsText({ name, key: ENS_CATALOG_KEY }) });
    process.exit(3);
  }
} else if (cmd === 'primary-name') {
  const s = seller();
  const data = encodeFunctionData({ abi: reverseAbi, functionName: 'setName', args: [name] });
  const tx = { from: s, to: REVERSE_REGISTRAR, value: '0', data };
  const gas = await pc.estimateGas({ account: s, to: REVERSE_REGISTRAR, data }).catch((e) => `estimate failed: ${(e as Error).message.split('\n')[0]}`);
  if (!flags.send) {
    out({ dryRun: true, note: 'The seller wallet must send this transaction. Primary name only displays once addr(name) == seller.', tx, estimatedGas: gas?.toString() });
  } else {
    if (process.env.CONFIRM_SEND !== name) die(`set CONFIRM_SEND=${name} to send this mainnet transaction`);
    const key = readFileSync(process.env.SELLER_KEY_FILE ?? die('SELLER_KEY_FILE required'), 'utf8').trim() as Hex;
    const acct = privateKeyToAccount(key);
    if (acct.address !== s) die('SELLER_KEY_FILE does not match SELLER_ADDRESS');
    const w = createWalletClient({ account: acct, chain: mainnet, transport: http(rpc) });
    const hash = await w.sendTransaction({ to: REVERSE_REGISTRAR, data });
    const r = await pc.waitForTransactionReceipt({ hash });
    out({ hash, status: r.status, gasUsed: r.gasUsed, primaryNameNow: await pc.getEnsName({ address: s }).catch(() => null) });
  }
} else die('commands: plan | check | primary-name');
