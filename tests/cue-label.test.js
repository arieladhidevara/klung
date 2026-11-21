import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CUE_LABEL, cueLabel } from '../src/cue-label.js';

test('legacy cues use the Transpose default', () => {
  assert.equal(cueLabel({ start: 3 }), DEFAULT_CUE_LABEL);
  assert.equal(cueLabel(null), 'TRANSPOSE');
});
test('user-defined labels support arbitrary text and Unicode', () => {
  assert.equal(cueLabel({ label: '  CHORUS 🎵  ' }), 'CHORUS 🎵');
  assert.equal(cueLabel({ label: 'Semua siap! (2x)' }), 'Semua siap! (2x)');
});
test('blank labels fall back to Transpose', () => {
  assert.equal(cueLabel({ label: '  ' }), 'TRANSPOSE');
  assert.equal(cueLabel({ label: 123 }), 'TRANSPOSE');
});
