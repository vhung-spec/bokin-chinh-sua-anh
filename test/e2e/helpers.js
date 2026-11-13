// Tiện ích cho kiểm thử end-to-end: chạy server, mở trình duyệt thật, chờ Photopea sẵn sàng.
// Cần mạng tới www.photopea.com. Nếu máy dùng proxy (biến HTTPS_PROXY), Chromium sẽ đi qua proxy đó.
import { chromium } from 'playwright';
import zlib from 'node:zlib';
import { createApp } from '../../server/app.js';

export async function startServer(options) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

export async function openApp(url, { viewport = { width: 1440, height: 900 }, deviceScaleFactor = 1 } = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  const pageErrors = [];
  page.on('pageerror', (e) => {
    // Bỏ qua lỗi nội bộ của Photopea (trong iframe); chỉ quan tâm lỗi từ mã của Bokin.
    if (!String(e.stack).includes('photopea.com')) pageErrors.push(`${e.message}\n${e.stack}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.bokin?.bridge?.isReady === true, null, { timeout: 120_000 });
  return { browser, page, pageErrors };
}

/** Chạy một tool qua đúng đường mà Claude dùng (window.bokin.executeTool). */
export function tool(page, name, input = {}) {
  return page.evaluate(([n, i]) => window.bokin.executeTool(n, i), [name, input]);
}

/** Đọc kết quả JSON của tool thành công. */
export function json(outcome) {
  if (outcome.isError) throw new Error(`Tool lỗi: ${outcome.content}`);
  return JSON.parse(outcome.content);
}

/** Thống kê pixel của ảnh hiện tại (xuất PNG từ Photopea): trung bình R,G,B, độ lệch chuẩn độ sáng, alpha, kích thước. */
export function stats(page) {
  return page.evaluate(async () => {
    const exported = await window.bokin.bridge.exportDocument('png');
    const bmp = await createImageBitmap(new Blob([exported.buffer]));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const n = d.length / 4;
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; }
    r /= n; g /= n; b /= n; a /= n;
    const mean = (r + g + b) / 3;
    let v = 0;
    for (let i = 0; i < d.length; i += 4) v += ((d[i] + d[i + 1] + d[i + 2]) / 3 - mean) ** 2;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), mean: Math.round(mean), std: +Math.sqrt(v / n).toFixed(1), alpha: Math.round(a), width: bmp.width, height: bmp.height };
  });
}

/** Màu của một pixel (x, y) trong ảnh hiện tại. */
export function pixel(page, x, y) {
  return page.evaluate(async ([px, py]) => {
    const exported = await window.bokin.bridge.exportDocument('png');
    const bmp = await createImageBitmap(new Blob([exported.buffer]));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
    return { r, g, b, a };
  }, [x, y]);
}

/** Đóng mọi tài liệu rồi tạo tài liệu mới có màu nền cho trước. */
export async function freshDoc(page, { width = 300, height = 200, background = '#808080' } = {}) {
  await page.evaluate(() => window.bokin.bridge.exec('while (app.documents.length) { app.activeDocument.close(2); }'));
  return json(await tool(page, 'create_document', { width, height, background }));
}

/** Tạo ảnh PNG một màu (dùng cho dịch vụ AI giả lập trong kiểm thử). */
export function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Đọc kích thước ảnh PNG từ header. */
export function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
