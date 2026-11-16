/**
 * Machine-readable discovery documents served by the worker (all read-only, all public):
 *
 *   /.well-known/agent-registration.json  ERC-8004 registration file (also the agentURI target)
 *   /.well-known/agent-card.json          A2A v1.0 agent card
 *   /llms.txt                             plain-text summary for language-model tools
 *   POST /a2a/v1                          minimal A2A JSON-RPC endpoint: answers "how do I order?"
 *
 * Nothing here can sign, pay, or change state. Orders are never placed over HTTP: an agent
 * orders by sending an Ethereum transaction to zerohuman.eth (see docs/PROTOCOL.md).
 */
import { DECISION_BLOCK_OFFSET, DECISION_METHOD, ENS_CATALOG_KEY, ENS_NAME, LIMITS, PRICE_WEI, PROTOCOL_ID } from '../protocol/constants.js';

export const REPO_URL = 'https://github.com/kenashe/zerohuman';
export const DOCS_URL = `${REPO_URL}/blob/main/docs/PROTOCOL.md`;
export const BUYER_GUIDE_URL = `${REPO_URL}/blob/main/docs/BUYER-GUIDE.md`;
export const SCHEMA_URL = 'https://raw.githubusercontent.com/kenashe/zerohuman/main/schemas/zh1.schema.json';
/** ERC-8004 Identity Registry on Ethereum mainnet (same address on every chain). */
export const ERC8004_IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

export interface DocsContext {
  baseUrl: string | null; // e.g. https://zerohuman-production.up.railway.app
  seller: string;
  chainId: number;
  agentId: string | null; // ERC-8004 agentId once registered
  ensName?: string;
}

const DESCRIPTION =
  'ZeroHuman sells two small services to autonomous AI agents for exactly 0.0001 ETH each, paid by an ' +
  'Ethereum mainnet transaction to the ENS name zerohuman.eth with the request as UTF-8 JSON in the ' +
  'transaction data. The result comes back as a zero-value transaction from zerohuman.eth. ' +
  'decision: picks one of 2-5 options from a future block hash, with a proof anyone can recompute (no LLM). ' +
  'encouragement: a short supportive message and one practical next step for an agent that is stuck. ' +
  `Service catalog: ENS text record ${ENS_CATALOG_KEY} on zerohuman.eth. Everything on-chain is public; ` +
  'never send secrets. No escrow; refunds are best effort.';

export function agentRegistration(c: DocsContext) {
  const name = c.ensName ?? ENS_NAME;
  const services: Array<Record<string, string>> = [
    { name: 'ENS', endpoint: name, version: 'v1' },
    { name: 'ZeroHuman', endpoint: name, version: PROTOCOL_ID },
    { name: 'wallet', endpoint: `eip155:${c.chainId}:${c.seller}` },
    { name: 'docs', endpoint: DOCS_URL },
  ];
  if (c.baseUrl) {
    services.push({ name: 'A2A', endpoint: `${c.baseUrl}/.well-known/agent-card.json`, version: '1.0' });
    services.push({ name: 'web', endpoint: c.baseUrl });
  }
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name,
    description: DESCRIPTION,
    image: c.baseUrl ? `${c.baseUrl}/icon.svg` : `${REPO_URL}`,
    services,
    x402Support: false,
    active: true,
    registrations: c.agentId ? [{ agentId: Number(c.agentId), agentRegistry: `eip155:${c.chainId}:${ERC8004_IDENTITY_REGISTRY}` }] : [],
  };
}

export function agentCard(c: DocsContext) {
  const name = c.ensName ?? ENS_NAME;
  const howTo = `Pay ${name} exactly ${PRICE_WEI} wei on chain ${c.chainId}; put the request JSON in the transaction data.`;
  return {
    name,
    description: DESCRIPTION,
    version: '1.0.0',
    documentationUrl: DOCS_URL,
    ...(c.baseUrl ? { iconUrl: `${c.baseUrl}/icon.svg` } : {}),
    provider: { organization: 'Ken Ashe', url: REPO_URL },
    supportedInterfaces: c.baseUrl ? [{ url: `${c.baseUrl}/a2a/v1`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] : [],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        id: 'how-to-order',
        name: 'How to order (free, over A2A)',
        description: 'Answers questions about ZeroHuman over this endpoint: returns the live service catalog, prices, the seller identity, and exact ordering steps. Free; nothing is purchased here.',
        tags: ['catalog', 'discovery', 'ethereum', 'ens'],
        examples: ['how do I order a decision?', 'what does it cost?', 'catalog'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain', 'application/json'],
      },
      {
        id: 'decision',
        name: 'Decision (0.0001 ETH, ordered on-chain)',
        description: `Choose one of 2-5 options uniformly at random from a future block hash (${DECISION_METHOD}, target = order block + ${DECISION_BLOCK_OFFSET}), with a verifiable proof. No LLM. Ordered by an Ethereum transaction, not over A2A. ${howTo} Example data: {"zh":1,"svc":"decision","opts":["retry now","back off 30s","escalate"]}`,
        tags: ['decision', 'randomness', 'verifiable', 'ethereum', 'paid'],
        examples: ['{"zh":1,"svc":"decision","opts":["ship it","add tests first"]}'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'encouragement',
        name: 'Encouragement (0.0001 ETH, ordered on-chain)',
        description: `A short encouraging message and one practical next step for an agent's obstacle (up to ${LIMITS.encouragementMessageMaxBytes} bytes). Ordered by an Ethereum transaction, not over A2A. ${howTo} Example data: {"zh":1,"svc":"encouragement","msg":"my tool call keeps timing out","tone":"playful"}`,
        tags: ['encouragement', 'agents', 'ethereum', 'paid'],
        examples: ['{"zh":1,"svc":"encouragement","msg":"my scraper hits rate limits"}'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
  };
}

export function llmsTxt(c: DocsContext): string {
  const name = c.ensName ?? ENS_NAME;
  return `# ZeroHuman (${name})

> Two small services for autonomous AI agents, 0.0001 ETH each, discovered through ENS and settled on Ethereum mainnet. Pay the ENS name; the result comes back in a transaction from the name.

## How to order
1. Resolve ${name} (any ENSv2-ready client) and read its text record \`${ENS_CATALOG_KEY}\`. Refuse to pay if the catalog's \`seller\` differs from the name's ETH address.
2. Send exactly ${PRICE_WEI} wei to ${name} on chain ${c.chainId}, from a plain account (no contract code), with the request as UTF-8 JSON in the transaction data (max ${LIMITS.requestBytes} bytes).
   - Decision: {"zh":1,"svc":"decision","opts":["a","b","c"]}  (2-5 options; no links or addresses)
   - Encouragement: {"zh":1,"svc":"encouragement","msg":"what is blocking you","tone":"supportive"}
3. Your order id is your transaction hash. Watch for a zero-value transaction from ${name} to you whose data is JSON with "re" equal to your order hash.
4. Decision proof: index = uint256(keccak256(blockhash(orderBlock + ${DECISION_BLOCK_OFFSET}) || orderTxHash)) mod n.

## Rules
- Everything on-chain is public. Never send secrets.
- Low-stakes choices only: block builders can influence the decision randomness.
- No escrow. Refunds are best effort and operator-approved; underpayments are kept as tips.

## Links
- Protocol: ${DOCS_URL}
- Buyer guide (SDK, CLI, no-SDK example): ${BUYER_GUIDE_URL}
- JSON Schemas: ${SCHEMA_URL}
- Source: ${REPO_URL}
${c.baseUrl ? `- Status: ${c.baseUrl}/api/status\n- A2A card: ${c.baseUrl}/.well-known/agent-card.json\n` : ''}${c.agentId ? `- ERC-8004: agent ${c.agentId} on eip155:${c.chainId}:${ERC8004_IDENTITY_REGISTRY}\n` : ''}`;
}

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="#0b0d0c"/><text x="128" y="160" font-family="monospace" font-size="96" font-weight="700" text-anchor="middle" fill="#5cf2a5">0H</text></svg>`;

/**
 * Minimal A2A JSON-RPC handler. Accepts SendMessage (v1.0) and message/send (v0.3) and replies
 * with one text message: the catalog and ordering steps. Stateless; never reads anything but
 * the method name and request id from the caller.
 */
export function handleA2a(body: unknown, c: DocsContext, catalogJson: unknown): { status: number; body: unknown } {
  const req = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
  const method = req.method;
  if (req.jsonrpc !== '2.0' || typeof method !== 'string')
    return { status: 400, body: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } } };
  if (method !== 'SendMessage' && method !== 'message/send')
    return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found. This endpoint supports SendMessage only; orders are placed on Ethereum.' } } };
  const text = llmsTxt(c);
  const messageId = `zh-${Date.now().toString(36)}`;
  const parts = [{ text }, { data: { catalog: catalogJson } }];
  if (method === 'message/send') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { kind: 'message', role: 'agent', messageId, parts: [{ kind: 'text', text }, { kind: 'data', data: { catalog: catalogJson } }] } } };
  }
  return { status: 200, body: { jsonrpc: '2.0', id, result: { message: { messageId, role: 'ROLE_AGENT', parts } } } };
}
