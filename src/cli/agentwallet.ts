/**
 * ERC-8004 agentWallet helper.
 *
 * The Identity Registry only lets an agent's owner set its payment wallet ("agentWallet") if the
 * NEW wallet signs an EIP-712 AgentWalletSet message, valid for at most 5 minutes. This module
 * builds and signs that message with the seller key, and prints only public values: the
 * signature, the deadline and ready-to-paste Etherscan inputs. The private key is never printed.
 */
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

export const ERC8004_IDENTITY_REGISTRY: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const registryAbi = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function getAgentWallet(uint256) view returns (address)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
]);
/** Registry limit is 5 minutes; leave a margin for the operator to paste and sign. */
export const DEADLINE_SECONDS = 270;

export async function signAgentWallet(p: {
  privateKey: Hex;
  agentId: bigint;
  owner: Address;
  chainId: number;
  registry?: Address;
  nowSeconds: bigint;
}) {
  const account = privateKeyToAccount(p.privateKey);
  const registry = p.registry ?? ERC8004_IDENTITY_REGISTRY;
  const deadline = p.nowSeconds + BigInt(DEADLINE_SECONDS);
  const signature = await account.signTypedData({
    domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: p.chainId, verifyingContract: registry },
    types: { AgentWalletSet: [{ name: 'agentId', type: 'uint256' }, { name: 'newWallet', type: 'address' }, { name: 'owner', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'AgentWalletSet',
    message: { agentId: p.agentId, newWallet: account.address, owner: getAddress(p.owner), deadline },
  });
  const calldata = encodeFunctionData({ abi: registryAbi, functionName: 'setAgentWallet', args: [p.agentId, account.address, deadline, signature] });
  return { newWallet: account.address, deadline, signature, calldata, registry };
}

/** CLI entry: zh-admin agent-wallet <agentId>. Needs SELLER_PRIVATE_KEY and RPC_URL (mainnet). */
export async function agentWalletCli(agentIdArg: string | undefined, env: Record<string, string | undefined>) {
  if (!agentIdArg || !/^[0-9]+$/.test(agentIdArg)) throw new Error('usage: zh-admin agent-wallet <agentId>');
  const key = env.SELLER_PRIVATE_KEY as Hex | undefined;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('SELLER_PRIVATE_KEY is not available in this environment');
  const rpc = (env.RPC_URL ?? '').split(',')[0]?.trim();
  if (!rpc) throw new Error('RPC_URL is required');
  const pc = createPublicClient({ chain: mainnet, transport: http(rpc) }) as PublicClient;
  const chainId = await pc.getChainId();
  const agentId = BigInt(agentIdArg);
  const [owner, current, block] = await Promise.all([
    pc.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: registryAbi, functionName: 'ownerOf', args: [agentId] }),
    pc.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: registryAbi, functionName: 'getAgentWallet', args: [agentId] }),
    pc.getBlock(),
  ]);
  const s = await signAgentWallet({ privateKey: key, agentId, owner, chainId, nowSeconds: block.timestamp });
  const expires = new Date(Number(s.deadline) * 1000);
  return {
    note: `Submit within ${Math.floor(DEADLINE_SECONDS / 60)} minutes (expires ${expires.toISOString()}). Send from the agent OWNER wallet, not the service wallet.`,
    registry: s.registry,
    etherscan: `https://etherscan.io/address/${s.registry}#writeProxyContract`,
    function: 'setAgentWallet (0x...) — fields below, in order',
    agentId: agentId.toString(),
    newWallet: s.newWallet,
    deadline: s.deadline.toString(),
    signature: s.signature,
    owner,
    currentAgentWallet: current,
    rawCalldata: s.calldata,
  };
}
