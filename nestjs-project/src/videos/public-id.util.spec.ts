import { generatePublicId, PUBLIC_ID_LENGTH } from './public-id.util';

describe('generatePublicId', () => {
  it('should generate ids with the expected length', () => {
    expect(PUBLIC_ID_LENGTH).toBe(11);
    expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
  });

  it('should only use base62 characters', () => {
    for (let i = 0; i < 100; i++) {
      expect(generatePublicId()).toMatch(/^[0-9A-Za-z]{11}$/);
    }
  });

  it('should not collide across a large sample', () => {
    const sample = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      sample.add(generatePublicId());
    }
    expect(sample.size).toBe(1000);
  });
});
