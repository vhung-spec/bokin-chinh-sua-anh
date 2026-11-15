import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, parseQuickCommand, nextStrength } from '../../shared/quick-commands.js';

const edits = ['Bầu trời', 'Áo'];
const parse = (text) => parseQuickCommand(text, { edits });

test('fold: bỏ dấu, chữ thường, bỏ dấu câu ở hai đầu', () => {
  assert.equal(fold('  Hoàn TÁC!  '), 'hoan tac');
  assert.equal(fold('Đổi màu'), 'doi mau');
});

test('hoàn tác, làm lại, vùng chọn, so sánh, tải ảnh', () => {
  assert.deepEqual(parse('Hoàn tác'), { kind: 'undo', steps: 1 });
  assert.deepEqual(parse('hoan tac 2 buoc'), { kind: 'undo', steps: 2 });
  assert.deepEqual(parse('hoàn tác giúp mình nhé'), { kind: 'undo', steps: 1 });
  assert.deepEqual(parse('Làm lại'), { kind: 'redo', steps: 1 });
  assert.deepEqual(parse('bỏ chọn'), { kind: 'deselect' });
  assert.deepEqual(parse('đảo vùng chọn'), { kind: 'invert' });
  assert.deepEqual(parse('xem ảnh gốc'), { kind: 'compare' });
  assert.deepEqual(parse('tải ảnh'), { kind: 'export', format: 'jpg' });
  assert.deepEqual(parse('lưu ảnh png'), { kind: 'export', format: 'png' });
  assert.deepEqual(parse('Xuất PSD'), { kind: 'export', format: 'psd' });
});

test('mạnh hơn / nhẹ hơn: lần chỉnh gần nhất hoặc đúng tên vùng', () => {
  assert.deepEqual(parse('mạnh hơn'), { kind: 'scale', name: 'Áo', factor: 1.4 });
  assert.deepEqual(parse('Nhẹ hơn một chút'), { kind: 'scale', name: 'Áo', factor: 0.8 });
  assert.deepEqual(parse('mạnh hơn nhiều'), { kind: 'scale', name: 'Áo', factor: 1.8 });
  assert.deepEqual(parse('bầu trời nhẹ hơn chút nữa'), { kind: 'scale', name: 'Bầu trời', factor: 0.8 });
  assert.deepEqual(parse('chỉnh bau troi manh hon'), { kind: 'scale', name: 'Bầu trời', factor: 1.4 });
  assert.deepEqual(parse('làm áo dịu hơn'), { kind: 'scale', name: 'Áo', factor: 0.7 });
});

test('bỏ chỉnh một vùng theo tên', () => {
  assert.deepEqual(parse('bỏ chỉnh áo'), { kind: 'remove', name: 'Áo' });
  assert.deepEqual(parse('xoá chỉnh bầu trời đi'), { kind: 'remove', name: 'Bầu trời' });
  assert.equal(parse('bỏ chỉnh tóc'), null, 'không có lần chỉnh tên Tóc: để Claude');
});

test('câu khác, câu có thêm ý, chưa có lần chỉnh nào: gửi Claude', () => {
  for (const text of [
    'đậm hơn', 'nhạt hơn', 'sáng hơn', 'ảnh nhẹ hơn', 'tóc mạnh hơn', 'mạnh hơn và ấm hơn', 'mạnh hơn, thêm chút xanh',
    'tải ảnh mẫu', 'hoàn tác rồi làm sáng hơn', 'làm ảnh sáng hơn và màu tươi hơn một chút',
    'mạnh hơn ở góc trái', 'x'.repeat(80),
  ]) assert.equal(parse(text), null, text);
  assert.equal(parseQuickCommand('mạnh hơn', { edits: [] }), null);
  // thao tác gần nhất không phải chỉnh vùng (ví dụ phong cách màu cả ảnh): "mạnh hơn" là của Claude, nói tên vùng thì vẫn làm
  assert.equal(parseQuickCommand('mạnh hơn', { edits, last: null }), null);
  assert.deepEqual(parseQuickCommand('áo mạnh hơn', { edits, last: null }), { kind: 'scale', name: 'Áo', factor: 1.4 });
  assert.deepEqual(parseQuickCommand('nhẹ hơn', { edits, last: 'Bầu trời' }), { kind: 'scale', name: 'Bầu trời', factor: 0.7 });
});

test('nextStrength: trong 10-200, làm tròn 5, hết mức thì null', () => {
  assert.equal(nextStrength(100, 1.4), 140);
  assert.equal(nextStrength(undefined, 0.7), 70);
  assert.equal(nextStrength(180, 1.4), 200);
  assert.equal(nextStrength(200, 1.4), null);
  assert.equal(nextStrength(10, 0.7), null);
});
