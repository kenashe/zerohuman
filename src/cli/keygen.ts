#!/usr/bin/env node
/**
 * Generate a brand-new wallet locally (CSPRNG via viem/noble). Run this on a trusted machine,
 * NOT on a shared server. The private key is written once to a 0600 file and never printed
 * unless --print is passed.
 *
 *   npm run keygen -- --label seller --out ./wallets/seller.key
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { die, parseArgs } from './args.js';

const { flags } = parseArgs(process.argv.slice(2));
const label = typeof flags.label === 'string' ? flags.label : 'wallet';
const outPath = typeof flags.out === 'string' ? flags.out : `./wallets/${label}.key`;
if (existsSync(outPath)) die(`${outPath} already exists; refusing to overwrite a key`);
const pk = generatePrivateKey();
const addr = privateKeyToAccount(pk).address;
mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
writeFileSync(outPath, pk + '\n', { mode: 0o600, flag: 'wx' });
process.stdout.write(`label:   ${label}\naddress: ${addr}\nkey:     written to ${outPath} (mode 0600)\n`);
if (flags.print) process.stdout.write(`private: ${pk}\n`);
process.stdout.write('\nNext: paste the key into Railway as the SELLER_PRIVATE_KEY secret, then delete the file\nor move it to offline storage. Never commit it. ./wallets/ is git-ignored.\n');
