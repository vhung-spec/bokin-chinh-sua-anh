import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbToLab, labToRgb, labStats, transferColors, describeStats } from '../../shared/color-transfer.js';

const solid = (n, [r, g, b], alpha = 255) => {
  const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) d.set([r, g, b, alpha], i * 4);
  return d;
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('sRGB -> Lab -> sRGB gần như giữ nguyên màu', () => {
  for (const c of [[0, 0, 0], [255, 255, 255], [200, 100, 50], [12, 140, 230], [128, 128, 128], [255, 0, 0]]) {
    const back = labToRgb(...rgbToLab(...c));
    c.forEach((v, i) => near(back[i], v, 1, `kênh ${i} của ${c}`));
  }
  const [L, a, b] = rgbToLab(255, 255, 255);
  near(L, 100, 0.01, 'L trắng');
  near(a, 0, 0.01, 'a trắng');
  near(b, 0, 0.01, 'b trắng');
});

test('labStats: màu đồng nhất có độ lệch 0, điểm trong suốt và trọng số 0 bị bỏ', () => {
  const s = labStats(solid(100, [200, 100, 50]));
  const lab = rgbToLab(200, 100, 50);
  s.mean.forEach((v, i) => near(v, lab[i], 1e-6, `mean ${i}`));
  s.std.forEach((v) => near(v, 0, 1e-3, 'std'));

  // nửa đỏ, nửa xanh; trọng số chỉ cho nửa đỏ
  const d = new Uint8ClampedArray(200 * 4);
  for (let i = 0; i < 200; i++) d.set(i < 100 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
  const w = new Uint8Array(200).fill(0);
  w.fill(255, 0, 100);
  const red = labStats(d, { weights: w });
  const redLab = rgbToLab(255, 0, 0);
  red.mean.forEach((v, i) => near(v, redLab[i], 1e-6, `mean đỏ ${i}`));
  assert.equal(labStats(solid(10, [1, 2, 3], 0)), null, 'toàn điểm trong suốt: không có thống kê');
});

test('transferColors: vùng đỏ thành màu của ảnh mẫu xanh lá; giữ độ sáng thì chỉ đổi màu', () => {
  const ref = labStats(solid(50, [40, 160, 70]));
  const px = solid(20, [220, 30, 30]);
  transferColors(px, labStats(px), ref);
  const [r, g, b] = px;
  near(r, 40, 2, 'R');
  near(g, 160, 2, 'G');
  near(b, 70, 2, 'B');

  const px2 = solid(20, [220, 30, 30]);
  const before = rgbToLab(220, 30, 30)[0];
  transferColors(px2, labStats(px2), ref, { keepBrightness: true });
  const [L2, a2, b2] = rgbToLab(px2[0], px2[1], px2[2]);
  near(L2, before, 1.5, 'độ sáng giữ nguyên');
  assert.ok(a2 < 0, 'đã ngả xanh lá (a âm)');
  assert.ok(b2 > 0, 'b của ảnh mẫu');
  assert.equal(px2[3], 255, 'alpha giữ nguyên');
});

test('transferColors: độ tương phản của ảnh mẫu được lấy, nhưng có giới hạn', () => {
  // nguồn: xám tối/sáng xen kẽ, độ trải L nhỏ; mẫu: đen/trắng, độ trải lớn hơn nhiều
  const src = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i++) src.set(i % 2 ? [120, 120, 120, 255] : [136, 136, 136, 255], i * 4);
  const ref = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i++) ref.set(i % 2 ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
  const s = labStats(src);
  const out = transferColors(src, s, labStats(ref));
  near(out.scale[0], 1.5, 1e-9, 'hệ số L bị giới hạn ở 1,5');
  const after = labStats(src);
  near(after.std[0], s.std[0] * 1.5, 0.5, 'độ trải tăng đúng 1,5 lần');
});

test('describeStats: tông ấm có warmth dương', () => {
  const warm = describeStats(labStats(solid(10, [230, 160, 80])));
  const cool = describeStats(labStats(solid(10, [80, 140, 230])));
  assert.ok(warm.warmth > 20 && cool.warmth < -20, JSON.stringify({ warm, cool }));
  assert.equal(describeStats(null), null);
});

test('adjustColors: sáng hơn, ấm hơn, bớt rực về xám, xoay tông, đổi sang màu đích giữ chênh lệch', async () => {
  const { adjustColors } = await import('../../shared/color-transfer.js');
  const run = (rgb, p, n = 4) => { const d = solid(n, rgb); adjustColors(d, labStats(d), p); return [d[0], d[1], d[2]]; };
  const lab = (c) => rgbToLab(...c);
  const base = [120, 100, 90];
  assert.ok(lab(run(base, { brightness: 40 }))[0] > lab(base)[0] + 10, 'sáng hơn');
  assert.ok(lab(run(base, { warmth: 50 }))[2] > lab(base)[2] + 10, 'ấm hơn: b tăng');
  assert.ok(lab(run(base, { warmth: -50 }))[2] < lab(base)[2] - 10, 'lạnh hơn: b giảm');
  assert.ok(lab(run(base, { tint: 50 }))[1] > lab(base)[1] + 10, 'tint hồng: a tăng');
  const gray = run([200, 40, 40], { saturation: -100 });
  assert.ok(Math.abs(gray[0] - gray[1]) <= 2 && Math.abs(gray[1] - gray[2]) <= 2, `-100 = xám: ${gray}`);
  const flipped = lab(run([200, 40, 40], { hue_shift: 180 }));
  assert.ok(flipped[1] < 0, 'xoay 180°: đỏ thành xanh lục/lam');
  // đổi màu đích: áo đỏ có nếp (hai sắc đỏ) thành xanh navy, vẫn hai sắc khác nhau
  const d = new Uint8ClampedArray(8 * 4);
  for (let i = 0; i < 8; i++) d.set(i % 2 ? [200, 30, 30, 255] : [140, 20, 20, 255], i * 4);
  adjustColors(d, labStats(d), { target: [30, 50, 120] });
  const after = labStats(d);
  const navy = rgbToLab(30, 50, 120);
  after.mean.forEach((v, c) => near(v, navy[c], 5, `trung bình kênh ${c} về màu đích (lệch chút do cắt vào dải sRGB)`));
  assert.ok(after.std[0] > 3, 'vẫn còn sáng tối (nếp áo)');
  // tương phản quanh trung bình của vùng
  const two = new Uint8ClampedArray(2 * 4);
  two.set([100, 100, 100, 255], 0);
  two.set([150, 150, 150, 255], 4);
  const s0 = labStats(two);
  adjustColors(two, s0, { contrast: 50 });
  assert.ok(labStats(two).std[0] > s0.std[0] * 1.4, 'tương phản tăng');
});
