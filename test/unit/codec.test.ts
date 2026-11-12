import { bytesToHex, stringToHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeRequest, decodeResponse, encodeRequest, encodeResponse, responseMentionsOrder } from '../../src/protocol/codec.js';
import { LIMITS } from '../../src/protocol/constants.js';
import { decisionRequest, encouragementRequest } from '../../src/sdk/index.js';

const j = (o: unknown) => stringToHex(JSON.stringify(o));
const H = ('0x' + 'ab'.repeat(32)) as Hex;

describe('request codec', () => {
  it('round-trips a decision request', () => {
    const req = decisionRequest(['ship now', 'wait a day'], 'release timing', 'r1');
    const d = decodeRequest(encodeRequest(req));
    expect(d).toEqual({ ok: true, value: req });
  });
  it('round-trips an encouragement request', () => {
    const req = encouragementRequest('  my build keeps timing out\n after 3 retries ', 'playful');
    expect(req.msg).toBe('my build keeps timing out after 3 retries');
    expect(decodeRequest(encodeRequest(req))).toEqual({ ok: true, value: req });
  });

  const bad: Array<[string, unknown, string]> = [
    ['one option', { zh: 1, svc: 'decision', opts: ['a'] }, 'invalid_input'],
    ['six options', { zh: 1, svc: 'decision', opts: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'invalid_input'],
    ['empty option', { zh: 1, svc: 'decision', opts: ['a', ''] }, 'invalid_input'],
    ['duplicate options', { zh: 1, svc: 'decision', opts: ['a', 'a'] }, 'invalid_input'],
    ['untrimmed option', { zh: 1, svc: 'decision', opts: ['a', ' b'] }, 'invalid_input'],
    ['newline in option', { zh: 1, svc: 'decision', opts: ['a', 'b\nc'] }, 'invalid_input'],
    ['bidi override', { zh: 1, svc: 'decision', opts: ['a', 'b\u202ec'] }, 'invalid_input'],
    ['zero-width', { zh: 1, svc: 'decision', opts: ['a', 'b\u200bc'] }, 'invalid_input'],
    ['non-NFC', { zh: 1, svc: 'decision', opts: ['a', 'e\u0301'] }, 'invalid_input'],
    ['option too long', { zh: 1, svc: 'decision', opts: ['a', 'x'.repeat(LIMITS.decisionOptionMaxBytes + 1)] }, 'invalid_input'],
    ['multibyte option too long', { zh: 1, svc: 'decision', opts: ['a', '😀'.repeat(25)] }, 'invalid_input'],
    ['options not array', { zh: 1, svc: 'decision', opts: 'a,b' }, 'invalid_input'],
    ['non-string option', { zh: 1, svc: 'decision', opts: ['a', 2] }, 'invalid_input'],
    ['unknown key', { zh: 1, svc: 'decision', opts: ['a', 'b'], pay: '0x1' }, 'invalid_input'],
    ['context too long', { zh: 1, svc: 'decision', opts: ['a', 'b'], ctx: 'c'.repeat(161) }, 'invalid_input'],
    ['wrong version', { zh: 2, svc: 'decision', opts: ['a', 'b'] }, 'bad_version'],
    ['version as string', { zh: '1', svc: 'decision', opts: ['a', 'b'] }, 'bad_version'],
    ['unknown service', { zh: 1, svc: 'oracle', q: 'x' }, 'unknown_service'],
    ['missing service', { zh: 1 }, 'unknown_service'],
    ['bad tone', { zh: 1, svc: 'encouragement', msg: 'x', tone: 'angry' }, 'invalid_input'],
    ['empty message', { zh: 1, svc: 'encouragement', msg: '' }, 'invalid_input'],
    ['message too long', { zh: 1, svc: 'encouragement', msg: 'm'.repeat(281) }, 'invalid_input'],
    ['array payload', [1, 2], 'bad_json'],
    ['null payload', null, 'bad_json'],
  ];
  for (const [name, payload, code] of bad) {
    it(`rejects: ${name}`, () => {
      const d = decodeRequest(j(payload));
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.code).toBe(code);
    });
  }

  it('rejects non-JSON bytes', () => {
    const d = decodeRequest(stringToHex('hello world'));
    expect(d.ok === false && d.code).toBe('bad_json');
  });
  it('rejects invalid UTF-8', () => {
    const d = decodeRequest(bytesToHex(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])));
    expect(d.ok === false && d.code).toBe('bad_json');
  });
  it('rejects oversize payloads before parsing', () => {
    const d = decodeRequest(stringToHex(' '.repeat(LIMITS.requestBytes + 1)));
    expect(d.ok === false && d.code).toBe('too_large');
  });
  it('rejects malformed hex', () => {
    expect(decodeRequest('0xabc' as Hex).ok).toBe(false);
    expect(decodeRequest('0xzz' as Hex).ok).toBe(false);
  });
  it('SDK refuses to build out-of-bounds requests', () => {
    expect(() => decisionRequest(['only one'])).toThrow();
    expect(() => decisionRequest(['a', 'b', 'c', 'd', 'e', 'f'])).toThrow();
    expect(() => encouragementRequest('x'.repeat(400))).toThrow();
  });
  it('max-size valid decision fits within the request byte limit', () => {
    const opts = Array.from({ length: 5 }, (_, i) => `${i}`.padEnd(LIMITS.decisionOptionMaxBytes, 'x'));
    const req = decisionRequest(opts, 'c'.repeat(LIMITS.decisionContextMaxBytes), 'r'.repeat(32));
    const hex = encodeRequest(req);
    expect((hex.length - 2) / 2).toBeLessThanOrEqual(LIMITS.requestBytes);
  });
});

describe('response codec', () => {
  it('round-trips and mentions the order', () => {
    const res = { zh: 1 as const, re: H, ok: false as const, err: { code: 'invalid_input' as const, msg: 'nope' } };
    const hex = encodeResponse(res);
    expect(decodeResponse(hex)).toEqual({ ok: true, value: res });
    expect(responseMentionsOrder(hex, H)).toBe(true);
    expect(responseMentionsOrder(hex, ('0x' + 'cd'.repeat(32)) as Hex)).toBe(false);
  });
  it('refuses to emit oversized responses', () => {
    const res = { zh: 1 as const, re: H, svc: 'encouragement' as const, ok: true as const, out: { message: '€'.repeat(240), nextStep: '€'.repeat(200), tone: 'playful' as const, gen: 'llm' as const } };
    expect(() => encodeResponse(res)).toThrow(/limit/);
  });
});
