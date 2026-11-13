// Chỉnh màu theo ảnh mẫu (giống Image > Adjustments > Match Color của Photoshop), tính ngay trong trình duyệt,
// không gọi AI: đổi ảnh sang không gian màu CIELAB (L = độ sáng, a = xanh lá ↔ đỏ, b = xanh dương ↔ vàng), rồi
// đưa giá trị trung bình và độ trải (độ lệch chuẩn) của từng kênh trong vùng cần chỉnh về đúng như ảnh mẫu
// (phương pháp Reinhard 2001). Hệ số co giãn có giới hạn để vùng ít màu không bị đẩy quá tay.
// Dùng chung cho trình duyệt (public/tool-runner.js) và kiểm thử Node (test/unit).

const LIN = new Float32Array(256); // sRGB 8 bit -> tuyến tính
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const GAMMA_STEPS = 4096; // tuyến tính -> sRGB 8 bit (bảng tra 12 bit)
const GAMMA = new Uint8ClampedArray(GAMMA_STEPS + 1);
for (let i = 0; i <= GAMMA_STEPS; i++) {
  const v = i / GAMMA_STEPS;
  GAMMA[i] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
}
const XN = 0.95047, ZN = 1.08883; // điểm trắng D65
const E = 216 / 24389, K = 24389 / 27;

const f = (t) => (t > E ? Math.cbrt(t) : (K * t + 16) / 116);
const finv = (t) => { const t3 = t * t * t; return t3 > E ? t3 : (116 * t - 16) / K; };
const toByte = (v) => GAMMA[Math.round(Math.min(1, Math.max(0, v)) * GAMMA_STEPS)];

/** sRGB (0-255) -> [L, a, b]. */
export function rgbToLab(r, g, b) {
  const lr = LIN[r], lg = LIN[g], lb = LIN[b];
  const fx = f((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / XN);
  const fy = f(0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb);
  const fz = f((0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** [L, a, b] -> sRGB (0-255, đã giới hạn). */
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const X = XN * finv(fy + a / 500);
  const Y = finv(fy);
  const Z = ZN * finv(fy - b / 200);
  return [
    toByte(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z),
    toByte(-0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z),
    toByte(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z),
  ];
}

/**
 * Trung bình và độ lệch chuẩn của L, a, b.
 * @param {Uint8ClampedArray|Uint8Array} rgba - điểm ảnh RGBA
 * @param {{ weights?: Uint8Array|Uint8ClampedArray|null, most?: number }} [options]
 *   weights: trọng số 0-255 cho từng điểm (độ đậm của vùng chọn), most: số điểm lấy mẫu tối đa (lấy cách đều)
 * @returns {{ mean: number[], std: number[], count: number } | null} null nếu không có điểm nào
 */
export function labStats(rgba, { weights = null, most = 400_000 } = {}) {
  const n = rgba.length / 4;
  const step = Math.max(1, Math.floor(n / most));
  const sum = [0, 0, 0], sq = [0, 0, 0];
  let total = 0, count = 0;
  for (let p = 0; p < n; p += step) {
    const alpha = rgba[p * 4 + 3];
    const w = (weights ? weights[p] : 255) * alpha / 65025;
    if (w < 0.03) continue;
    const lab = rgbToLab(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]);
    for (let c = 0; c < 3; c++) {
      sum[c] += w * lab[c];
      sq[c] += w * lab[c] * lab[c];
    }
    total += w;
    count++;
  }
  if (total <= 0) return null;
  const mean = sum.map((s) => s / total);
  const std = sq.map((s, c) => Math.sqrt(Math.max(0, s / total - mean[c] * mean[c])));
  return { mean, std, count };
}

// Hệ số co giãn độ trải: [nhỏ nhất, lớn nhất] cho L và cho a, b. Giới hạn trên vừa phải: vùng chọn lấn sang một
// vật khác màu hẳn (quả bóng đỏ giữa bầu trời) thì vật đó không bị đẩy thành màu chói.
const SCALE_L = [0.7, 1.5];
const SCALE_AB = [0.5, 1.6];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Đổi màu các điểm ảnh (tại chỗ) để thống kê Lab của `source` thành của `reference`.
 * @param {Uint8ClampedArray} rgba - điểm ảnh cần đổi (kênh alpha giữ nguyên)
 * @param {{mean:number[], std:number[]}} source - thống kê vùng cần chỉnh (labStats)
 * @param {{mean:number[], std:number[]}} reference - thống kê ảnh mẫu
 * @param {{ keepBrightness?: boolean }} [options] - true: giữ độ sáng (L) của ảnh gốc, chỉ lấy màu của ảnh mẫu
 */
export function transferColors(rgba, source, reference, { keepBrightness = false } = {}) {
  const k = [0, 1, 2].map((c) => {
    const [lo, hi] = c === 0 ? SCALE_L : SCALE_AB;
    return clamp(reference.std[c] / Math.max(source.std[c], 1), lo, hi);
  });
  for (let i = 0; i < rgba.length; i += 4) {
    const [L, a, b] = rgbToLab(rgba[i], rgba[i + 1], rgba[i + 2]);
    const L2 = keepBrightness ? L : (L - source.mean[0]) * k[0] + reference.mean[0];
    const a2 = (a - source.mean[1]) * k[1] + reference.mean[1];
    const b2 = (b - source.mean[2]) * k[2] + reference.mean[2];
    const [r, g, bl] = labToRgb(clamp(L2, 0, 100), a2, b2);
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = bl;
  }
  return { scale: k };
}

/** Mô tả ngắn thống kê màu (cho Claude và nhật ký): độ sáng, độ rực, tông nóng/lạnh. */
export function describeStats(stats) {
  if (!stats) return null;
  const [L, a, b] = stats.mean;
  const round = (v) => Math.round(v * 10) / 10;
  return {
    brightness: round(L),
    chroma: round(Math.hypot(a, b)),
    warmth: round(b),
    green_magenta: round(a),
    contrast: round(stats.std[0]),
  };
}
