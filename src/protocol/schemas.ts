import { z } from 'zod';
import {
  DECISION_METHOD,
  ENCOURAGEMENT_TONES,
  ERROR_CODES,
  LIMITS,
  PROTOCOL_VERSION,
} from './constants.js';

const utf8 = new TextEncoder();
export const byteLength = (s: string): number => utf8.encode(s).length;

/**
 * Characters that are never allowed in protocol strings: C0/C1 controls (incl. newlines),
 * bidi overrides/isolates, zero-width and BOM characters. Keeps payloads single-line,
 * unambiguous, and safe to render on dashboards and in agent logs.
 */
// eslint-disable-next-line no-control-regex
export const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

/**
 * A canonical protocol string: already NFC-normalised, already trimmed, no forbidden
 * characters, non-empty, and within a UTF-8 byte budget. We REJECT non-canonical input
 * instead of silently normalising it, so the buyer and seller always agree on the exact
 * bytes that were hashed / echoed. The SDK canonicalises before sending.
 */
export const canonicalString = (maxBytes: number, label: string) =>
  z
    .string()
    .min(1)
    .max(maxBytes)
    .refine((s) => s === s.normalize('NFC'), { message: `${label} must be NFC-normalised` })
    .refine((s) => s === s.trim(), { message: `${label} must not have leading/trailing whitespace` })
    .refine((s) => !FORBIDDEN_CHARS.test(s), { message: `${label} contains forbidden control/format characters` })
    .refine((s) => byteLength(s) <= maxBytes, { message: `${label} exceeds ${maxBytes} UTF-8 bytes` })
    .meta({ description: `${label}: canonical UTF-8 string, 1..${maxBytes} bytes, NFC, trimmed, no control characters` });

/** Canonicalise a string the way the protocol expects (used by the SDK before sending). */
export const canonicalise = (s: string): string =>
  s.normalize('NFC').replace(new RegExp(FORBIDDEN_CHARS.source, 'gu'), ' ').replace(/\s+/gu, ' ').trim();

const ref = canonicalString(LIMITS.refMaxBytes, 'ref').optional();

// ---------------------------------------------------------------- requests

export const DecisionRequestSchema = z
  .strictObject({
    zh: z.literal(PROTOCOL_VERSION),
    svc: z.literal('decision'),
    opts: z
      .array(canonicalString(LIMITS.decisionOptionMaxBytes, 'option'))
      .min(LIMITS.decisionMinOptions)
      .max(LIMITS.decisionMaxOptions)
      .refine((a) => new Set(a).size === a.length, { message: 'options must be unique' }),
    ctx: canonicalString(LIMITS.decisionContextMaxBytes, 'context').optional(),
    ref,
  })
  .meta({ id: 'DecisionRequest', title: 'zh/1 Decision request (transaction input data)' });

export const EncouragementRequestSchema = z
  .strictObject({
    zh: z.literal(PROTOCOL_VERSION),
    svc: z.literal('encouragement'),
    msg: canonicalString(LIMITS.encouragementMessageMaxBytes, 'message'),
    tone: z.enum(ENCOURAGEMENT_TONES).optional(),
    ref,
  })
  .meta({ id: 'EncouragementRequest', title: 'zh/1 Encouragement request (transaction input data)' });

export const RequestSchema = z
  .discriminatedUnion('svc', [DecisionRequestSchema, EncouragementRequestSchema])
  .meta({ id: 'Request', title: 'zh/1 request' });

export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
export type EncouragementRequest = z.infer<typeof EncouragementRequestSchema>;
export type ZhRequest = z.infer<typeof RequestSchema>;

// ---------------------------------------------------------------- responses

const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'lowercase 0x-prefixed 32-byte hex');

export const DecisionProofSchema = z.strictObject({
  orderBlock: z.number().int().nonnegative().meta({ description: 'Block number that included the order transaction' }),
  offset: z.number().int().positive().meta({ description: 'Protocol block offset (5 in zh/1)' }),
  targetBlock: z.number().int().nonnegative().meta({ description: 'orderBlock + offset' }),
  targetBlockHash: hash32.meta({ description: 'Hash of targetBlock on the canonical chain' }),
  seed: hash32.meta({ description: 'keccak256(targetBlockHash ‖ orderTxHash)' }),
  n: z.number().int().min(LIMITS.decisionMinOptions).max(LIMITS.decisionMaxOptions),
});

export const DecisionResultSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  option: z.string(),
  method: z.literal(DECISION_METHOD),
  proof: DecisionProofSchema,
});

export const EncouragementResultSchema = z.strictObject({
  message: z.string().min(1).max(LIMITS.encouragementOutMessageMaxChars),
  nextStep: z.string().min(1).max(LIMITS.encouragementOutStepMaxChars),
  tone: z.enum(ENCOURAGEMENT_TONES),
  gen: z.enum(['llm', 'fallback']).meta({ description: 'Whether the text came from the model or the built-in fallback' }),
});

const okBase = { zh: z.literal(PROTOCOL_VERSION), re: hash32.meta({ description: 'Original order transaction hash' }), ok: z.literal(true) };

export const DecisionResponseSchema = z
  .strictObject({ ...okBase, svc: z.literal('decision'), out: DecisionResultSchema })
  .meta({ id: 'DecisionResponse', title: 'zh/1 Decision response (delivery transaction input data)' });

export const EncouragementResponseSchema = z
  .strictObject({ ...okBase, svc: z.literal('encouragement'), out: EncouragementResultSchema })
  .meta({ id: 'EncouragementResponse', title: 'zh/1 Encouragement response (delivery transaction input data)' });

export const ErrorResponseSchema = z
  .strictObject({
    zh: z.literal(PROTOCOL_VERSION),
    re: hash32,
    ok: z.literal(false),
    svc: z.string().max(32).optional(),
    err: z.strictObject({ code: z.enum(ERROR_CODES), msg: z.string().max(160) }),
  })
  .meta({ id: 'ErrorResponse', title: 'zh/1 error response' });

export const ResponseSchema = z
  .union([DecisionResponseSchema, EncouragementResponseSchema, ErrorResponseSchema])
  .meta({ id: 'Response', title: 'zh/1 response' });

export type DecisionProof = z.infer<typeof DecisionProofSchema>;
export type DecisionResult = z.infer<typeof DecisionResultSchema>;
export type EncouragementResult = z.infer<typeof EncouragementResultSchema>;
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
export type EncouragementResponse = z.infer<typeof EncouragementResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type ZhResponse = z.infer<typeof ResponseSchema>;

// ---------------------------------------------------------------- ENS catalog

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const weiString = z.string().regex(/^[1-9][0-9]*$/);

export const CatalogSchema = z
  .object({
    v: z.literal('zh/1'),
    chainId: z.number().int().positive(),
    seller: address.meta({ description: 'Seller payment wallet; send orders here and expect deliveries from here' }),
    services: z.object({
      decision: z.object({ price: weiString, offset: z.number().int().positive(), method: z.string() }).loose(),
      encouragement: z.object({ price: weiString, tones: z.array(z.string()) }).loose(),
    }),
    schema: z.string().url().meta({ description: 'URL of the machine-readable JSON Schemas' }),
    docs: z.string().url(),
    status: z.enum(['live', 'allowlist', 'paused', 'retired']),
    sla: z
      .object({ confirmations: z.number().int().nonnegative(), typicalSeconds: z.number().int().positive(), maxSeconds: z.number().int().positive() })
      .loose(),
    maxRequestBytes: z.number().int().positive(),
    statusUrl: z.string().url().optional(),
  })
  .loose()
  .meta({ id: 'Catalog', title: 'zh/1 service catalog (ENS text record com.zerohuman.services)' });

export type Catalog = z.infer<typeof CatalogSchema>;
