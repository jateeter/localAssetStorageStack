import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/integrity.js';

// RFC 8785 examples and edge cases.
test('canonical JSON follows RFC 8785', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonical({ '€': 1, '\r': 2, 1: 3, '😀': 4, 'ö': 5 }), '{"\\r":2,"1":3,"ö":5,"€":1,"😀":4}');
  assert.equal(canonical([1e21, 1e-7, -0, 0.1, 333333333.3333333]), '[1e+21,1e-7,0,0.1,333333333.3333333]');
  assert.equal(canonical(' "\\'), '" \\"\\\\"');
  assert.equal(canonical({ a: undefined, b: 2 }), '{"b":2}');
  assert.throws(() => canonical({ x: NaN }), /non-finite/);
  assert.throws(() => canonical({ x: () => 1 }), /cannot hold/);
});
