#!/usr/bin/env node
/**
 * zh-buyer — reference command-line buyer for ZeroHuman (zh/1).
 *
 *   RPC_URL=...  BUYER_PRIVATE_KEY=0x...  zh-buyer decision "option a" "option b" [--context "..."]
 *   RPC_URL=...  BUYER_PRIVATE_KEY=0x...  zh-buyer encourage "my task keeps failing" [--tone playful]
 *   RPC_URL=...                           zh-buyer catalog
 *   RPC_URL=...                           zh-buyer verify <orderTxHash> [--delivery <hash>]
 *
 * Optional: ENS_RPC_URL (mainnet RPC for ENS when RPC_URL is a testnet), ENS_NAME,
 * ZH_CATALOG_JSON (catalog override for testnets/devnets), DRY_RUN=1 (print the tx instead of sending).
 */
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { chainFor } from '../seller/chain.js';
import { decodeResponse, encodeRequest } from '../protocol/codec.js';
import { parseCatalog } from '../protocol/catalog.js';
import { decisionRequest, encouragementRequest, findDelivery, verifyDelivery, ZeroHumanBuyer, type Delivery } from '../sdk/index.js';
import type { ZhRequest } from '../protocol/schemas.js';
import { die, out, parseArgs } from './args.js';

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _.shift();
  const rpc = process.env.RPC_URL ?? die('RPC_URL is required');
  const probe = createPublicClient({ transport: http(rpc) });
  const chainId = await probe.getChainId();
  const chain = chainFor(chainId);
  const publicClient = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  const ensClient = createPublicClient({ chain: mainnet, transport: http(process.env.ENS_RPC_URL ?? rpc) }) as PublicClient;
  const catalog = process.env.ZH_CATALOG_JSON ? parseCatalog(process.env.ZH_CATALOG_JSON) : undefined;
  const key = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
  const walletClient = key ? createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpc) }) : undefined;
  const zh = new ZeroHumanBuyer({ publicClient, ensClient, walletClient, catalog, ensName: process.env.ENS_NAME });

  const run = async (req: ZhRequest) => {
    const cat = await zh.getCatalog();
    if (process.env.DRY_RUN) return out({ dryRun: true, to: cat.seller, valueWei: cat.services[req.svc].price, chainId: cat.chainId, data: encodeRequest(req), request: req });
    if (!walletClient) die('BUYER_PRIVATE_KEY is required to submit orders');
    const orderTxHash = await zh.submit(req);
    process.stderr.write(`order submitted: ${orderTxHash}\nwaiting for confirmation…\n`);
    await zh.waitForConfirmation(orderTxHash);
    process.stderr.write('confirmed; waiting for delivery…\n');
    const delivery = await zh.waitForDelivery(orderTxHash, { timeoutMs: Number(flags.timeout ?? 3_600_000) });
    const verification = await zh.verify(delivery);
    out({ orderTxHash, deliveryTxHash: delivery.deliveryTxHash, response: delivery.response, verified: verification.valid, problems: verification.problems });
    if (!verification.valid) process.exit(3);
  };

  switch (cmd) {
    case 'catalog':
      return out(await zh.getCatalog());
    case 'decision':
      if (_.length < 2) die('usage: zh-buyer decision <option> <option> [...up to 5] [--context text]');
      return run(decisionRequest(_, typeof flags.context === 'string' ? flags.context : undefined, typeof flags.ref === 'string' ? flags.ref : undefined));
    case 'encourage':
    case 'encouragement':
      if (_.length !== 1) die('usage: zh-buyer encourage "<obstacle>" [--tone supportive|playful]');
      return run(encouragementRequest(_[0]!, flags.tone === 'playful' ? 'playful' : flags.tone === 'supportive' ? 'supportive' : undefined));
    case 'verify': {
      const order = _[0] as Hex | undefined;
      if (!order) return die('usage: zh-buyer verify <orderTxHash> [--delivery <hash>]');
      const cat = await zh.getCatalog();
      let d: Delivery | null;
      if (typeof flags.delivery === 'string') {
        const tx = await publicClient.getTransaction({ hash: flags.delivery as Hex });
        const r = decodeResponse(tx.input);
        if (!r.ok) return die('delivery data is not a valid zh/1 response');
        d = { orderTxHash: order, deliveryTxHash: tx.hash, deliveryBlock: tx.blockNumber ?? 0n, response: r.value };
      } else d = await findDelivery(publicClient, order, cat.seller as Hex);
      if (!d) return die('no delivery found yet for this order');
      const v = await verifyDelivery(publicClient, d, cat.seller as Hex);
      out({ ...v, response: d.response });
      return process.exit(v.valid ? 0 : 3);
    }
    default:
      die('commands: catalog | decision | encourage | verify');
  }
}
main().catch((e) => die(`error: ${(e as Error).message}`));
