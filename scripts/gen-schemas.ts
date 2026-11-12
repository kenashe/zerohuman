/** Generate JSON Schema files from the zod protocol schemas. `npm run schemas` */
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import * as S from '../src/protocol/schemas.js';
import { LIMITS, PRICE_WEI, DECISION_BLOCK_OFFSET, DECISION_METHOD } from '../src/protocol/constants.js';

export function generate(): Record<string, unknown> {
  const one = (schema: z.ZodType, id: string, extra: Record<string, unknown> = {}) => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://raw.githubusercontent.com/kenashe/zerohuman/main/schemas/${id}.schema.json`,
    ...(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'output' }) as object),
    ...extra,
  });
  const note = {
    'x-zh-encoding': 'Transaction input data = raw UTF-8 bytes of one JSON object (no ABI encoding).',
    'x-zh-limits': LIMITS,
    'x-zh-price-wei': PRICE_WEI.toString(),
    'x-zh-string-rules': 'All strings must already be NFC-normalised, trimmed, contain no C0/C1 control, bidi-override, zero-width or BOM characters, and fit the UTF-8 byte limit. Non-canonical strings are rejected, not normalised.',
  };
  const decisionReq = one(S.DecisionRequestSchema, 'decision-request', note) as any;
  decisionReq.$defs.DecisionRequest.properties.opts.uniqueItems = true;
  return {
    'decision-request': decisionReq,
    'encouragement-request': one(S.EncouragementRequestSchema, 'encouragement-request', note),
    'decision-response': one(S.DecisionResponseSchema, 'decision-response', { 'x-zh-algorithm': { method: DECISION_METHOD, offset: DECISION_BLOCK_OFFSET, seed: 'keccak256(blockhash(orderBlock + offset) ‖ orderTxHash)', index: 'uint256(seed) mod n' } }),
    'encouragement-response': one(S.EncouragementResponseSchema, 'encouragement-response'),
    'error-response': one(S.ErrorResponseSchema, 'error-response'),
    catalog: one(S.CatalogSchema, 'catalog', { 'x-zh-ens': { name: 'zerohuman.eth', key: 'com.zerohuman.services' } }),
  };
}

if (process.argv[1]?.endsWith('gen-schemas.ts')) {
  mkdirSync('schemas', { recursive: true });
  const all = generate();
  for (const [name, schema] of Object.entries(all)) writeFileSync(`schemas/${name}.schema.json`, JSON.stringify(schema, null, 2) + '\n');
  writeFileSync('schemas/zh1.schema.json', JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://raw.githubusercontent.com/kenashe/zerohuman/main/schemas/zh1.schema.json', title: 'ZeroHuman zh/1 protocol schemas', $defs: all }, null, 2) + '\n');
  console.log('wrote', Object.keys(all).length + 1, 'schema files');
}
