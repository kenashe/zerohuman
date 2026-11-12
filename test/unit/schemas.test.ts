import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generate } from '../../scripts/gen-schemas.js';

describe('published JSON Schemas', () => {
  it('are in sync with the zod source of truth (run `npm run schemas` if this fails)', () => {
    for (const [name, schema] of Object.entries(generate())) {
      const onDisk = JSON.parse(readFileSync(`schemas/${name}.schema.json`, 'utf8'));
      expect(onDisk).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });
});
