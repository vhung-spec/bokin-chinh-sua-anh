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
