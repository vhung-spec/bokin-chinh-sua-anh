// Danh sách công cụ (tool) mà Claude được phép gọi để điều khiển Photopea.
//
// Mỗi tool có:
//   name, description, input_schema  -> gửi cho Claude API
//   label                            -> tên tiếng Việt hiển thị trong giao diện
//   kind: 'script'  -> build(input) trả về script chạy trong Photopea
//   kind: 'client'  -> do trình duyệt tự xử lý (xem ảnh, xuất file, hoàn tác...)
//
// File này được dùng ở cả server (Node) và trình duyệt (import qua /shared/tools.js),
// nên chỉ dùng JavaScript thuần, không phụ thuộc thư viện.
//
// Ghi chú: các hàm điều chỉnh Levels/Curves/Hue-Saturation/Unsharp... dùng Action Manager
// (app.executeAction) vì các hàm DOM tương ứng của Photopea (adjustLevels, adjustCurves,
// applyUnSharpMask, threshold, posterize...) chạy không báo lỗi nhưng KHÔNG đổi pixel.

import { wrap, lit, num, hex, hexToRgb, targetLayer, rectPoints, ellipsePoints } from './script-kit.js';
import { amCurves, amLevels, amColorBalance, amHueSaturation, amVibrance, COLOR_PRESETS, COLOR_RANGES } from './color.js';

const LAYER_PARAM = {
  type: 'string',
  description: 'Tên layer cần thao tác. Bỏ trống để dùng layer đang được chọn (active layer).',
};

const COLOR_PARAM = (description) => ({
  type: 'string',
  description: `${description} Dạng mã hex #RRGGBB, ví dụ "#FF0000".`,
});

const ANCHORS = {
  top_left: 'TOPLEFT', top: 'TOPCENTER', top_right: 'TOPRIGHT',
  left: 'MIDDLELEFT', center: 'MIDDLECENTER', right: 'MIDDLERIGHT',
  bottom_left: 'BOTTOMLEFT', bottom: 'BOTTOMCENTER', bottom_right: 'BOTTOMRIGHT',
};

const BLEND_MODES = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY',
  darken: 'DARKEN', lighten: 'LIGHTEN', color_dodge: 'COLORDODGE', color_burn: 'COLORBURN',
  soft_light: 'SOFTLIGHT', hard_light: 'HARDLIGHT', difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION', hue: 'HUE', saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};

const has = (v) => v !== undefined && v !== null && v !== '';

const CURVE_PARAM = (description) => ({
  type: 'array', minItems: 2, maxItems: 16, description,
  items: { type: 'array', items: { type: 'number', minimum: 0, maximum: 255 }, minItems: 2, maxItems: 2 },
});

const BALANCE_PARAM = (description) => ({
  type: 'array', minItems: 3, maxItems: 3,
  description: `${description} [cyan↔red, magenta↔green, yellow↔blue], mỗi giá trị -100..100.`,
  items: { type: 'integer', minimum: -100, maximum: 100 },
});

/** Đoạn Action Manager: Photo Filter (làm ấm/lạnh/sepia) với màu + mật độ. */
function photoFilter(colorHex, density) {
  const { r, g, b } = hexToRgb(colorHex);
  return `var __pf = new ActionDescriptor(); var __pc = new ActionDescriptor();
__pc.putDouble(_c('Rd  '), ${r}); __pc.putDouble(_c('Grn '), ${g}); __pc.putDouble(_c('Bl  '), ${b});
__pf.putObject(_c('Clr '), _c('RGBC'), __pc); __pf.putInteger(_c('Dnst'), ${num(density)}); __pf.putBoolean(_c('PrsL'), true);
app.executeAction(_s('photoFilter'), __pf, DialogModes.NO);`;
}

export const TOOLS = [
  // ───────────────────────────── Thông tin & xem ảnh ─────────────────────────────
  {
    name: 'get_document_info',
    label: 'Xem thông tin ảnh',
    kind: 'script',
    description:
      'Get the state of the document open in Photopea: size in pixels, resolution, the active layer and the layer list ' +
      '(name, type pixel/text/group/adjustment, visibility, opacity, bounds; layers[0] is the TOP layer). ' +
      'Call this first whenever you do not know the current state, after the user says they opened a new image, ' +
      'and before choosing coordinates or layer names.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    build() {
      return wrap(`
if (app.documents.length === 0) { __ok({ has_document: false, message: 'Chưa có ảnh nào đang mở.' }); return; }
var doc = app.activeDocument;
var out = [];
var total = 0;
function walk(c, depth, groupName) {
  for (var i = 0; i < c.layers.length; i++) {
    var L = c.layers[i];
    total++;
    if (out.length < 60) {
      var e = { name: L.name, visible: L.visible, opacity: Math.round(L.opacity) };
      if (depth > 0) { e.in_group = groupName; }
      if (L.typename === 'LayerSet') { e.type = 'group'; }
      else if (__isText(L)) { e.type = 'text'; e.text = String(L.textItem.contents).slice(0, 200); e.bounds = __bounds(L); }
      else if (L.kind == LayerKind.NORMAL || L.kind == 0) { e.type = 'pixel'; e.bounds = __bounds(L); }
      else { e.type = 'adjustment_or_other'; }
      out.push(e);
    }
    if (L.typename === 'LayerSet') { walk(L, depth + 1, L.name); }
  }
}
walk(doc, 0, '');
var names = [];
for (var j = 0; j < app.documents.length; j++) { names.push(app.documents[j].name); }
__ok({
  has_document: true,
  name: doc.name,
  width: __num(doc.width),
  height: __num(doc.height),
  resolution: __num(doc.resolution),
  active_layer: doc.activeLayer.name,
  layer_count: total,
  layers: out,
  open_documents: names
});`, { needsDocument: false });
    },
  },
  {
    name: 'view_image',
    label: 'Xem ảnh',
    kind: 'client',
    description:
      'Look at the current image (all visible layers composited) as a downscaled preview. ' +
      'Use it before edits that depend on what is in the picture (where the subject is, where empty space is, ' +
      'whether it is too dark), and after visual edits to check the result. ' +
      'Optionally pass a region (document pixels) to zoom into a detail. The result states the scale between ' +
      'the preview and the document; always give coordinates to other tools in DOCUMENT pixels.',
    input_schema: {
      type: 'object',
      properties: {
        region: {
          type: 'object',
          description: 'Vùng cần phóng to, tính bằng pixel của tài liệu. Bỏ trống để xem toàn bộ ảnh.',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number', minimum: 1 }, height: { type: 'number', minimum: 1 },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
        max_size: {
          type: 'integer', minimum: 256, maximum: 1568,
          description: 'Cạnh dài tối đa của ảnh xem trước (mặc định 1024).',
        },
      },
      additionalProperties: false,
    },
  },

  // ───────────────────────────── Tài liệu & khung ảnh ─────────────────────────────
  {
    name: 'create_document',
    label: 'Tạo ảnh mới',
    kind: 'script',
    description:
      'Create a new blank document (e.g. for a poster, banner or social media post). ' +
      'Common sizes: Facebook post 1200x630, Instagram square 1080x1080, Instagram story 1080x1920, A4 at 150 dpi 1240x1754.',
    input_schema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1, maximum: 20000 },
        height: { type: 'integer', minimum: 1, maximum: 20000 },
        background: {
          type: 'string',
          description: 'Màu nền dạng #RRGGBB, hoặc "transparent" cho nền trong suốt. Mặc định #FFFFFF.',
        },
        name: { type: 'string', description: 'Tên tài liệu.' },
      },
      required: ['width', 'height'],
      additionalProperties: false,
    },
    build({ width, height, background = '#FFFFFF', name = 'Thiết kế mới' }) {
      const transparent = String(background).toLowerCase() === 'transparent';
      const fill = transparent ? '' : `doc.selection.selectAll(); doc.selection.fill(__color(${lit(hex(background))})); doc.selection.deselect();`;
      return wrap(`
app.documents.add(${num(width)}, ${num(height)}, 72, ${lit(name)}, NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
var doc = app.activeDocument;
${fill}
__ok({ name: doc.name, width: __num(doc.width), height: __num(doc.height), background: ${lit(transparent ? 'transparent' : '#' + hex(background))} });`,
      { needsDocument: false });
    },
  },
  {
    name: 'resize_image',
    label: 'Đổi kích thước ảnh',
    kind: 'script',
    description:
      'Scale the whole image (all layers) to a new size. Give width and/or height in pixels, or scale_percent. ' +
      'If only one of width/height is given the aspect ratio is kept.',
    input_schema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1, maximum: 30000 },
        height: { type: 'integer', minimum: 1, maximum: 30000 },
        scale_percent: { type: 'number', minimum: 1, maximum: 1000, description: 'Tỉ lệ phần trăm, ví dụ 50 = giảm một nửa.' },
      },
      additionalProperties: false,
    },
    build({ width, height, scale_percent }) {
      if (!has(width) && !has(height) && !has(scale_percent)) throw new Error('Cần width, height hoặc scale_percent.');
      return wrap(`
var w0 = __num(doc.width), h0 = __num(doc.height);
var W = ${has(width) ? num(width) : 'null'}, H = ${has(height) ? num(height) : 'null'}, P = ${has(scale_percent) ? num(scale_percent) : 'null'};
if (P !== null) { W = Math.max(1, Math.round(w0 * P / 100)); H = Math.max(1, Math.round(h0 * P / 100)); }
else if (W !== null && H === null) { H = Math.max(1, Math.round(h0 * W / w0)); }
else if (H !== null && W === null) { W = Math.max(1, Math.round(w0 * H / h0)); }
if (W > 30000 || H > 30000) { __fail('Kích thước quá lớn: ' + W + 'x' + H); return; }
doc.resizeImage(W, H, null, ResampleMethod.BICUBIC);
__ok({ from: w0 + 'x' + h0, to: __num(doc.width) + 'x' + __num(doc.height) });`);
    },
  },
  {
    name: 'crop',
    label: 'Cắt ảnh',
    kind: 'script',
    description:
      'Crop the image. Either give a rectangle (x, y, width, height in document pixels), or give aspect_ratio ' +
      '(e.g. "1:1", "16:9", "4:5") to cut the largest centered area with that ratio; with aspect_ratio you may pass ' +
      'center_x/center_y to keep a subject in frame. The rectangle is clamped to the image.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        width: { type: 'number', minimum: 1 }, height: { type: 'number', minimum: 1 },
        aspect_ratio: { type: 'string', description: 'Tỉ lệ khung dạng "W:H", ví dụ "1:1" hoặc "16:9".' },
        center_x: { type: 'number', description: 'Tâm vùng cắt theo trục x (chỉ dùng với aspect_ratio).' },
        center_y: { type: 'number', description: 'Tâm vùng cắt theo trục y (chỉ dùng với aspect_ratio).' },
      },
      additionalProperties: false,
    },
    build({ x, y, width, height, aspect_ratio, center_x, center_y }) {
      let ratio = 'null';
      if (has(aspect_ratio)) {
        const m = String(aspect_ratio).trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
        if (!m || Number(m[1]) <= 0 || Number(m[2]) <= 0) throw new Error(`aspect_ratio không hợp lệ: "${aspect_ratio}" (ví dụ "16:9")`);
        ratio = num(Number(m[1]) / Number(m[2]));
      } else if (!(has(width) && has(height))) {
        throw new Error('Cần (x, y, width, height) hoặc aspect_ratio.');
      }
      return wrap(`
var w0 = __num(doc.width), h0 = __num(doc.height);
var R = ${ratio};
var x, y, w, h;
if (R !== null) {
  if (w0 / h0 > R) { h = h0; w = Math.round(h0 * R); } else { w = w0; h = Math.round(w0 / R); }
  var cx = ${has(center_x) ? num(center_x) : 'w0 / 2'}, cy = ${has(center_y) ? num(center_y) : 'h0 / 2'};
  x = Math.round(Math.min(Math.max(cx - w / 2, 0), w0 - w));
  y = Math.round(Math.min(Math.max(cy - h / 2, 0), h0 - h));
} else {
  x = ${has(x) ? num(x) : 0}; y = ${has(y) ? num(y) : 0}; w = ${has(width) ? num(width) : 0}; h = ${has(height) ? num(height) : 0};
  if (x < 0) { w = w + x; x = 0; }
  if (y < 0) { h = h + y; y = 0; }
  w = Math.min(w, w0 - x); h = Math.min(h, h0 - y);
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
}
if (w < 1 || h < 1) { __fail('Vùng cắt nằm ngoài ảnh (ảnh có kích thước ' + w0 + 'x' + h0 + ').'); return; }
doc.crop([x, y, x + w, y + h]);
__ok({ crop: { x: x, y: y, width: w, height: h }, new_size: __num(doc.width) + 'x' + __num(doc.height) });`);
    },
  },
  {
    name: 'rotate_flip_image',
    label: 'Xoay / lật ảnh',
    kind: 'script',
    description: 'Rotate the whole image by an angle (degrees, clockwise; 90/180/-90 or any value) and/or flip it.',
    input_schema: {
      type: 'object',
      properties: {
        angle: { type: 'number', minimum: -360, maximum: 360, description: 'Góc xoay theo chiều kim đồng hồ.' },
        flip: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Lật ngang hoặc lật dọc.' },
      },
      additionalProperties: false,
    },
    build({ angle, flip }) {
      if (!has(angle) && !has(flip)) throw new Error('Cần angle hoặc flip.');
      const lines = [];
      if (has(angle) && Number(angle) !== 0) lines.push(`doc.rotateCanvas(${num(angle)});`);
      if (flip) lines.push(`doc.flipCanvas(Direction.${flip === 'vertical' ? 'VERTICAL' : 'HORIZONTAL'});`);
      return wrap(`${lines.join('\n')}
__ok({ new_size: __num(doc.width) + 'x' + __num(doc.height) });`);
    },
  },
  {
    name: 'resize_canvas',
    label: 'Đổi khung ảnh / thêm viền',
    kind: 'script',
    description:
      'Change the canvas size WITHOUT scaling the content (adds empty space or cuts edges). Use padding to add an equal ' +
      'border on all sides, or width/height for an exact size with an anchor. New area is transparent unless fill_color ' +
      'is given (then a fill layer named "Nền khung" is added at the bottom).',
    input_schema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1, maximum: 30000 },
        height: { type: 'integer', minimum: 1, maximum: 30000 },
        padding: { type: 'integer', minimum: 1, maximum: 5000, description: 'Thêm viền đều 4 cạnh (pixel).' },
        anchor: { type: 'string', enum: Object.keys(ANCHORS), description: 'Vị trí giữ nội dung cũ. Mặc định center.' },
        fill_color: COLOR_PARAM('Màu cho phần khung mới.'),
      },
      additionalProperties: false,
    },
    build({ width, height, padding, anchor = 'center', fill_color }) {
      if (!has(padding) && !(has(width) || has(height))) throw new Error('Cần padding hoặc width/height.');
      const fill = has(fill_color)
        ? `var __prev = doc.activeLayer; var __f = doc.artLayers.add(); __f.name = 'Nền khung';
doc.selection.selectAll(); doc.selection.fill(__color(${lit(hex(fill_color))})); doc.selection.deselect();
__f.move(doc.layers[doc.layers.length - 1], ElementPlacement.PLACEAFTER); doc.activeLayer = __prev;`
        : '';
      return wrap(`
var w0 = __num(doc.width), h0 = __num(doc.height);
var W = ${has(width) ? num(width) : 'w0'}, H = ${has(height) ? num(height) : 'h0'};
${has(padding) ? `W = w0 + 2 * ${num(padding)}; H = h0 + 2 * ${num(padding)};` : ''}
doc.resizeCanvas(W, H, AnchorPosition.${ANCHORS[anchor] ?? 'MIDDLECENTER'});
${fill}
__ok({ from: w0 + 'x' + h0, to: __num(doc.width) + 'x' + __num(doc.height) });`);
    },
  },

  // ───────────────────────────── Điều chỉnh màu & ánh sáng ─────────────────────────────
  {
    name: 'adjust_brightness_contrast',
    label: 'Chỉnh sáng / tương phản',
    kind: 'script',
    description:
      'Change brightness and/or contrast of a pixel layer (inside the selection if there is one). ' +
      'Typical gentle values: brightness ±10..30, contrast ±10..25.',
    input_schema: {
      type: 'object',
      properties: {
        brightness: { type: 'integer', minimum: -100, maximum: 100 },
        contrast: { type: 'integer', minimum: -100, maximum: 100 },
        layer: LAYER_PARAM,
      },
      additionalProperties: false,
    },
    build({ brightness = 0, contrast = 0, layer }) {
      return wrap(`${targetLayer(layer, { requirePixels: true })}
layer.adjustBrightnessContrast(${num(brightness)}, ${num(contrast)});
__ok({ layer: layer.name, brightness: ${num(brightness)}, contrast: ${num(contrast)} });`);
    },
  },
  {
    name: 'adjust_levels',
    label: 'Chỉnh Levels',
    kind: 'script',
    description:
      'Levels on a pixel layer, for the combined image (channel "rgb") or one color channel. Raise input_black to deepen ' +
      'shadows, lower input_white to brighten highlights, gamma > 1 brightens midtones. On a single channel it shifts color, ' +
      'e.g. channel "blue" with gamma 0.9 makes the image warmer.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['rgb', 'red', 'green', 'blue'], description: 'Mặc định rgb.' },
        input_black: { type: 'integer', minimum: 0, maximum: 253 },
        input_white: { type: 'integer', minimum: 2, maximum: 255 },
        gamma: { type: 'number', minimum: 0.1, maximum: 9.99 },
        output_black: { type: 'integer', minimum: 0, maximum: 255 },
        output_white: { type: 'integer', minimum: 0, maximum: 255 },
        layer: LAYER_PARAM,
      },
      additionalProperties: false,
    },
    build({ channel = 'rgb', input_black = 0, input_white = 255, gamma = 1, output_black = 0, output_white = 255, layer }) {
      if (Number(input_black) >= Number(input_white)) throw new Error('input_black phải nhỏ hơn input_white.');
      return wrap(`${targetLayer(layer, { requirePixels: true })}
${amLevels({ channel, inputBlack: input_black, inputWhite: input_white, gamma, outputBlack: output_black, outputWhite: output_white })}
__ok({ layer: layer.name, channel: ${lit(channel)} });`);
    },
  },
  {
    name: 'adjust_curves',
    label: 'Chỉnh Curves',
    kind: 'script',
    description:
      'Curves on a pixel layer: `rgb` for overall tone/contrast and/or `red`, `green`, `blue` for color grading, all in ' +
      'one step. Each is a list of [input, output] points in 0..255; include [0,0] and [255,255] unless you want to ' +
      'lift/clip. Gentle S-curve for contrast: rgb [[0,0],[64,54],[192,202],[255,255]]. Color examples: warmer highlights ' +
      '= blue [[0,0],[192,180],[255,240]]; teal shadows = red [[0,0],[64,54],[255,255]] + blue [[0,0],[64,76],[255,255]].',
    input_schema: {
      type: 'object',
      properties: {
        rgb: CURVE_PARAM('Đường cong cho cả ảnh (độ sáng/tương phản).'),
        red: CURVE_PARAM('Đường cong kênh đỏ.'),
        green: CURVE_PARAM('Đường cong kênh xanh lá.'),
        blue: CURVE_PARAM('Đường cong kênh xanh dương.'),
        points: CURVE_PARAM('Tên cũ của `rgb` (giữ để tương thích).'),
        layer: LAYER_PARAM,
      },
      additionalProperties: false,
    },
    build({ rgb, red, green, blue, points, layer }) {
      const curves = { rgb: rgb ?? points, red, green, blue };
      const used = Object.keys(curves).filter((k) => curves[k]);
      if (!used.length) throw new Error('Cần ít nhất một đường cong: rgb, red, green hoặc blue.');
      return wrap(`${targetLayer(layer, { requirePixels: true })}
${amCurves(curves)}
__ok({ layer: layer.name, channels: ${lit(used.join(','))} });`);
    },
  },
  {
    name: 'adjust_hue_saturation',
    label: 'Chỉnh màu / độ bão hoà',
    kind: 'script',
    description:
      'Hue/Saturation on a pixel layer, for all colors or only one color range (reds, yellows, greens, cyans, blues, ' +
      'magentas) — e.g. make only the sky bluer (blues: saturation +25), calm red skin (reds: saturation -15), turn green ' +
      'leaves autumn-orange (greens: hue -40). saturation -100 = gray, +20..40 = more vivid. hue shifts colors in degrees. ' +
      'colorize=true tints everything with one hue (hue 0..360; 30 = sepia, 200 = blue); color_range is ignored then.',
    input_schema: {
      type: 'object',
      properties: {
        color_range: { type: 'string', enum: COLOR_RANGES, description: 'Dải màu áp dụng, mặc định all.' },
        hue: { type: 'integer', minimum: -180, maximum: 360 },
        saturation: { type: 'integer', minimum: -100, maximum: 100 },
        lightness: { type: 'integer', minimum: -100, maximum: 100 },
        colorize: { type: 'boolean' },
        layer: LAYER_PARAM,
      },
      additionalProperties: false,
    },
    build({ color_range = 'all', hue = 0, saturation = 0, lightness = 0, colorize = false, layer }) {
      return wrap(`${targetLayer(layer, { requirePixels: true })}
${amHueSaturation({ hue, saturation, lightness, colorize, range: color_range })}
__ok({ layer: layer.name, color_range: ${lit(colorize ? 'all' : color_range)} });`);
    },
  },
  {
    name: 'adjust_color_balance',
    label: 'Cân bằng màu',
    kind: 'script',
    description:
      'Color Balance on a pixel layer — the main tool for fixing a color cast / white balance and for color grading. ' +
      'Each of shadows, midtones, highlights is [cyan↔red, magenta↔green, yellow↔blue] from -100 to 100 ' +
      '(positive = more red / more green / more blue). Photo too yellow/warm → midtones [0,0,+15..30]; too blue → ' +
      '[0,0,-15..30]; too green → [0,-10..20,0]; warmer look → midtones [+10,0,-15]. Keep values small (5..30).',
    input_schema: {
      type: 'object',
      properties: {
        shadows: BALANCE_PARAM('Vùng tối.'),
        midtones: BALANCE_PARAM('Vùng trung tính.'),
        highlights: BALANCE_PARAM('Vùng sáng.'),
        preserve_luminosity: { type: 'boolean', description: 'Giữ độ sáng (mặc định true).' },
        layer: LAYER_PARAM,
      },
      additionalProperties: false,
    },
    build({ shadows, midtones, highlights, preserve_luminosity = true, layer }) {
      if (!shadows && !midtones && !highlights) throw new Error('Cần shadows, midtones hoặc highlights.');
      return wrap(`${targetLayer(layer, { requirePixels: true })}
${amColorBalance({ shadows, midtones, highlights, preserveLuminosity: preserve_luminosity })}
__ok({ layer: layer.name });`);
    },
  },
  {
    name: 'adjust_vibrance',
    label: 'Chỉnh độ rực màu',
    kind: 'script',
    description:
      'Vibrance/Saturation on a pixel layer. Vibrance boosts muted colors more than already-saturated ones ' +
      '(good for skin tones and landscapes). Typical: vibrance +20..50.',
    input_schema: {
      type: 'object',
      properties: {
        vibrance: { type: 'integer', minimum: -100, maximum: 100 },
        saturation: { type: 'integer', minimum: -100, maximum: 100 },
        layer: LAYER_PARAM,
      },
      additionalProperties: false,
    },
    build({ vibrance = 0, saturation = 0, layer }) {
      return wrap(`${targetLayer(layer, { requirePixels: true })}
${amVibrance({ vibrance, saturation })}
__ok({ layer: layer.name });`);
    },
  },
  {
    name: 'auto_adjust',
    label: 'Tự động cân chỉnh',
    kind: 'script',
    description: 'One-click automatic correction of a pixel layer: auto_levels (tone and color cast) or auto_contrast.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto_levels', 'auto_contrast'] },
        layer: LAYER_PARAM,
      },
      required: ['mode'],
      additionalProperties: false,
    },
    build({ mode, layer }) {
      return wrap(`${targetLayer(layer, { requirePixels: true })}
layer.${mode === 'auto_contrast' ? 'autoContrast' : 'autoLevels'}();
__ok({ layer: layer.name, mode: ${lit(mode)} });`);
    },
  },
  {
    name: 'color_effect',
    label: 'Hiệu ứng màu',
    kind: 'script',
    description:
      'Color effects on a pixel layer: grayscale (black & white), sepia, invert, warm, cool, posterize, threshold. ' +
      'amount: for warm/cool/sepia = strength 1..100 (default 35/35/60); posterize = number of levels 2..64 (default 6); ' +
      'threshold = level 1..255 (default 128).',
    input_schema: {
      type: 'object',
      properties: {
        effect: { type: 'string', enum: ['grayscale', 'sepia', 'invert', 'warm', 'cool', 'posterize', 'threshold'] },
        amount: { type: 'number', minimum: 1, maximum: 255 },
        layer: LAYER_PARAM,
      },
      required: ['effect'],
      additionalProperties: false,
    },
    build({ effect, amount, layer }) {
      let body;
      switch (effect) {
        case 'grayscale': body = 'layer.desaturate();'; break;
        case 'invert': body = 'layer.invert();'; break;
        case 'warm': body = photoFilter('#EC8A00', Math.min(100, amount ?? 35)); break;
        case 'cool': body = photoFilter('#006DFF', Math.min(100, amount ?? 35)); break;
        case 'sepia': body = `layer.desaturate();\n${photoFilter('#AC7A33', Math.min(100, amount ?? 60))}`; break;
        case 'posterize':
          body = `var d = new ActionDescriptor(); d.putInteger(_c('Lvls'), ${num(Math.round(Math.min(64, Math.max(2, amount ?? 6))))}); app.executeAction(_c('Pstr'), d, DialogModes.NO);`;
          break;
        case 'threshold':
          body = `var d = new ActionDescriptor(); d.putInteger(_c('Lvl '), ${num(Math.round(Math.min(255, Math.max(1, amount ?? 128))))}); app.executeAction(_c('Thrs'), d, DialogModes.NO);`;
          break;
        default: throw new Error(`Hiệu ứng không hỗ trợ: ${effect}`);
      }
      return wrap(`${targetLayer(layer, { requirePixels: true })}
${body}
__ok({ layer: layer.name, effect: ${lit(effect)} });`);
    },
  },
  {
    name: 'color_grade',
    label: 'Chỉnh màu theo phong cách',
    kind: 'script',
    description:
      'Apply a ready-made color grading look to a pixel layer (inside the selection if any). Presets: ' +
      Object.entries(COLOR_PRESETS).map(([k, p]) => `${k} (${p.label})`).join('; ') + '. ' +
      'strength 10..100 (default 60). Use for requests like "chỉnh màu kiểu điện ảnh", "tone Hàn Quốc", "màu vintage". ' +
      'It takes several history steps (returned as history_steps); to remove it use undo with that many steps.',
    input_schema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: Object.keys(COLOR_PRESETS) },
        strength: { type: 'number', minimum: 10, maximum: 100 },
        layer: LAYER_PARAM,
      },
      required: ['preset'],
      additionalProperties: false,
    },
    build({ preset, strength = 60, layer }) {
      const def = COLOR_PRESETS[preset];
      if (!def) throw new Error(`Không có preset "${preset}".`);
      const steps = def.steps(Math.min(100, Math.max(10, Number(strength))) / 100);
      return wrap(`${targetLayer(layer, { requirePixels: true })}
${steps.join('\n')}
__ok({ layer: layer.name, preset: ${lit(preset)}, strength: ${num(strength)}, history_steps: ${steps.length} });`);
    },
  },
  {
    name: 'apply_filter',
    label: 'Áp bộ lọc',
    kind: 'script',
    description:
      'Filters on a pixel layer (inside the selection if any): blur (gaussian, radius px), motion_blur (angle deg, distance px), ' +
      'sharpen, sharpen_more, unsharp_mask (amount %, radius px, threshold — the best general sharpening, typical 80/1.5/2), ' +
      'add_noise (amount %, film grain), reduce_noise (median, radius px 1..3).',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['blur', 'motion_blur', 'sharpen', 'sharpen_more', 'unsharp_mask', 'add_noise', 'reduce_noise'] },
        radius: { type: 'number', minimum: 0.1, maximum: 250 },
        amount: { type: 'number', minimum: 1, maximum: 500 },
        threshold: { type: 'integer', minimum: 0, maximum: 255 },
        angle: { type: 'number', minimum: -360, maximum: 360 },
        distance: { type: 'number', minimum: 1, maximum: 2000 },
        layer: LAYER_PARAM,
      },
      required: ['filter'],
      additionalProperties: false,
    },
    build({ filter, radius, amount, threshold, angle, distance, layer }) {
      let body;
      switch (filter) {
        case 'blur': body = `layer.applyGaussianBlur(${num(radius ?? 2)});`; break;
        case 'motion_blur': body = `layer.applyMotionBlur(${num(angle ?? 0)}, ${num(distance ?? 10)});`; break;
        case 'sharpen': body = 'layer.applySharpen();'; break;
        case 'sharpen_more': body = 'layer.applySharpenMore();'; break;
        case 'add_noise': body = `layer.applyAddNoise(${num(Math.min(400, amount ?? 5))});`; break;
        case 'unsharp_mask':
          body = `var d = new ActionDescriptor(); d.putUnitDouble(_c('Amnt'), _c('#Prc'), ${num(amount ?? 80)});
d.putUnitDouble(_c('Rds '), _c('#Pxl'), ${num(radius ?? 1.5)}); d.putInteger(_c('Thsh'), ${num(threshold ?? 2)});
app.executeAction(_s('unsharpMask'), d, DialogModes.NO);`;
          break;
        case 'reduce_noise':
          body = `var d = new ActionDescriptor(); d.putUnitDouble(_c('Rds '), _c('#Pxl'), ${num(Math.min(10, radius ?? 1))}); app.executeAction(_c('Mdn '), d, DialogModes.NO);`;
          break;
        default: throw new Error(`Bộ lọc không hỗ trợ: ${filter}`);
      }
      return wrap(`${targetLayer(layer, { requirePixels: true })}
${body}
__ok({ layer: layer.name, filter: ${lit(filter)} });`);
    },
  },

  // ───────────────────────────── Vùng chọn ─────────────────────────────
  {
    name: 'select_area',
    label: 'Tạo vùng chọn',
    kind: 'script',
    description:
      'Make or change the selection. Later adjustments, filters and fill/clear only affect the selected area. ' +
      'mode: rect / ellipse (need x, y, width, height), all, none (deselect), invert. feather softens the edge (px). ' +
      'Remember to select none when you are done with local edits.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['rect', 'ellipse', 'all', 'none', 'invert'] },
        x: { type: 'number' }, y: { type: 'number' },
        width: { type: 'number', minimum: 1 }, height: { type: 'number', minimum: 1 },
        feather: { type: 'number', minimum: 0, maximum: 500 },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    build({ mode, x, y, width, height, feather = 0 }) {
      let body;
      if (mode === 'rect' || mode === 'ellipse') {
        if (![x, y, width, height].every(has)) throw new Error('Chế độ rect/ellipse cần x, y, width, height.');
        const pts = mode === 'rect' ? rectPoints(x, y, width, height) : ellipsePoints(Number(x), Number(y), Number(width), Number(height));
        body = `doc.selection.select(${pts}, SelectionType.REPLACE, ${num(feather)});`;
      } else if (mode === 'all') body = 'doc.selection.selectAll();';
      else if (mode === 'none') body = 'doc.selection.deselect();';
      else body = `doc.selection.invert();${Number(feather) > 0 ? ` doc.selection.feather(${num(feather)});` : ''}`;
      return wrap(`${body}
__ok({ mode: ${lit(mode)} });`);
    },
  },
  {
    name: 'select_by_color',
    label: 'Chọn vùng theo màu',
    kind: 'client',
    description:
      'Select pixels by color, so the next adjustments, color changes or ai_edit apply only there. Methods: ' +
      'magic_wand — the connected area of similar color around point (x, y) in document pixels, e.g. click in the sky ' +
      '(pick the point from view_image); color — every pixel close to a given color; hue_range — every pixel in a color ' +
      'family (reds, yellows, greens, cyans, blues, magentas), e.g. all foliage = greens. tolerance 1..100 (default 30). ' +
      'Returns the selected area and coverage; check it makes sense before editing, and clear it with select_area mode "none" when done.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['magic_wand', 'color', 'hue_range'] },
        x: { type: 'number' }, y: { type: 'number' },
        contiguous: { type: 'boolean', description: 'magic_wand: chỉ vùng liền kề (mặc định true).' },
        color: COLOR_PARAM('Màu cần chọn (method color).'),
        hue_range: { type: 'string', enum: COLOR_RANGES.filter((r) => r !== 'all') },
        tolerance: { type: 'number', minimum: 1, maximum: 100 },
        feather: { type: 'number', minimum: 0, maximum: 200, description: 'Làm mềm mép vùng chọn (px).' },
      },
      required: ['method'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_selection',
    label: 'Tô / xoá vùng chọn',
    kind: 'script',
    description:
      'On a pixel layer: fill the selection with a color (whole layer if nothing is selected), clear it (make transparent), ' +
      'or stroke its outline. opacity 1..100 for fill.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['fill', 'clear', 'stroke'] },
        color: COLOR_PARAM('Màu tô / màu viền.'),
        opacity: { type: 'number', minimum: 1, maximum: 100 },
        stroke_width: { type: 'integer', minimum: 1, maximum: 250 },
        layer: LAYER_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    build({ action, color, opacity = 100, stroke_width = 3, layer }) {
      let body;
      if (action === 'fill') {
        if (!has(color)) throw new Error('fill cần color.');
        body = `doc.selection.fill(__color(${lit(hex(color))}), ColorBlendMode.NORMAL, ${num(opacity)});`;
      } else if (action === 'stroke') {
        if (!has(color)) throw new Error('stroke cần color.');
        body = `doc.selection.stroke(__color(${lit(hex(color))}), ${num(stroke_width)});`;
      } else body = 'doc.selection.clear();';
      return wrap(`${targetLayer(layer, { requirePixels: true })}
${body}
__ok({ layer: layer.name, action: ${lit(action)} });`);
    },
  },

  // ───────────────────────────── Chữ & hình ─────────────────────────────
  {
    name: 'add_text',
    label: 'Thêm chữ',
    kind: 'script',
    settleBounds: true,
    description:
      'Add a new text layer. x, y = position of the START OF THE BASELINE of the first line in document pixels ' +
      '(for align center/right, x is the center/right edge). Vietnamese text is supported. ' +
      'Fonts (PostScript names) that support Vietnamese: Roboto-Regular, Roboto-Bold, Roboto-Black, OpenSans-Regular, ' +
      'OpenSans-Bold, Montserrat-Regular, Montserrat-Bold, Montserrat-Black, BeVietnamPro-Bold, Lora-Regular, ' +
      'Merriweather-Bold, Oswald-Bold, DejaVuSans (default). Size is in pt; at 72 dpi 1pt = 1px. ' +
      'Returns the text bounds — check them (and view_image) to make sure the text fits inside the image.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Nội dung chữ; dùng \\n để xuống dòng.' },
        x: { type: 'number' }, y: { type: 'number' },
        size: { type: 'number', minimum: 1, maximum: 2000 },
        color: COLOR_PARAM('Màu chữ.'),
        font: { type: 'string' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
        bold: { type: 'boolean', description: 'In đậm giả lập (nên dùng font -Bold nếu có).' },
        italic: { type: 'boolean' },
        layer_name: { type: 'string' },
      },
      required: ['text', 'x', 'y'],
      additionalProperties: false,
    },
    build({ text, x, y, size = 48, color = '#000000', font, align = 'left', bold, italic, layer_name }) {
      const lines = [
        'var L = doc.artLayers.add();',
        'L.kind = LayerKind.TEXT;',
        'var t = L.textItem;',
        `t.contents = ${lit(String(text).replace(/\r?\n/g, '\r'))};`,
        `t.size = ${num(size)};`,
        `t.color = __color(${lit(hex(color))});`,
        `t.justification = Justification.${{ center: 'CENTER', right: 'RIGHT' }[align] ?? 'LEFT'};`,
        `t.position = [${num(x)}, ${num(y)}];`,
      ];
      if (has(font)) lines.push(`t.font = ${lit(font)};`);
      if (bold) lines.push('t.fauxBold = true;');
      if (italic) lines.push('t.fauxItalic = true;');
      if (has(layer_name)) lines.push(`L.name = ${lit(layer_name)};`);
      return wrap(`${lines.join('\n')}
__ok({ layer: L.name, font: t.font, bounds: __bounds(L), image_size: __num(doc.width) + 'x' + __num(doc.height) });`);
    },
  },
  {
    name: 'edit_text',
    label: 'Sửa chữ',
    kind: 'script',
    settleBounds: true,
    description: 'Change an existing text layer: content, size, color, font, alignment or position (baseline start).',
    input_schema: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'Tên layer chữ. Bỏ trống = layer đang chọn.' },
        text: { type: 'string' },
        size: { type: 'number', minimum: 1, maximum: 2000 },
        color: COLOR_PARAM('Màu chữ.'),
        font: { type: 'string' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
        x: { type: 'number' }, y: { type: 'number' },
      },
      additionalProperties: false,
    },
    build({ layer, text, size, color, font, align, x, y }) {
      const lines = [];
      if (has(text)) lines.push(`t.contents = ${lit(String(text).replace(/\r?\n/g, '\r'))};`);
      if (has(size)) lines.push(`t.size = ${num(size)};`);
      if (has(color)) lines.push(`t.color = __color(${lit(hex(color))});`);
      if (has(font)) lines.push(`t.font = ${lit(font)};`);
      if (has(align)) lines.push(`t.justification = Justification.${{ center: 'CENTER', right: 'RIGHT' }[align] ?? 'LEFT'};`);
      if (has(x) && has(y)) lines.push(`t.position = [${num(x)}, ${num(y)}];`);
      else if (has(x) || has(y)) throw new Error('Đổi vị trí cần cả x và y.');
      return wrap(`${targetLayer(layer)}
if (!__isText(layer)) { __fail('Layer "' + layer.name + '" không phải layer chữ.'); return; }
var t = layer.textItem;
${lines.join('\n')}
__ok({ layer: layer.name, bounds: __bounds(layer) });`);
    },
  },
  {
    name: 'add_shape',
    label: 'Vẽ hình',
    kind: 'script',
    description:
      'Draw a filled and/or outlined rectangle or ellipse on a NEW layer (e.g. a banner bar behind text, a badge, a frame). ' +
      'Use opacity for a semi-transparent overlay.',
    input_schema: {
      type: 'object',
      properties: {
        shape: { type: 'string', enum: ['rectangle', 'ellipse'] },
        x: { type: 'number' }, y: { type: 'number' },
        width: { type: 'number', minimum: 1 }, height: { type: 'number', minimum: 1 },
        fill_color: COLOR_PARAM('Màu tô bên trong.'),
        stroke_color: COLOR_PARAM('Màu viền.'),
        stroke_width: { type: 'integer', minimum: 1, maximum: 250 },
        opacity: { type: 'number', minimum: 1, maximum: 100, description: 'Độ mờ đục của layer hình (%).' },
        layer_name: { type: 'string' },
      },
      required: ['shape', 'x', 'y', 'width', 'height'],
      additionalProperties: false,
    },
    build({ shape, x, y, width, height, fill_color, stroke_color, stroke_width = 3, opacity, layer_name }) {
      if (!has(fill_color) && !has(stroke_color)) throw new Error('Cần fill_color hoặc stroke_color.');
      const pts = shape === 'ellipse' ? ellipsePoints(Number(x), Number(y), Number(width), Number(height)) : rectPoints(x, y, width, height);
      const lines = [
        'var L = doc.artLayers.add();',
        `L.name = ${lit(has(layer_name) ? layer_name : shape === 'ellipse' ? 'Hình elip' : 'Hình chữ nhật')};`,
        `doc.selection.select(${pts});`,
      ];
      if (has(fill_color)) lines.push(`doc.selection.fill(__color(${lit(hex(fill_color))}));`);
      if (has(stroke_color)) lines.push(`doc.selection.stroke(__color(${lit(hex(stroke_color))}), ${num(stroke_width)});`);
      lines.push('doc.selection.deselect();');
      if (has(opacity)) lines.push(`L.opacity = ${num(opacity)};`);
      return wrap(`${lines.join('\n')}
__ok({ layer: L.name, bounds: __bounds(L) });`);
    },
  },

  // ───────────────────────────── Layer ─────────────────────────────
  {
    name: 'manage_layer',
    label: 'Quản lý layer',
    kind: 'script',
    description:
      'Layer operations: select (make active), new (empty layer above the active one), duplicate, delete, rename, ' +
      'bring_to_front, send_to_back, move_up, move_down, merge_down (merge into the layer below), flatten (merge all).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['select', 'new', 'duplicate', 'delete', 'rename', 'bring_to_front', 'send_to_back', 'move_up', 'move_down', 'merge_down', 'flatten'],
        },
        layer: LAYER_PARAM,
        new_name: { type: 'string', description: 'Tên mới (cho new, duplicate, rename).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    build({ action, layer, new_name }) {
      const name = has(new_name) ? lit(new_name) : null;
      // Lưu ý: trong Photopea, so sánh đối tượng bằng === không đáng tin cậy, nên so sánh theo tên layer.
      const siblings = `var par = (layer.parent && layer.parent.layers) ? layer.parent : doc; var sib = par.layers; var idx = -1;
for (var i = 0; i < sib.length; i++) { if (sib[i].name === layer.name) { idx = i; break; } }`;
      const bodies = {
        select: '',
        new: `var N = doc.artLayers.add();${name ? ` N.name = ${name};` : ''} layer = N;`,
        duplicate: `var D = layer.duplicate();${name ? ` D.name = ${name};` : ''} doc.activeLayer = D; layer = D;`,
        delete: `if (doc.layers.length <= 1 && doc.layers[0].name === layer.name) { __fail('Không thể xoá layer duy nhất của ảnh.'); return; }
var __deleted = layer.name; layer.remove(); __ok({ deleted: __deleted, active_layer: doc.activeLayer.name }); return;`,
        rename: `${name ? `layer.name = ${name};` : "__fail('rename cần new_name.'); return;"}`,
        bring_to_front: 'if (doc.layers[0].name !== layer.name) { layer.move(doc.layers[0], ElementPlacement.PLACEBEFORE); }',
        send_to_back: 'var __last = doc.layers[doc.layers.length - 1]; if (__last.name !== layer.name) { layer.move(__last, ElementPlacement.PLACEAFTER); }',
        move_up: `${siblings}
if (idx > 0) { layer.move(sib[idx - 1], ElementPlacement.PLACEBEFORE); }`,
        move_down: `${siblings}
if (idx >= 0 && idx < sib.length - 1) { layer.move(sib[idx + 1], ElementPlacement.PLACEAFTER); }`,
        merge_down: 'layer = layer.merge();',
        flatten: 'doc.flatten(); layer = doc.activeLayer;',
      };
      if (!(action in bodies)) throw new Error(`Thao tác không hỗ trợ: ${action}`);
      return wrap(`${targetLayer(layer)}
${bodies[action]}
var order = [];
for (var k = 0; k < doc.layers.length && k < 30; k++) { order.push(doc.layers[k].name); }
__ok({ action: ${lit(action)}, active_layer: doc.activeLayer.name, top_level_layers_top_to_bottom: order });`);
    },
  },
  {
    name: 'layer_properties',
    label: 'Thuộc tính layer',
    kind: 'script',
    description: 'Set opacity (0..100), blend mode, or visibility of a layer.',
    input_schema: {
      type: 'object',
      properties: {
        layer: LAYER_PARAM,
        opacity: { type: 'number', minimum: 0, maximum: 100 },
        blend_mode: { type: 'string', enum: Object.keys(BLEND_MODES) },
        visible: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    build({ layer, opacity, blend_mode, visible }) {
      const lines = [];
      if (has(opacity)) lines.push(`layer.opacity = ${num(opacity)};`);
      if (has(blend_mode)) lines.push(`layer.blendMode = BlendMode.${BLEND_MODES[blend_mode]};`);
      if (typeof visible === 'boolean') lines.push(`layer.visible = ${visible};`);
      if (!lines.length) throw new Error('Cần opacity, blend_mode hoặc visible.');
      return wrap(`${targetLayer(layer)}
${lines.join('\n')}
__ok({ layer: layer.name, opacity: Math.round(layer.opacity), visible: layer.visible });`);
    },
  },
  {
    name: 'transform_layer',
    label: 'Di chuyển / biến đổi layer',
    kind: 'script',
    description:
      'Move, scale, rotate or flip ONE layer (not the whole image). move_x/move_y are offsets in pixels; or use ' +
      'align to snap the layer to an edge/center of the image (with optional margin). Scaling and rotation are around the layer center.',
    input_schema: {
      type: 'object',
      properties: {
        layer: LAYER_PARAM,
        move_x: { type: 'number' }, move_y: { type: 'number' },
        align: { type: 'string', enum: Object.keys(ANCHORS), description: 'Căn layer vào vị trí này của ảnh.' },
        margin: { type: 'number', minimum: 0, description: 'Khoảng cách tới mép ảnh khi dùng align (px).' },
        scale_percent: { type: 'number', minimum: 1, maximum: 2000 },
        rotate: { type: 'number', minimum: -360, maximum: 360 },
        flip: { type: 'string', enum: ['horizontal', 'vertical'] },
      },
      additionalProperties: false,
    },
    build({ layer, move_x, move_y, align, margin = 0, scale_percent, rotate, flip }) {
      const lines = [];
      if (has(scale_percent)) lines.push(`layer.resize(${num(scale_percent)}, ${num(scale_percent)}, AnchorPosition.MIDDLECENTER);`);
      if (has(rotate) && Number(rotate) !== 0) lines.push(`layer.rotate(${num(rotate)}, AnchorPosition.MIDDLECENTER);`);
      if (flip === 'horizontal') lines.push('layer.resize(-100, 100, AnchorPosition.MIDDLECENTER);');
      if (flip === 'vertical') lines.push('layer.resize(100, -100, AnchorPosition.MIDDLECENTER);');
      if (has(align)) {
        const a = ANCHORS[align];
        const m = num(margin);
        const tx = a.endsWith('LEFT') ? `${m} - b.x` : a.endsWith('RIGHT') ? `W - ${m} - (b.x + b.width)` : '(W - b.width) / 2 - b.x';
        const ty = a.startsWith('TOP') ? `${m} - b.y` : a.startsWith('BOTTOM') ? `H - ${m} - (b.y + b.height)` : '(H - b.height) / 2 - b.y';
        lines.push(`var b = __bounds(layer); var W = __num(doc.width), H = __num(doc.height);
layer.translate(Math.round(${tx}), Math.round(${ty}));`);
      }
      if (has(move_x) || has(move_y)) lines.push(`layer.translate(${num(move_x ?? 0)}, ${num(move_y ?? 0)});`);
      if (!lines.length) throw new Error('Không có phép biến đổi nào được yêu cầu.');
      return wrap(`${targetLayer(layer)}
if (layer.typename !== 'ArtLayer') { __fail('Chỉ biến đổi được layer ảnh hoặc layer chữ, không phải nhóm.'); return; }
${lines.join('\n')}
__ok({ layer: layer.name, bounds: __bounds(layer) });`);
    },
  },

  // ───────────────────────────── Lịch sử & xuất file ─────────────────────────────
  {
    name: 'undo',
    label: 'Hoàn tác',
    kind: 'client',
    description: 'Undo the last N editing steps (default 1). Use it when a result looks wrong instead of stacking corrections.',
    input_schema: {
      type: 'object',
      properties: { steps: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: 'redo',
    label: 'Làm lại',
    kind: 'client',
    description: 'Redo N steps that were just undone (default 1). Only works right after undo.',
    input_schema: {
      type: 'object',
      properties: { steps: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: 'export_image',
    label: 'Xuất / tải ảnh',
    kind: 'client',
    description:
      'Save the current image to the user\'s computer (browser download). Use when the user asks to export, save or download. ' +
      'jpg/webp quality 1..100 (default 90). psd keeps layers.',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpg', 'webp', 'psd'] },
        quality: { type: 'integer', minimum: 1, maximum: 100 },
        file_name: { type: 'string', description: 'Tên file không cần đuôi.' },
      },
      required: ['format'],
      additionalProperties: false,
    },
  },

  // ───────────────────────────── AI tạo ảnh ─────────────────────────────
  {
    name: 'ai_edit',
    label: 'Chỉnh sửa bằng AI',
    kind: 'client',
    description:
      'Generative fill / AI edit with an instruction-following image model: change the CONTENT of the photo — remove an ' +
      'object or person, add an object, replace the background, change one object\'s color or clothing, restyle. Slow ' +
      '(10-60 s per variation) and each variation costs money: use only for content changes the other tools cannot do. ' +
      'Where to edit: use_selection=true uses the selection the user drew in Photopea (any shape — like Photoshop ' +
      'Generative Fill; get_document_info shows whether a selection exists) and only that shape is replaced; or pass ' +
      '`region` (document pixels, around the object with a little room); or neither to edit the whole visible image ' +
      '(downscaled to at most 1536 px). With a selection or region, the image sent is that area plus ~50% context on each ' +
      'side, so the target is in the MIDDLE of what the model sees. Write `instruction` in ENGLISH, specific, describing ' +
      'the result, e.g. "Remove the person in the middle and fill the area naturally with the surrounding grass" or "Add a ' +
      'small white cat sitting in the middle of the image, matching the lighting". variations 1-3 (default 1): each result ' +
      'becomes its own layer, only the first visible — tell the user they can pick another. The original stays underneath. ' +
      'Check the result with view_image; if bad, delete the AI layer(s) with manage_layer and retry once with a clearer instruction.',
    input_schema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Chỉ dẫn bằng tiếng Anh, mô tả kết quả mong muốn.' },
        use_selection: { type: 'boolean', description: 'Dùng vùng chọn hiện tại trong Photopea (giống Generative Fill).' },
        region: {
          type: 'object',
          description: 'Vùng cần sửa (pixel tài liệu) khi không dùng vùng chọn. Bỏ trống cả hai = sửa toàn ảnh.',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number', minimum: 1 }, height: { type: 'number', minimum: 1 },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
        feather: { type: 'number', minimum: 0, maximum: 200, description: 'Làm mềm mép khi dùng region (px), mặc định 12.' },
        variations: { type: 'integer', minimum: 1, maximum: 3, description: 'Số phương án (mặc định 1).' },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
  },

  // ───────────────────────────── Script tự do ─────────────────────────────
  {
    name: 'run_script',
    label: 'Chạy script Photopea',
    kind: 'client',
    description:
      'Escape hatch: run a custom Photopea script (Photoshop-compatible JavaScript DOM: app, app.activeDocument, layers, ' +
      'selection, executeAction...). ONLY use when no other tool can do the job. Photopea uses its own limited interpreter: ' +
      'write simple ES5 — var/function/for loops only; NO arrow functions, template strings, `arguments`, or callbacks passed ' +
      'to built-in methods (no map/forEach/filter/sort(fn)). A runtime error aborts the script silently (try/catch does not ' +
      'catch it) and you only learn that it failed; earlier statements may already have been applied, so check with ' +
      'get_document_info/view_image and undo if needed. Return data with app.echoToOE(string).',
    input_schema: {
      type: 'object',
      properties: {
        script: { type: 'string' },
        purpose: { type: 'string', description: 'Mô tả ngắn script làm gì (hiển thị cho người dùng).' },
      },
      required: ['script', 'purpose'],
      additionalProperties: false,
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Định nghĩa tool gửi cho Claude API (chỉ name, description, input_schema). */
export function toolDefinitions() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/** Tên tiếng Việt để hiển thị. */
export function toolLabel(name) {
  return TOOL_MAP.get(name)?.label ?? name;
}
