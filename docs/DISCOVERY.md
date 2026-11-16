# How agents find ZeroHuman

Custom ENS text records are not searchable, so ZeroHuman publishes itself in the places agents and agent
indexers already look. Every one of these points back to the same identity: `zerohuman.eth`.

| Where | What it is | Served from |
|---|---|---|
| ENS | `addr(zerohuman.eth)` = seller wallet, text `com.zerohuman.services` = catalog, primary name of the wallet = `zerohuman.eth` | Ethereum mainnet |
| ERC-8004 Identity Registry | On-chain agent identity (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on mainnet). Its `agentURI` points to the registration file below | Ethereum mainnet |
| ENSIP-25 record | Text record on `zerohuman.eth` naming the ERC-8004 entry, so the name and the registry entry vouch for each other | Ethereum mainnet |
| `/.well-known/agent-registration.json` | ERC-8004 registration file; also proves control of the worker's domain | worker |
| `/.well-known/agent-card.json` | A2A v1.0 agent card, read by A2A registries | worker |
| `POST /a2a/v1` | Minimal A2A JSON-RPC endpoint (`SendMessage`): replies with the catalog and ordering steps. Free, stateless, cannot buy anything | worker |
| `/llms.txt` | Plain-text summary for language-model tools | worker |

### Payment wallet in the registry (`agentWallet`)

The registry stores a payment wallet per agent, which defaults to the owner. To point it at the service wallet:

1. In Railway, open the zerohuman service **Console** and run `node dist/cli/admin.js agent-wallet 56626`.
   It signs the registry's EIP-712 `AgentWalletSet` message with the service key (no transaction, no nonce
   used, key never printed) and prints `agentId`, `newWallet`, `deadline` and `signature`.
2. **Within about 4 minutes**, on the registry's Etherscan *Write as Proxy* page, call `setAgentWallet`
   with those four values from the **owner** (cold) wallet. The registry rejects signatures older than 5 minutes;
   if it expires, run the command again.

**Orders are never placed over HTTP.** The A2A endpoint only explains how to order; an order is an Ethereum
transaction to `zerohuman.eth`. If the worker's website is down, buyers can still discover and use ZeroHuman
entirely through ENS and Ethereum.

ZeroHuman does not use x402 (HTTP 402 + USDC), so x402 catalogues such as Coinbase Bazaar, Circle's marketplace
and x402scan do not list it.
