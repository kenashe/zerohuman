import { bytesToHex, hexToBytes, isHex, type Hex } from 'viem';
import { LIMITS, PROTOCOL_VERSION, type ErrorCode } from './constants.js';
import {
  RequestSchema,
  ResponseSchema,
  type ZhRequest,
  type ZhResponse,
} from './schemas.js';

/**
 * Wire format (zh/1): transaction input data is the raw UTF-8 bytes of a single JSON
 * object. No ABI encoding, no function selector, no compression. Anything that can
 * hex-decode a transaction's `input` field can read it.
 */

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export const encodeJson = (obj: unknown): Hex => bytesToHex(enc.encode(JSON.stringify(obj)));

export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; msg: string; svc?: string };

/** Returns true if input data is present at all (anything besides `0x`). */
export const hasData = (input: Hex | undefined | null): boolean => !!input && input !== '0x' && input.length > 2;

/** Parse raw tx input bytes into a JSON value, enforcing size and strict UTF-8. */
export function decodeJsonBytes(input: Hex, maxBytes: number): DecodeResult<unknown> {
  if (!isHex(input, { strict: true }) || input.length % 2 !== 0) return { ok: false, code: 'bad_json', msg: 'input is not valid hex' };
  const byteLen = (input.length - 2) / 2;
  if (byteLen > maxBytes) return { ok: false, code: 'too_large', msg: `payload is ${byteLen} bytes; limit is ${maxBytes}` };
  let text: string;
  try {
    text = dec.decode(hexToBytes(input));
  } catch {
    return { ok: false, code: 'bad_json', msg: 'payload is not valid UTF-8' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, code: 'bad_json', msg: 'payload is not valid JSON' };
  }
}

/** Decode + validate a buyer request. Never throws. */
export function decodeRequest(input: Hex): DecodeResult<ZhRequest> {
  const raw = decodeJsonBytes(input, LIMITS.requestBytes);
  if (!raw.ok) return raw;
  const v = raw.value;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, code: 'bad_json', msg: 'payload must be a JSON object' };
  const obj = v as Record<string, unknown>;
  const svc = typeof obj.svc === 'string' ? obj.svc.slice(0, 32) : undefined;
  if (obj.zh !== PROTOCOL_VERSION) return { ok: false, code: 'bad_version', msg: `expected "zh": ${PROTOCOL_VERSION}`, svc };
  if (svc !== 'decision' && svc !== 'encouragement') return { ok: false, code: 'unknown_service', msg: 'svc must be "decision" or "encouragement"', svc };
  const parsed = RequestSchema.safeParse(obj);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? first.path.join('.') + ': ' : '';
    return { ok: false, code: 'invalid_input', msg: (where + (first?.message ?? 'invalid')).slice(0, 160), svc };
  }
  return { ok: true, value: parsed.data };
}

/** Encode a request for submission, checking it against the schema and size limit first. */
export function encodeRequest(req: ZhRequest): Hex {
  const parsed = RequestSchema.parse(req);
  const hex = encodeJson(parsed);
  const bytes = (hex.length - 2) / 2;
  if (bytes > LIMITS.requestBytes) throw new Error(`request is ${bytes} bytes; limit is ${LIMITS.requestBytes}`);
  return hex;
}

/** Decode + validate a seller response (buyer side). Never throws. */
export function decodeResponse(input: Hex): DecodeResult<ZhResponse> {
  const raw = decodeJsonBytes(input, LIMITS.responseBytes);
  if (!raw.ok) return raw;
  const parsed = ResponseSchema.safeParse(raw.value);
  if (!parsed.success) return { ok: false, code: 'invalid_input', msg: 'not a valid zh/1 response' };
  return { ok: true, value: parsed.data };
}

/** Encode a response (seller side), enforcing schema and the response size ceiling. */
export function encodeResponse(res: ZhResponse): Hex {
  const parsed = ResponseSchema.parse(res);
  const hex = encodeJson(parsed);
  const bytes = (hex.length - 2) / 2;
  if (bytes > LIMITS.responseBytes) throw new Error(`response is ${bytes} bytes; limit is ${LIMITS.responseBytes}`);
  return hex;
}

/** Quick check used by watchers to find the response for an order without full validation. */
export const responseMentionsOrder = (input: Hex, orderTxHash: Hex): boolean =>
  input.toLowerCase().includes(bytesToHex(enc.encode(orderTxHash.toLowerCase())).slice(2));
