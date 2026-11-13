// Hàm dùng chung cho bộ đánh giá: tạo ảnh mẫu và phân tích ảnh hiện tại trong Photopea.

/** Ảnh mẫu 1200x800: bầu trời, bãi cỏ, quả bóng đỏ tâm (820, 470) bán kính 110; có nhiễu và hơi tối. */
export async function makeSamplePhoto({ yellowCast = false } = {}) {
  const W = 1200, H = 800;
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, 480);
  sky.addColorStop(0, '#3b5b8a'); sky.addColorStop(1, '#a9bdd6');
  x.fillStyle = sky; x.fillRect(0, 0, W, 480);
  const grass = x.createLinearGradient(0, 480, 0, H);
  grass.addColorStop(0, '#4d7a34'); grass.addColorStop(1, '#2f4d1f');
  x.fillStyle = grass; x.fillRect(0, 480, W, H - 480);
  const ball = x.createRadialGradient(790, 440, 20, 820, 470, 110);
  ball.addColorStop(0, '#ff6b5a'); ball.addColorStop(1, '#c41f1f');
  x.fillStyle = ball; x.beginPath(); x.arc(820, 470, 110, 0, Math.PI * 2); x.fill();
  const img = x.getImageData(0, 0, W, H);
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 36;
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.max(0, Math.min(255, (img.data[i + k] + n) * 0.62));
    if (yellowCast) {
      img.data[i] = Math.min(255, img.data[i] * 1.12 + 12);
      img.data[i + 1] = Math.min(255, img.data[i + 1] * 1.08 + 8);
      img.data[i + 2] = img.data[i + 2] * 0.7;
    }
  }
  x.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Phân tích ảnh hiện tại: kích thước, màu trung bình, độ bão hoà, quả bóng đỏ, độ nét nền/bóng. */
export function analyze(page) {
  return page.evaluate(async () => {
    const exported = await window.bokin.bridge.exportDocument('png');
    if (!exported) return null;
    const bmp = await createImageBitmap(new Blob([exported.buffer]));
    const W = bmp.width, H = bmp.height;
    const cv = new OffscreenCanvas(W, H);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    const lum = new Float32Array(W * H);
    let r = 0, g = 0, b = 0, sat = 0, redN = 0, redX = 0, redY = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r += R; g += G; b += B;
      sat += Math.max(R, G, B) - Math.min(R, G, B);
      lum[p] = (R + G + B) / 3;
      if (R > 70 && R > 1.8 * G && R > 1.8 * B) { redN++; redX += p % W; redY += Math.floor(p / W); }
    }
    const n = W * H;
    const mean = (r + g + b) / 3 / n;
    let v = 0;
    for (let p = 0; p < n; p++) v += (lum[p] - mean) ** 2;
    const sharp = (x0, y0, x1, y1) => {
      let s = 0, k = 0;
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1) - 1; x++) { s += Math.abs(lum[y * W + x + 1] - lum[y * W + x]); k++; }
      }
      return k ? +(s / k).toFixed(2) : 0;
    };
    const cx = redN ? Math.round(redX / redN) : null;
    const cy = redN ? Math.round(redY / redN) : null;
    const c0 = ctx.getImageData(2, 2, 1, 1).data;
    // Màu trung bình của vùng trời (20% trên, bên trái quả bóng) và vùng cỏ (20% dưới)
    const regionMean = (x0, y0, x1, y1) => {
      let R = 0, G = 0, B = 0, k = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * W + x) * 4; R += d[i]; G += d[i + 1]; B += d[i + 2]; k++; }
      return { r: Math.round(R / k), g: Math.round(G / k), b: Math.round(B / k) };
    };
    return {
      width: W, height: H,
      r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n),
      mean: Math.round(mean), std: +Math.sqrt(v / n).toFixed(1),
      saturation: Math.round(sat / n),
      red: { count: redN, cx, cy },
      corner: { r: c0[0], g: c0[1], b: c0[2], a: c0[3] },
      regions: {
        sky: regionMean(0, 0, Math.round(W * 0.5), Math.round(H * 0.2)),
        grass: regionMean(0, Math.round(H * 0.8), Math.round(W * 0.5), H),
      },
      sharpness: {
        background: sharp(0, 0, W, Math.round(H * 0.35)),
        ball: redN > 500 ? sharp(cx - 50, cy - 50, cx + 50, cy + 50) : 0,
      },
    };
  });
}

