// Thực thi các lệnh tool mà Claude yêu cầu, ngay trong trình duyệt.
import { TOOL_MAP } from './shared/tools.js';
import { validate } from './shared/validate.js';
import { RESULT_PREFIX, wrap, rectPoints, findUnsupportedSyntax } from './shared/script-kit.js';
import { postJson } from './api.js';
import { labStats, transferColors, describeStats } from './shared/color-transfer.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', psd: 'image/vnd.adobe.photoshop' };
const MATCH_LAYER = 'Màu theo ảnh mẫu';
// select_area đổi mép vùng chọn đang có (cần có vùng chọn: Photopea dừng script nếu không có).
const EDGE_MODES = { soften: 'làm mềm mép', expand: 'nới rộng', contract: 'thu hẹp' };
// Bật / tắt Quick Mask của Photopea (cùng một lệnh).
const QUICK_MASK = `var __q = new ActionDescriptor(); var __qr = new ActionReference();
__qr.putProperty(app.charIDToTypeID('Prpr'), app.charIDToTypeID('QucM')); __qr.putEnumerated(app.charIDToTypeID('Dcmn'), app.charIDToTypeID('Ordn'), app.charIDToTypeID('Trgt'));
__q.putReference(app.charIDToTypeID('null'), __qr); app.executeAction(app.charIDToTypeID('setd'), __q, DialogModes.NO);`;

/**
 * Kết quả của một lần chạy tool.
 * @typedef {{ isError: boolean, content: string | object[], preview?: string, download?: {url: string, name: string} }} ToolOutcome
 */

export class ToolRunner {
  /** @param {import('./photopea-bridge.js').PhotopeaBridge} bridge */
  constructor(bridge, { onDownload } = {}) {
    this.bridge = bridge;
    this.onDownload = onDownload;
    // Số bước đang hoàn tác so với trạng thái mới nhất (Photopea không cho đọc vị trí lịch sử hiện tại).
    this.undoDepth = 0;
    // Cạnh dài tối đa của ảnh gửi cho AI tạo ảnh (server gửi qua /api/health).
    this.aiMaxSide = 1024;
    // Ảnh mẫu để lấy màu (setReference): { id, name, stats, colors, thumb, width, height } hoặc null.
    this.reference = null;
    // Đang "tô vùng" (Quick Mask của Photopea) bằng nút của Bokin; onPaintChange(on) báo cho giao diện.
    this.painting = false;
  }

  /** Đặt ảnh mẫu (File/Blob ảnh): tính thống kê màu trên bản thu nhỏ, giữ ảnh nhỏ để hiện và gửi Claude. */
  async setReference(blob, name = 'ảnh mẫu') {
    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) throw new Error('Không đọc được ảnh mẫu (chỉ nhận JPG, PNG, WEBP).');
    const draw = (side) => {
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      const x = c.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingQuality = 'high';
      x.drawImage(bmp, 0, 0, c.width, c.height);
      return { c, x };
    };
    const big = draw(512);
    const stats = labStats(big.x.getImageData(0, 0, big.c.width, big.c.height).data);
    const small = draw(256);
    const width = bmp.width, height = bmp.height;
    bmp.close();
    if (!stats) throw new Error('Ảnh mẫu trong suốt hoàn toàn, không có màu để lấy.');
    this.reference = {
      id: Date.now(), name: String(name).slice(0, 80), stats, colors: describeStats(stats),
      thumb: small.c.toDataURL('image/jpeg', 0.85), width, height,
    };
    return this.reference;
  }

  clearReference() {
    this.reference = null;
  }

  /** Bắt đầu tô vùng: vùng chọn đang có hiện màu đỏ, tô thêm bằng cọ (đen = thêm, trắng = bớt). */
  async startPaint() {
    if (this.painting) return ok('Đang tô vùng.');
    if (!(await this._hasDocument())) return fail('Chưa có ảnh nào đang mở.');
    // Trong Quick Mask, màu đỏ là phần KHÔNG được chọn khi thoát ra: đảo vùng chọn trước để phần đang chọn hiện đỏ,
    // và khi tô xong thì đảo lại (finishPaint): phần tô đỏ chính là vùng chọn.
    if (await this._selectionBounds()) await this.bridge.exec('app.activeDocument.selection.invert();');
    const r = await this.bridge.exec(`${QUICK_MASK}
var __d = new ActionDescriptor(); var __r = new ActionReference(); __r.putClass(app.stringIDToTypeID('paintbrushTool'));
__d.putReference(app.charIDToTypeID('null'), __r); app.executeAction(app.charIDToTypeID('slct'), __d, DialogModes.NO);
app.echoToOE('painting');`);
    if (!r.completed) return fail('Photopea không vào được chế độ tô vùng.');
    this.painting = true;
    this.undoDepth = 0;
    this.onPaintChange?.(true);
    return ok('Đang tô vùng: tô màu đen lên chỗ cần chỉnh (hiện màu đỏ), phím X đổi sang trắng để xoá bớt.');
  }

  /** Tô xong: thoát Quick Mask, vùng vừa tô thành vùng chọn. */
  async finishPaint() {
    if (!this.painting) return ok('Không ở chế độ tô vùng.');
    this.painting = false;
    this.onPaintChange?.(false);
    const r = await this.bridge.exec(`${QUICK_MASK}\napp.echoToOE('done');`);
    if (!r.completed) return fail('Photopea không thoát được chế độ tô vùng; bấm phím Q trong Photopea.');
    await this.bridge.exec('app.activeDocument.selection.invert();');
    this.undoDepth = 0;
    const sel = await this._selectionBounds();
    return sel ? ok(JSON.stringify({ selection: sel })) : fail('Chưa tô vùng nào.');
  }

  async _hasDocument() {
    const r = await this.bridge.exec("app.echoToOE('__N__' + app.documents.length);");
    return Number((r.echoes.find((e) => e.startsWith('__N__')) ?? '__N__0').slice(5)) > 0;
  }

  /**
   * Chạy một tool rồi báo cho giao diện (onExecuted) để cập nhật trạng thái: còn ảnh không, vùng chọn,
   * và xoá danh sách "làm lại" khi có chỉnh sửa mới.
   * @returns {Promise<ToolOutcome>}
   */
  async execute(name, input = {}) {
    const outcome = await this._execute(name, input);
    try {
      await this.onExecuted?.(name, outcome);
    } catch { /* lỗi giao diện không được làm hỏng kết quả tool */ }
    return outcome;
  }

  async _execute(name, input = {}) {
    const tool = TOOL_MAP.get(name);
    if (!tool) return fail(`Không có công cụ tên "${name}".`);
    // Đang tô vùng bằng nút của Bokin: kết thúc trước, để lệnh chạy trên vùng chọn chứ không trên lớp mặt nạ tô.
    if (this.painting && name !== 'get_document_info') await this.finishPaint();
    const problems = validate(input, tool.input_schema);
    if (problems.length) return fail(`Tham số không hợp lệ: ${problems.join('; ')}`);
    try {
      if (name === 'select_area' && EDGE_MODES[input.mode] && !(await this._selectionBounds())) {
        return fail(`Chưa có vùng chọn để ${EDGE_MODES[input.mode]}. Khoanh hoặc tô vùng trước.`);
      }
      if (tool.kind === 'script') return await this._runScriptTool(tool, input);
      switch (name) {
        case 'view_image': return await this._viewImage(input);
        case 'undo': return await this._history(input.steps ?? 1);
        case 'redo': return await this._history(-(input.steps ?? 1));
        case 'export_image': return await this._export(input);
        case 'run_script': return await this._runRawScript(input.script);
        case 'ai_edit': return await this._aiEdit(input);
        case 'select_by_color': return await this._selectByColor(input);
        case 'match_reference_colors': return await this._matchReference(input);
        default: return fail(`Công cụ "${name}" chưa được cài đặt.`);
      }
    } catch (error) {
      return fail(error?.message ?? String(error));
    }
  }

  async _runScriptTool(tool, input) {
    let result = await this._runWrapped(tool.build(input));
    if (!result.isError && tool.name !== 'get_document_info') this.undoDepth = 0;
    if (!result.isError && tool.settleBounds) result = await this._settleBounds(result);
    if (!result.isError && tool.name === 'get_document_info') {
      const data = JSON.parse(result.content);
      if (data.has_document) {
        data.selection = this.painting ? null : await this._selectionBounds();
        if (this.painting) data.painting_selection = true;
        if (this.reference) data.reference_image = { name: this.reference.name, colors: this.reference.colors };
        result = ok(JSON.stringify(data));
      }
    }
    return result;
  }

  /**
   * Photopea vẽ chữ bất đồng bộ (tải font qua mạng), nên ngay sau khi tạo/sửa chữ, bounds có thể
   * bằng 0 hoặc còn là kích thước của font cũ. Đọc lại tới khi ổn định (tối đa ~3 giây).
   */
  async _settleBounds(result) {
    const data = JSON.parse(result.content);
    if (!data.layer) return result;
    let last = null;
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const r = await this._runWrapped(wrap(`
var L = __findLayer(doc, ${JSON.stringify(data.layer)});
if (!L) { __fail('not found'); return; }
__ok({ bounds: __bounds(L) });`));
      if (r.isError) break;
      const { bounds } = JSON.parse(r.content);
      if (last && bounds.width > 0 && JSON.stringify(bounds) === JSON.stringify(last)) break;
      last = bounds;
    }
    if (last) data.bounds = last;
    return ok(JSON.stringify(data));
  }

  /** Chạy script đã bọc bằng wrap() và đọc JSON kết quả. */
  async _runWrapped(script) {
    const r = await this.bridge.exec(script);
    const line = r.echoes.findLast((e) => e.startsWith(RESULT_PREFIX));
    if (!r.completed || !line) {
      return fail('Photopea báo lỗi khi thực hiện lệnh này (thường do layer/đối tượng không phù hợp với thao tác). Kiểm tra lại bằng get_document_info.');
    }
    const data = JSON.parse(line.slice(RESULT_PREFIX.length));
    if (!data.ok) return fail(data.error ?? 'Lỗi không rõ.');
    delete data.ok;
    return ok(JSON.stringify(data));
  }

  async _viewImage({ region, max_size: maxSize = 768 }) {
    const exported = await this.bridge.exportDocument('jpg:0.92');
    if (!exported) return fail('Chưa có ảnh nào đang mở.');
    const bitmap = await createImageBitmap(new Blob([exported.buffer], { type: 'image/jpeg' }));
    const docW = bitmap.width;
    const docH = bitmap.height;
    let sx = 0, sy = 0, sw = docW, sh = docH;
    if (region) {
      sx = Math.max(0, Math.min(docW - 1, Math.round(region.x)));
      sy = Math.max(0, Math.min(docH - 1, Math.round(region.y)));
      sw = Math.max(1, Math.min(docW - sx, Math.round(region.width)));
      sh = Math.max(1, Math.min(docH - sy, Math.round(region.height)));
    }
    const scale = Math.min(1, maxSize / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
    bitmap.close();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const ratio = +(1 / scale).toFixed(3);
    const where = region
      ? `vùng x=${sx}, y=${sy}, rộng ${sw}, cao ${sh} (góc trên-trái của ảnh xem trước ứng với điểm (${sx}, ${sy}) của tài liệu)`
      : 'toàn bộ ảnh';
    return {
      isError: false,
      preview: dataUrl,
      content: [
        {
          type: 'text',
          text: `Ảnh xem trước ${w}x${h} px của ${where}. Tài liệu có kích thước ${docW}x${docH} px. ` +
            `1 px trên ảnh xem trước = ${ratio} px tài liệu.`,
        },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) } },
      ],
    };
  }

  /** steps > 0: hoàn tác; steps < 0: làm lại. */
  async _history(steps) {
    const target = this.undoDepth + steps;
    if (steps < 0 && this.undoDepth === 0) return fail('Không có bước nào để làm lại.');
    const depth = Math.max(0, target);
    const result = await this._runWrapped(wrap(`
var hs = doc.historyStates;
var idx = hs.length - 1 - ${depth};
if (idx < 0) { __fail('Không thể hoàn tác thêm: lịch sử chỉ còn ' + (hs.length - 1 - ${this.undoDepth}) + ' bước.'); return; }
doc.activeHistoryState = hs[idx];
__ok({ history_steps: hs.length, now_at_step: idx + 1 });`));
    if (!result.isError) this.undoDepth = depth;
    return result;
  }

  async _export({ format, quality = 90, file_name: fileName }) {
    const q = Math.min(100, Math.max(1, quality)) / 100;
    const spec = format === 'jpg' || format === 'webp' ? `${format}:${q}` : format;
    const exported = await this.bridge.exportDocument(spec);
    if (!exported) return fail('Chưa có ảnh nào đang mở.');
    const name = `${safeFileName(fileName || exported.docName.replace(/\.[a-z0-9]+$/i, ''))}.${format}`;
    const blob = new Blob([exported.buffer], { type: MIME[format] });
    const url = URL.createObjectURL(blob);
    this.onDownload?.(url, name);
    return {
      isError: false,
      download: { url, name },
      content: JSON.stringify({ saved_as: name, size_kb: Math.round(blob.size / 1024) }),
    };
  }

  // ───────────────────────────── Vùng chọn ─────────────────────────────

  /**
   * Bounds của vùng chọn hiện tại, hoặc null nếu không có vùng chọn.
   * Lưu ý: đọc selection.bounds khi KHÔNG có vùng chọn làm Photopea dừng script im lặng,
   * nên việc kiểm tra phải nằm trong một script riêng.
   */
  async _selectionBounds() {
    const r = await this.bridge.exec(
      "if (app.documents.length) { var __b = app.activeDocument.selection.bounds; app.echoToOE('__SEL__' + __b[0].value + ',' + __b[1].value + ',' + __b[2].value + ',' + __b[3].value); }",
    );
    const line = r.echoes.find((e) => e.startsWith('__SEL__'));
    if (!line) return null;
    const [x0, y0, x1, y1] = line.slice('__SEL__'.length).split(',').map(Number);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /** Lưu vùng chọn (giữ nguyên hình dạng, độ mềm mép) vào một layer ẩn, rồi bỏ chọn. */
  async _saveSelection() {
    const token = `__bokin_sel_${Math.random().toString(36).slice(2)}`;
    const r = await this._runWrapped(wrap(`
var prev = doc.activeLayer;
var T = doc.artLayers.add();
T.name = ${JSON.stringify(token)};
doc.selection.fill(__color('FFFFFF'));
doc.selection.deselect();
T.visible = false;
doc.activeLayer = prev;
__ok({ bounds: __bounds(T) });`));
    if (r.isError) return r;
    return { isError: false, token, bounds: JSON.parse(r.content).bounds };
  }

  /** Khôi phục vùng chọn từ layer ẩn đã lưu rồi xoá layer đó. */
  async _restoreSelection(token) {
    return this._runWrapped(wrap(`
${loadSelectionCode(token)}
var T = __findLayer(doc, ${JSON.stringify(token)});
if (T) { T.remove(); }
__ok({});`));
  }

  /** Chọn vùng theo màu: magic wand (Photopea), hoặc theo màu / dải màu (tính trong trình duyệt). */
  async _selectByColor({ method, x, y, contiguous = true, color, hue_range: hueRange, tolerance = 30, feather = 0 }) {
    const featherCode = Number(feather) > 0 ? `doc.selection.feather(${Number(feather)});` : '';
    if (method === 'magic_wand') {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('magic_wand cần x, y (pixel tài liệu).');
      const r = await this._runWrapped(wrap(`
var d = new ActionDescriptor(); var ref = new ActionReference(); ref.putProperty(_c('Chnl'), _c('fsel')); d.putReference(_c('null'), ref);
var p = new ActionDescriptor(); p.putUnitDouble(_c('Hrzn'), _c('#Pxl'), ${Number(x)}); p.putUnitDouble(_c('Vrtc'), _c('#Pxl'), ${Number(y)});
d.putObject(_c('T   '), _c('Pnt '), p);
d.putInteger(_c('Tlrn'), ${Math.round(Number(tolerance) * 1.2)}); d.putBoolean(_c('AntA'), true);
d.putBoolean(_c('Cntg'), ${contiguous ? 'true' : 'false'}); d.putBoolean(_c('Mrgd'), true);
app.executeAction(_c('setd'), d, DialogModes.NO);
${featherCode}
__ok({});`));
      if (r.isError) return r;
      this.undoDepth = 0;
      return this._selectionSummary(method);
    }

    if (method === 'color' && !color) return fail('method color cần color (#RRGGBB).');
    if (method === 'hue_range' && !hueRange) return fail('method hue_range cần hue_range.');
    const exported = await this.bridge.exportDocument('png');
    if (!exported) return fail('Chưa có ảnh nào đang mở.');
    const bitmap = await createImageBitmap(new Blob([exported.buffer], { type: 'image/png' }));
    const W = bitmap.width;
    const H = bitmap.height;
    // Mask tính ở độ phân giải tối đa 2048px rồi Photopea phóng lên đúng kích thước (mép mềm, đủ chính xác).
    const scale = Math.min(1, 2048 / Math.max(W, H));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(W * scale));
    canvas.height = Math.max(1, Math.round(H * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const weight = method === 'color' ? colorWeight(color, tolerance) : hueWeight(hueRange, tolerance);
    let total = 0;
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] === 0 ? 0 : weight(d[i], d[i + 1], d[i + 2]);
      total += a;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(a * 255);
    }
    const coverage = total / (canvas.width * canvas.height);
    if (coverage < 0.0005) return fail('Không có vùng nào khớp màu này. Thử tăng tolerance hoặc chọn màu khác.');
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

    const prev = await this.bridge.exec('if (app.documents.length) { app.echoToOE(app.activeDocument.activeLayer.name); }');
    const prevName = prev.echoes[0];
    const token = `__bokin_mask_${Math.random().toString(36).slice(2)}`;
    const placed = await this._placeImageAsLayer(await blob.arrayBuffer(), { x: 0, y: 0, width: W, height: H }, token, { hidden: true });
    if (placed.isError) return placed;
    const r = await this._runWrapped(wrap(`
${loadSelectionCode(token)}
var T = __findLayer(doc, ${JSON.stringify(token)});
if (T) { T.remove(); }
var P = __findLayer(doc, ${JSON.stringify(prevName ?? '')});
if (P) { doc.activeLayer = P; }
${featherCode}
__ok({});`));
    if (r.isError) return r;
    this.undoDepth = 0;
    return this._selectionSummary(method, Math.round(coverage * 1000) / 10);
  }

  async _selectionSummary(method, coveragePercent) {
    const bounds = await this._selectionBounds();
    if (!bounds) return fail('Không chọn được vùng nào (thử tăng tolerance hoặc chọn điểm khác).');
    return ok(JSON.stringify({
      method,
      selection_bounds: bounds,
      ...(coveragePercent !== undefined ? { coverage_percent: coveragePercent } : {}),
      note: 'Vùng chọn đang hoạt động: các chỉnh sửa tiếp theo chỉ áp dụng trong vùng này.',
    }));
  }

  // ───────────────────────────── AI tạo ảnh ─────────────────────────────

  /**
   * Chỉnh sửa bằng AI (giống Generative Fill): gửi ảnh (hoặc vùng + ngữ cảnh) lên server -> mô hình AI ->
   * đặt mỗi kết quả thành một layer mới đúng vị trí, có mask theo vùng chọn / region.
   */
  async _aiEdit({ instruction, use_selection: useSelection, region, feather = 12, variations = 1 }) {
    let saved = null;
    if (useSelection) {
      if (!(await this._selectionBounds())) {
        return fail('Không có vùng chọn nào trong Photopea. Hãy nhờ người dùng khoanh vùng (công cụ Lasso / Marquee / Quick Selection), hoặc dùng region.');
      }
      saved = await this._saveSelection();
      if (saved.isError) return saved;
    }
    try {
      const exported = await this.bridge.exportDocument('png');
      if (!exported) return fail('Chưa có ảnh nào đang mở.');
      const bitmap = await createImageBitmap(new Blob([exported.buffer], { type: 'image/png' }));
      const W = bitmap.width;
      const H = bitmap.height;

      // Vùng cần sửa (target) và vùng gửi cho AI (area = target + lề ngữ cảnh 50% mỗi phía).
      let target = null;
      let maskRect = null;
      if (saved) target = clampRect(saved.bounds, W, H);
      else if (region) target = maskRect = clampRect(region, W, H);
      let area = { x: 0, y: 0, width: W, height: H };
      if (target) {
        const margin = Math.round(Math.max(target.width, target.height) * 0.5);
        const ax0 = Math.max(0, target.x - margin);
        const ay0 = Math.max(0, target.y - margin);
        area = {
          x: ax0, y: ay0,
          width: Math.min(W, target.x + target.width + margin) - ax0,
          height: Math.min(H, target.y + target.height + margin) - ay0,
        };
      }
      const scale = Math.min(1, this.aiMaxSide / Math.max(area.width, area.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(area.width * scale));
      canvas.height = Math.max(1, Math.round(area.height * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const sent = canvas.toDataURL('image/png');
      // Vùng cần sửa tính theo toạ độ ảnh gửi đi (để khớp màu theo phần ngữ cảnh bao quanh).
      const targetInSent = target && {
        x0: (target.x - area.x) * scale, y0: (target.y - area.y) * scale,
        x1: (target.x + target.width - area.x) * scale, y1: (target.y + target.height - area.y) * scale,
      };
      const image = sent.slice(sent.indexOf(',') + 1);

      // Các phương án chạy song song.
      const n = Math.min(3, Math.max(1, variations));
      const settled = await Promise.allSettled(Array.from({ length: n }, () => requestAiEdit(image, instruction)));
      const results = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value);
      if (!results.length) return fail(settled[0].reason?.message ?? 'Dịch vụ AI lỗi.');

      const layers = [];
      let matched = false;
      for (const [i, raw] of results.entries()) {
        const name = (results.length > 1 ? `AI ${i + 1}/${results.length}: ${instruction}` : `AI: ${instruction}`).slice(0, 60);
        // Khớp màu/độ sáng kết quả AI với ảnh gốc theo phần ngữ cảnh, để chỗ ghép không lộ viền.
        const fixed = targetInSent ? await matchColors(canvas, raw, targetInSent) : null;
        if (fixed) matched = true;
        const buffer = fixed ?? raw;
        const placed = await this._placeImageAsLayer(buffer, area, name, {
          maskRect, feather, maskLayer: saved?.token, hidden: i > 0,
        });
        if (placed.isError) return placed;
        layers.push(JSON.parse(placed.content).layer);
      }
      this.undoDepth = 0;
      return ok(JSON.stringify({
        layers,
        visible_layer: layers[0],
        sent_area: area,
        masked_to: saved ? 'selection' : maskRect,
        color_matched: matched,
        ...(results.length < n ? { failed_variations: n - results.length } : {}),
        note: layers.length > 1
          ? 'Mỗi phương án là một layer; chỉ layer đầu đang hiện. Ảnh gốc vẫn ở bên dưới. Kiểm tra bằng view_image.'
          : 'Kết quả AI nằm ở layer mới phía trên; ảnh gốc vẫn ở bên dưới. Kiểm tra bằng view_image.',
      }));
    } finally {
      // Trả lại vùng chọn của người dùng (giống Photoshop: vùng chọn vẫn còn sau Generative Fill).
      if (saved) await this._restoreSelection(saved.token);
    }
  }

  /**
   * Chỉnh màu vùng chọn (hoặc cả ảnh) theo ảnh mẫu (setReference): tính trong trình duyệt (Lab, giống Match Color),
   * đặt kết quả thành layer mới có mask đúng hình vùng chọn; độ mạnh = độ mờ đục của layer.
   */
  async _matchReference({ strength = 100, keep_brightness: keepBrightness = false, use_selection: useSelection = true } = {}) {
    const ref = this.reference;
    if (!ref) return fail('Chưa có ảnh mẫu. Nhờ người dùng chọn ảnh mẫu (nút "Ảnh mẫu" trong tab Màu nhanh hoặc cạnh ô chat).');
    let saved = null;
    if (useSelection && (await this._selectionBounds())) {
      saved = await this._saveSelection();
      if (saved.isError) return saved;
    }
    try {
      const exported = await this.bridge.exportDocument('png');
      if (!exported) return fail('Chưa có ảnh nào đang mở.');
      const bitmap = await createImageBitmap(new Blob([exported.buffer], { type: 'image/png' }));
      const W = bitmap.width;
      const H = bitmap.height;
      const area = saved ? clampRect(saved.bounds, W, H) : { x: 0, y: 0, width: W, height: H };
      const canvas = document.createElement('canvas');
      canvas.width = area.width;
      canvas.height = area.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
      bitmap.close();
      const image = ctx.getImageData(0, 0, area.width, area.height);
      const weights = saved ? await this._selectionWeights(saved.token, area, W, H) : null;
      if (saved && !weights) return fail('Không đọc được hình dạng vùng chọn.');
      const source = labStats(image.data, { weights });
      if (!source) return fail('Vùng chọn trống (hoặc toàn điểm trong suốt).');
      transferColors(image.data, source, ref.stats, { keepBrightness: Boolean(keepBrightness) });
      ctx.putImageData(image, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const opacity = Math.round(Math.min(100, Math.max(10, Number(strength) || 100)));
      const placed = await this._placeImageAsLayer(await blob.arrayBuffer(), area, MATCH_LAYER, {
        maskLayer: saved?.token, opacity,
      });
      if (placed.isError) return placed;
      this.undoDepth = 0;
      return ok(JSON.stringify({
        layer: JSON.parse(placed.content).layer,
        area,
        masked_to: saved ? 'selection' : 'whole image',
        strength: opacity,
        keep_brightness: Boolean(keepBrightness),
        reference: { name: ref.name, colors: ref.colors },
        before: describeStats(source),
        note: 'Kết quả ở layer mới phía trên, ảnh gốc vẫn ở dưới; độ mạnh là độ mờ đục của layer.',
      }));
    } finally {
      if (saved) await this._restoreSelection(saved.token);
    }
  }

  /** Độ đậm (0-255) của vùng chọn đã lưu trong `area`: chép layer vùng chọn sang tài liệu tạm rồi xuất PNG. */
  async _selectionWeights(token, area, W, H) {
    const r = await this.bridge.exec(wrap(`
var T = __findLayer(doc, ${JSON.stringify(token)});
if (!T) { __fail('Không thấy vùng chọn đã lưu.'); return; }
var tmp = app.documents.add(${W}, ${H}, 72, '__bokin_mask', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
app.activeDocument = doc;
T.duplicate(tmp);
app.activeDocument = tmp;
tmp.activeLayer.visible = true;
tmp.saveToOE('png');
tmp.close(2);
app.activeDocument = doc;
__ok({});`));
    const line = r.echoes.findLast((e) => e.startsWith(RESULT_PREFIX));
    if (!r.completed || !line || !JSON.parse(line.slice(RESULT_PREFIX.length)).ok || !r.files.length) return null;
    const bmp = await createImageBitmap(new Blob([r.files.at(-1)], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = area.width;
    c.height = area.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
    bmp.close();
    const d = x.getImageData(0, 0, area.width, area.height).data;
    const w = new Uint8Array(area.width * area.height);
    for (let i = 0; i < w.length; i++) w[i] = d[i * 4 + 3];
    return w;
  }

  /**
   * Mở ảnh như tài liệu tạm, chép layer sang tài liệu đang làm việc, co giãn vào `area`.
   * options.maskRect: chỉ giữ vùng chữ nhật này (mép mềm = feather); options.maskLayer: mask theo độ trong suốt
   * của layer đó (vùng chọn đã lưu); options.hidden: ẩn layer sau khi đặt.
   */
  async _placeImageAsLayer(buffer, area, layerName, { maskRect = null, feather = 0, maskLayer = null, hidden = false, opacity = 100 } = {}) {
    const token = `__bokin_${Math.random().toString(36).slice(2)}`;
    // Đánh dấu tài liệu đích bằng tên tạm (đổi tên không tạo bước lịch sử).
    const mark = await this.bridge.exec(`app.echoToOE(app.activeDocument.name); app.activeDocument.name = ${JSON.stringify(token)};`);
    if (!mark.completed || !mark.echoes.length) return fail('Không đánh dấu được tài liệu đích.');
    const originalName = mark.echoes[0];
    const opened = await this.bridge.exec(buffer);
    if (!opened.completed) {
      await this.bridge.exec(`app.activeDocument.name = ${JSON.stringify(originalName)};`);
      return fail('Photopea không mở được ảnh do AI trả về.');
    }
    const makeMask = `var md = new ActionDescriptor(); var mr = new ActionReference(); mr.putEnumerated(_c('Chnl'), _c('Chnl'), _c('Msk '));
md.putClass(_c('Nw  '), _c('Chnl')); md.putReference(_c('At  '), mr); md.putEnumerated(_c('Usng'), _c('UsrM'), _c('RvlS'));
app.executeAction(_c('Mk  '), md, DialogModes.NO);
dst.selection.deselect();`;
    let maskScript = '';
    if (maskLayer) maskScript = `${loadSelectionCode(maskLayer)}\n${makeMask}`;
    else if (maskRect) {
      maskScript = `dst.selection.select(${rectPoints(maskRect.x, maskRect.y, maskRect.width, maskRect.height)}, SelectionType.REPLACE, ${Number(feather) || 0});\n${makeMask}`;
    }
    const result = await this._runWrapped(wrap(`
var src = app.activeDocument;
var dst = null;
for (var i = 0; i < app.documents.length; i++) { if (app.documents[i].name === ${JSON.stringify(token)}) { dst = app.documents[i]; } }
if (!dst) { __fail('Không tìm thấy tài liệu đích.'); return; }
// bounds của layer chỉ bao phần KHÔNG trong suốt, nên co giãn theo kích thước tài liệu nguồn
// và giữ nguyên độ lệch của phần nội dung (quan trọng với ảnh mask có vùng trong suốt).
var sW = __num(src.width), sH = __num(src.height);
var sb = __bounds(src.activeLayer);
var kx = ${area.width} / sW, ky = ${area.height} / sH;
// Layer chép sang được đặt ngay trên layer đang chọn của tài liệu đích, mang tên mặc định
// ("Layer 1"...) và trở thành layer đang chọn, nên lấy nó qua activeLayer.
src.activeLayer.duplicate(dst);
src.close(2);
app.activeDocument = dst;
dst.name = ${JSON.stringify(originalName)};
var L = dst.activeLayer;
if (!L) { __fail('Không chép được layer kết quả.'); return; }
if (dst.layers[0].name !== L.name) { L.move(dst.layers[0], ElementPlacement.PLACEBEFORE); }
if (kx !== 1 || ky !== 1) { L.resize(kx * 100, ky * 100, AnchorPosition.TOPLEFT); }
var b = __bounds(L);
L.translate(${area.x} + sb.x * kx - b.x, ${area.y} + sb.y * ky - b.y);
L.name = ${JSON.stringify(layerName)};
${maskScript}
${hidden ? 'L.visible = false;' : ''}
${opacity < 100 ? `L.opacity = ${Math.round(opacity)};` : ''}
__ok({ layer: L.name, bounds: __bounds(L) });`, { needsDocument: false }));
    if (result.isError) {
      // Dọn dẹp: trả lại tên tài liệu gốc nếu còn mang tên tạm.
      await this.bridge.exec(`for (var i = 0; i < app.documents.length; i++) { if (app.documents[i].name === ${JSON.stringify(token)}) { app.documents[i].name = ${JSON.stringify(originalName)}; } }`);
    }
    return result;
  }

  async _runRawScript(script) {
    const problems = findUnsupportedSyntax(script);
    if (problems.length) {
      return fail(`Script dùng cú pháp mà Photopea không hỗ trợ: ${problems.join(', ')}. Viết lại theo ES5 (var, function, vòng lặp for).`);
    }
    const r = await this.bridge.exec(script);
    this.undoDepth = 0;
    if (!r.completed) {
      return fail('Script bị lỗi khi chạy (Photopea không cho biết chi tiết lỗi). Các lệnh trước chỗ lỗi có thể đã được áp dụng; kiểm tra lại bằng get_document_info hoặc view_image.' +
        (r.echoes.length ? ` Output trước khi lỗi: ${r.echoes.join('\n')}` : ''));
    }
    return ok(r.echoes.length ? r.echoes.join('\n') : 'Script chạy xong (không có output).');
  }
}

/**
 * Khớp màu kết quả AI với ảnh gốc: so phần NGỮ CẢNH (ngoài vùng cần sửa, lẽ ra không đổi) của hai ảnh, tính
 * độ lệch trung bình và độ tương phản từng kênh R, G, B, rồi chỉnh toàn bộ kết quả AI theo đó.
 * Trả về PNG (ArrayBuffer) cùng kích thước ảnh đã gửi, hoặc null nếu phần ngữ cảnh quá nhỏ để đo.
 */
async function matchColors(sentCanvas, resultBuffer, t) {
  const w = sentCanvas.width;
  const h = sentCanvas.height;
  const bmp = await createImageBitmap(new Blob([resultBuffer]));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const A = octx.getImageData(0, 0, w, h);
  const O = sentCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const a = A.data;
  const sum = [[0, 0, 0], [0, 0, 0]];
  const sq = [[0, 0, 0], [0, 0, 0]];
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= t.x0 && x < t.x1 && y >= t.y0 && y < t.y1) continue; // trong vùng cần sửa: bỏ qua
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        sum[0][c] += O[i + c]; sq[0][c] += O[i + c] * O[i + c];
        sum[1][c] += a[i + c]; sq[1][c] += a[i + c] * a[i + c];
      }
      n++;
    }
  }
  if (n < w * h * 0.05) return null;
  const fix = [0, 1, 2].map((c) => {
    const mo = sum[0][c] / n, ma = sum[1][c] / n;
    const so = Math.sqrt(Math.max(0, sq[0][c] / n - mo * mo));
    const sa = Math.sqrt(Math.max(0, sq[1][c] / n - ma * ma));
    // Giới hạn hệ số để không làm hỏng ảnh khi ngữ cảnh gần như phẳng màu
    const gain = sa > 1 && so > 1 ? Math.min(1.25, Math.max(0.8, so / sa)) : 1;
    return { gain, offset: mo - ma * gain };
  });
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) a[i + c] = Math.max(0, Math.min(255, a[i + c] * fix[c].gain + fix[c].offset));
  }
  octx.putImageData(A, 0, 0);
  const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  return blob.arrayBuffer();
}

/** Đoạn script nạp vùng chọn từ độ trong suốt (alpha) của layer có tên cho trước. */
function loadSelectionCode(layerName) {
  return `var __sd = new ActionDescriptor(); var __sr = new ActionReference(); __sr.putProperty(_c('Chnl'), _c('fsel')); __sd.putReference(_c('null'), __sr);
var __st = new ActionReference(); __st.putEnumerated(_c('Chnl'), _c('Chnl'), _c('Trsp')); __st.putName(_c('Lyr '), ${JSON.stringify(layerName)}); __sd.putReference(_c('T   '), __st);
app.executeAction(_c('setd'), __sd, DialogModes.NO);`;
}

/** Gọi /api/ai-edit; trả về ArrayBuffer ảnh kết quả hoặc ném lỗi có thông báo tiếng Việt. */
async function requestAiEdit(image, instruction) {
  const data = await postJson('api/ai-edit', { image, mime_type: 'image/png', instruction });
  return base64ToBuffer(data.image);
}

function clampRect(r, W, H) {
  const x0 = clamp(Math.round(r.x), 0, W - 1);
  const y0 = clamp(Math.round(r.y), 0, H - 1);
  const x1 = clamp(Math.round(r.x + r.width), x0 + 1, W);
  const y1 = clamp(Math.round(r.y + r.height), y0 + 1, H);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const smooth = (lo, hi, v) => (v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo));

/** Trọng số chọn (0..1) theo khoảng cách màu RGB tới màu đích. */
function colorWeight(color, tolerance) {
  const h = String(color).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [tr, tg, tb] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  const maxD = Math.max(4, tolerance * 2.2);
  const inner = maxD * 0.6;
  return (r, g, b) => {
    const dist = Math.hypot(r - tr, g - tg, b - tb);
    return dist <= inner ? 1 : dist >= maxD ? 0 : (maxD - dist) / (maxD - inner);
  };
}

/** Trọng số chọn (0..1) theo họ màu (hue), bỏ qua vùng xám / quá tối. */
function hueWeight(range, tolerance) {
  const center = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 }[range];
  const half = 15 + tolerance * 0.6;
  const ramp = 15;
  return (r, g, b) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta === 0 || max === 0) return 0;
    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    const dh = Math.min(Math.abs(hue - center), 360 - Math.abs(hue - center));
    const wHue = dh <= half ? 1 : dh >= half + ramp ? 0 : (half + ramp - dh) / ramp;
    return wHue * smooth(0.1, 0.25, delta / max) * smooth(15, 40, max);
  };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Tên file an toàn cho mọi trình duyệt/hệ điều hành: bỏ dấu tiếng Việt, thay ký tự lạ bằng "-". */
export function safeFileName(name) {
  const cleaned = String(name ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || 'anh';
}

function ok(content) {
  return { isError: false, content };
}

function fail(message) {
  return { isError: true, content: message };
}
