import { describe, it, expect } from 'vitest';
import {
  sourceContentHash,
  targetContentHash,
  writtenFileHash,
} from './hashes.js';

describe('hashes (§13.9)', () => {
  it('sourceContentHash is sha256:<64 lowercase hex>', () => {
    expect(sourceContentHash('hello')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('targetContentHash is sha256:<64 lowercase hex>', () => {
    expect(targetContentHash('hello')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('writtenFileHash computes from buffer bytes', () => {
    expect(writtenFileHash(Buffer.from('abc'))).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });
  it('writtenFileHash matches known SHA-256 of "abc"', () => {
    // known: sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(writtenFileHash(Buffer.from('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('sourceContentHash and targetContentHash of identical input collide (same algorithm, different semantic role)', () => {
    // §13.9 says they must NOT be the same field; but the hash algorithm itself is shared SHA-256.
    expect(sourceContentHash('x')).toBe(targetContentHash('x'));
  });
  it('sourceContentHash differs across inputs', () => {
    expect(sourceContentHash('a')).not.toBe(sourceContentHash('b'));
  });
  it('writtenFileHash differs from sourceContentHash only by input type (Buffer vs string of same bytes)', () => {
    // string 'abc' has the same bytes as Buffer.from('abc') in utf8
    expect(writtenFileHash(Buffer.from('abc'))).toBe(sourceContentHash('abc'));
  });
});
