import { getAddress, type Address } from 'viem';
import { ENS_NAME, DECISION_BLOCK_OFFSET, DECISION_METHOD, ENCOURAGEMENT_TONES, LIMITS, PRICE_WEI, PROTOCOL_ID } from './constants.js';
import { CatalogSchema, type Catalog } from './schemas.js';

export const DEFAULT_SCHEMA_URL = 'https://raw.githubusercontent.com/kenashe/zerohuman/main/schemas/zh1.schema.json';
export const DEFAULT_DOCS_URL = 'https://github.com/kenashe/zerohuman/blob/main/docs/PROTOCOL.md';

/** Build the JSON value published in the ENS text record `com.zerohuman.services`. */
export function buildCatalog(p: {
  seller: Address;
  name?: string;
  chainId: number;
  status: Catalog['status'];
  confirmations: number;
  statusUrl?: string;
  schemaUrl?: string;
  docsUrl?: string;
}): Catalog {
  const catalog: Catalog = {
    v: PROTOCOL_ID,
    name: p.name ?? ENS_NAME,
    chainId: p.chainId,
    seller: getAddress(p.seller),
    services: {
      decision: { price: PRICE_WEI.toString(), offset: DECISION_BLOCK_OFFSET, method: DECISION_METHOD },
      encouragement: { price: PRICE_WEI.toString(), tones: [...ENCOURAGEMENT_TONES] },
    },
    schema: p.schemaUrl ?? DEFAULT_SCHEMA_URL,
    docs: p.docsUrl ?? DEFAULT_DOCS_URL,
    status: p.status,
    sla: { confirmations: p.confirmations, typicalSeconds: 180, maxSeconds: 3600 },
    maxRequestBytes: LIMITS.requestBytes,
    ...(p.statusUrl ? { statusUrl: p.statusUrl } : {}),
  };
  return CatalogSchema.parse(catalog);
}

export function parseCatalog(text: string): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('catalog record is not valid JSON');
  }
  return CatalogSchema.parse(raw);
}
