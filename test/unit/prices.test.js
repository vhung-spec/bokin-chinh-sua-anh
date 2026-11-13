import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageCost, totalCost, formatUsd } from '../../shared/prices.js';

test('usageCost tính đủ 4 loại token theo bảng giá', () => {
  // Opus 5.5: input $4, output $20, đọc cache $0,20, ghi cache $5 (mỗi triệu token)
  const u = { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 2000 };
  assert.equal(+usageCost(u).toFixed(6), +((1000 * 4 + 500 * 20 + 9000 * 0.2 + 2000 * 5) / 1e6).toFixed(6));
  assert.equal(usageCost({ model: 'model-la', input_tokens: 1 }), null);
  assert.equal(totalCost([u, u, { model: 'model-la', input_tokens: 5 }]), usageCost(u) * 2);
});

test('formatUsd kiểu Việt Nam', () => {
  assert.equal(formatUsd(0.01234), '~0,012 USD');
  assert.equal(formatUsd(0.00123), '~0,0012 USD');
  assert.equal(formatUsd(2.5), '~2,50 USD');
});
