import { decodeFunctionData, recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { DEADLINE_SECONDS, ERC8004_IDENTITY_REGISTRY, registryAbi, signAgentWallet } from '../../src/cli/agentwallet.js';

describe('ERC-8004 agentWallet signature', () => {
  it('is an EIP-712 AgentWalletSet signed by the new wallet, within the 5-minute limit', async () => {
    const key = generatePrivateKey();
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const now = 1_800_000_000n;
    const s = await signAgentWallet({ privateKey: key, agentId: 56626n, owner, chainId: 1, nowSeconds: now });
    expect(s.newWallet).toBe(privateKeyToAccount(key).address);
    expect(s.deadline - now).toBe(BigInt(DEADLINE_SECONDS));
    expect(DEADLINE_SECONDS).toBeLessThan(300);
    const signer = await recoverTypedDataAddress({
      domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: 1, verifyingContract: ERC8004_IDENTITY_REGISTRY },
      types: { AgentWalletSet: [{ name: 'agentId', type: 'uint256' }, { name: 'newWallet', type: 'address' }, { name: 'owner', type: 'address' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'AgentWalletSet',
      message: { agentId: 56626n, newWallet: s.newWallet, owner, deadline: s.deadline },
      signature: s.signature,
    });
    expect(signer).toBe(s.newWallet);
    const call = decodeFunctionData({ abi: registryAbi, data: s.calldata });
    expect(call.functionName).toBe('setAgentWallet');
    expect(call.args).toEqual([56626n, s.newWallet, s.deadline, s.signature]);
  });
});
