// Các tình huống đánh giá: câu lệnh tiếng Việt + cách kiểm tra kết quả tự động.
//
// setup:
//   'photo'    -> trò chuyện mới, mở ảnh mẫu (bầu trời, bãi cỏ, quả bóng đỏ; hơi tối, có nhiễu)
//   'empty'    -> trò chuyện mới, không mở ảnh nào
//   'photo_yellow' -> như 'photo' nhưng ảnh bị ám vàng
//   'continue' -> tiếp tục cuộc trò chuyện của tình huống trước
// prepare(ctx) (tuỳ chọn): chạy sau setup, trước khi gửi câu lệnh — ví dụ tạo vùng chọn như người dùng khoanh.
// check(before, after, ctx) trả về chuỗi lỗi (thất bại) hoặc null (đạt).
//   before/after: kết quả analyze() (kích thước, màu trung bình, độ bão hoà, vị trí bóng đỏ, độ nét...)
//   ctx.info(): get_document_info; ctx.textColor(name): mã màu của layer chữ

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const textLayers = (info) => (info.layers ?? []).filter((l) => l.type === 'text');
const normalize = (s) => String(s).normalize('NFC').toLowerCase();

export const SCENARIOS = [
  {
    id: 'lam-sang',
    group: 'color',
    setup: 'photo',
    prompt: 'Ảnh này hơi tối, bạn làm sáng lên giúp mình nhé',
    check: (b, a) => (a.mean >= b.mean + 8 ? null : `độ sáng trung bình ${b.mean} -> ${a.mean} (cần tăng >= 8)`),
  },
  {
    id: 'den-trang',
    group: 'color',
    setup: 'photo',
    prompt: 'Chuyển ảnh sang đen trắng',
    check: (b, a) => (a.saturation <= 8 ? null : `độ bão hoà còn ${a.saturation}`),
  },
  {
    id: 'cat-vuong',
    group: 'basic',
    setup: 'photo',
    prompt: 'Cắt ảnh thành hình vuông, giữ quả bóng đỏ ở giữa khung hình',
    check: (b, a) => {
      if (!near(a.width, a.height, 2)) return `chưa vuông: ${a.width}x${a.height}`;
      if (a.red.count < 1000) return 'mất quả bóng đỏ';
      if (Math.abs(a.red.cx - a.width / 2) > a.width * 0.2) return `bóng lệch tâm: cx=${a.red.cx}, rộng ${a.width}`;
      return null;
    },
  },
  {
    id: 'them-chu',
    group: 'basic',
    setup: 'photo',
    prompt: 'Thêm dòng chữ KHAI TRƯƠNG màu vàng, thật to ở phía trên ảnh',
    check: async (b, a, ctx) => {
      const info = await ctx.info();
      const t = textLayers(info).find((l) => normalize(l.text).includes('khai trương'));
      if (!t) return 'không thấy layer chữ "KHAI TRƯƠNG"';
      const { x, y, width, height } = t.bounds;
      if (x < 0 || y < 0 || x + width > a.width + 1 || y + height > a.height + 1) return `chữ tràn ra ngoài ảnh: ${JSON.stringify(t.bounds)}`;
      if (y + height / 2 > a.height / 2) return `chữ không ở nửa trên: ${JSON.stringify(t.bounds)}`;
      if (width < a.width * 0.3) return `chữ chưa đủ to: rộng ${width}px`;
      const c = await ctx.textColor(t.name);
      if (!(c.r > 180 && c.g > 150 && c.b < 120)) return `màu chữ không phải vàng: ${c.hex}`;
      return null;
    },
  },
  {
    id: 'doi-mau-chu',
    group: 'basic',
    setup: 'continue',
    prompt: 'Đổi chữ đó sang màu đỏ',
    check: async (b, a, ctx) => {
      const t = textLayers(await ctx.info())[0];
      if (!t) return 'mất layer chữ';
      const c = await ctx.textColor(t.name);
      return c.r > 180 && c.g < 100 && c.b < 100 ? null : `màu chữ ${c.hex}, chưa phải đỏ`;
    },
  },
  {
    id: 'hoan-tac',
    group: 'basic',
    setup: 'continue',
    prompt: 'Thôi, hoàn tác lại bước vừa rồi',
    check: async (b, a, ctx) => {
      const t = textLayers(await ctx.info())[0];
      if (!t) return 'mất layer chữ';
      const c = await ctx.textColor(t.name);
      return c.r > 180 && c.g > 150 ? null : `màu chữ ${c.hex}, chưa về màu vàng`;
    },
  },
  {
    id: 'thu-nho',
    group: 'basic',
    setup: 'photo',
    prompt: 'Thu nhỏ ảnh xuống chiều rộng 600px',
    check: (b, a) => (a.width === 600 && near(a.height, 400, 1) ? null : `kích thước ${a.width}x${a.height}`),
  },
  {
    id: 'vien-trang',
    group: 'basic',
    setup: 'photo',
    prompt: 'Thêm viền trắng 30px xung quanh ảnh',
    check: (b, a) => {
      if (a.width !== b.width + 60 || a.height !== b.height + 60) return `kích thước ${a.width}x${a.height}`;
      return a.corner.r > 245 && a.corner.g > 245 && a.corner.b > 245 && a.corner.a === 255 ? null : `góc ảnh không trắng: ${JSON.stringify(a.corner)}`;
    },
  },
  {
    id: 'mo-nen',
    group: 'basic',
    setup: 'photo',
    prompt: 'Làm mờ phần nền nhưng giữ quả bóng đỏ sắc nét',
    check: (b, a) => {
      if (a.sharpness.background > b.sharpness.background * 0.7) return `nền chưa mờ: ${b.sharpness.background} -> ${a.sharpness.background}`;
      if (a.sharpness.ball < b.sharpness.ball * 0.7) return `quả bóng bị mờ: ${b.sharpness.ball} -> ${a.sharpness.ball}`;
      return null;
    },
  },
  {
    id: 'bia-facebook',
    group: 'basic',
    setup: 'empty',
    prompt: "Tạo ảnh bìa Facebook nền xanh đậm, có chữ 'Khai trương' màu trắng ở giữa",
    check: async (b, a, ctx) => {
      if (!a) return 'không có tài liệu nào';
      const ratio = a.width / a.height;
      if (ratio < 1.7 || ratio > 2.8) return `tỉ lệ ${a.width}x${a.height} không giống ảnh bìa`;
      if (!(a.b > a.r + 20)) return `nền không xanh: ${JSON.stringify({ r: a.r, g: a.g, b: a.b })}`;
      const t = textLayers(await ctx.info()).find((l) => normalize(l.text).includes('khai trương'));
      if (!t) return 'không thấy chữ "Khai trương"';
      const cx = t.bounds.x + t.bounds.width / 2;
      return Math.abs(cx - a.width / 2) <= a.width * 0.15 ? null : `chữ lệch tâm: cx=${cx}`;
    },
  },
  {
    id: 'xoa-bong-ai',
    group: 'fill',
    setup: 'photo',
    requires: 'ai_edit', // chỉ chạy khi server có HF_TOKEN
    prompt: 'Xoá quả bóng đỏ khỏi ảnh',
    check: (b, a) => (a.red.count < b.red.count * 0.2 ? null : `vẫn còn bóng đỏ: ${b.red.count} -> ${a.red.count} pixel đỏ`),
  },
  {
    id: 'can-bang-mau',
    group: 'color',
    setup: 'photo_yellow',
    prompt: 'Ảnh bị ám vàng quá, cân bằng lại màu giúp mình',
    check: (b, a) => {
      const castBefore = (b.r + b.g) / 2 - b.b;
      const castAfter = (a.r + a.g) / 2 - a.b;
      return castAfter <= castBefore - 8 ? null : `độ ám vàng (R+G)/2-B: ${castBefore.toFixed(0)} -> ${castAfter.toFixed(0)} (cần giảm >= 8)`;
    },
  },
  {
    id: 'troi-xanh-hon',
    group: 'color',
    setup: 'photo',
    prompt: 'Làm bầu trời xanh đậm và tươi hơn, giữ nguyên màu bãi cỏ và quả bóng',
    check: (b, a) => {
      const satSky = (r) => Math.max(r.r, r.g, r.b) - Math.min(r.r, r.g, r.b);
      if (satSky(a.regions.sky) < satSky(b.regions.sky) + 6) return `trời chưa xanh hơn: độ bão hoà ${satSky(b.regions.sky)} -> ${satSky(a.regions.sky)}`;
      const dg = Math.abs(a.regions.grass.g - b.regions.grass.g) + Math.abs(a.regions.grass.r - b.regions.grass.r);
      return dg <= 12 ? null : `bãi cỏ bị đổi màu: ${JSON.stringify(b.regions.grass)} -> ${JSON.stringify(a.regions.grass)}`;
    },
  },
  {
    id: 'mau-dien-anh',
    group: 'color',
    setup: 'photo',
    prompt: 'Chỉnh màu ảnh theo kiểu điện ảnh',
    check: (b, a) => {
      const diff = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
      return diff >= 6 ? null : `màu gần như không đổi (lệch ${diff})`;
    },
  },
  {
    id: 'generative-fill',
    group: 'fill',
    setup: 'photo',
    requires: 'ai_edit',
    // Giống người dùng tự khoanh quanh quả bóng trong Photopea rồi gõ lệnh
    prepare: (ctx) => ctx.tool('select_area', { mode: 'ellipse', x: 690, y: 340, width: 260, height: 260, feather: 4 }),
    prompt: 'Xoá vật thể trong vùng tôi vừa khoanh',
    check: (b, a) => (a.red.count < b.red.count * 0.2 ? null : `vẫn còn bóng đỏ: ${b.red.count} -> ${a.red.count} pixel đỏ`),
  },
  {
    id: 'tuong-phan-net',
    group: 'color',
    setup: 'photo',
    prompt: 'Tăng tương phản rồi làm nét ảnh',
    check: (b, a) => {
      if (a.std <= b.std) return `tương phản không tăng: std ${b.std} -> ${a.std}`;
      return a.sharpness.background > b.sharpness.background ? null : `không nét hơn: ${b.sharpness.background} -> ${a.sharpness.background}`;
    },
  },
];

export const GROUPS = ['color', 'fill', 'basic'];

/**
 * Chọn tình huống theo bộ lọc: tên nhóm (color, fill, basic) hoặc một phần id.
 * Tình huống 'continue' kéo theo các tình huống đứng trước nó trong cùng chuỗi.
 */
export function selectScenarios(filters = []) {
  if (!filters.length) return SCENARIOS;
  const picked = new Set();
  SCENARIOS.forEach((s, i) => {
    if (!filters.some((f) => (GROUPS.includes(f) ? s.group === f : s.id.includes(f)))) return;
    picked.add(i);
    for (let j = i; j > 0 && SCENARIOS[j].setup === 'continue'; j--) picked.add(j - 1);
  });
  return SCENARIOS.filter((_, i) => picked.has(i));
}
