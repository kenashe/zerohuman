import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
const pc = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
const R = '0x6f6C3F5DcbD5Ba8d73711F9484755d23b50756C0';
const head = await pc.getBlockNumber();
const logs: any[] = [];
for (let from = 25_600_000n; from <= head; from += 50_000n) {
  const to = from + 49_999n > head ? head : from + 49_999n;
  try { logs.push(...await pc.getLogs({ address: R, fromBlock: from, toBlock: to })); } catch (e: any) { console.log('err', from.toString(), e.shortMessage); }
}
console.log('logs', logs.length);
for (const l of logs.slice(0, 40)) console.log(l.blockNumber.toString(), l.topics[0]?.slice(0,10), l.topics.slice(1).map((t: string) => '0x' + t.slice(-40)).join(' '), l.transactionHash);
