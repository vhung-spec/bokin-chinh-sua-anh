// Thực thi các lệnh tool mà Claude yêu cầu, ngay trong trình duyệt.
import { TOOL_MAP } from '/shared/tools.js';
import { validate } from '/shared/validate.js';
import { RESULT_PREFIX, wrap, rectPoints, findUnsupportedSyntax } from '/shared/script-kit.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', psd: 'image/vnd.adobe.photoshop' };

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
  }

  /** @returns {Promise<ToolOutcome>} */
  async execute(name, input = {}) {
    const tool = TOOL_MAP.get(name);
    if (!tool) return fail(`Không có công cụ tên "${name}".`);
    const problems = validate(input, tool.input_schema);
    if (problems.length) return fail(`Tham số không hợp lệ: ${problems.join('; ')}`);
    try {
      if (tool.kind === 'script') return await this._runScriptTool(tool, input);
      switch (name) {
        case 'view_image': return await this._viewImage(input);
        case 'undo': return await this._history(input.steps ?? 1);
        case 'redo': return await this._history(-(input.steps ?? 1));
        case 'export_image': return await this._export(input);
        case 'run_script': return await this._runRawScript(input.script);
        case 'ai_edit': return await this._aiEdit(input);
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

  async _viewImage({ region, max_size: maxSize = 1024 }) {
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

  /**
   * Chỉnh sửa bằng AI: gửi ảnh (hoặc vùng + ngữ cảnh xung quanh) lên server -> mô hình AI -> đặt kết quả
   * thành một layer mới đúng vị trí; nếu có region thì thêm mask để chỉ thay vùng đó.
   */
  async _aiEdit({ instruction, region, feather = 12 }) {
    const exported = await this.bridge.exportDocument('png');
    if (!exported) return fail('Chưa có ảnh nào đang mở.');
    const bitmap = await createImageBitmap(new Blob([exported.buffer], { type: 'image/png' }));
    const W = bitmap.width;
    const H = bitmap.height;

    // Vùng gửi cho AI: toàn ảnh, hoặc vùng cần sửa + lề ngữ cảnh 50% mỗi phía.
    let area = { x: 0, y: 0, width: W, height: H };
    let mask = null;
    if (region) {
      const x0 = clamp(Math.round(region.x), 0, W - 1);
      const y0 = clamp(Math.round(region.y), 0, H - 1);
      const x1 = clamp(Math.round(region.x + region.width), x0 + 1, W);
      const y1 = clamp(Math.round(region.y + region.height), y0 + 1, H);
      mask = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      const margin = Math.round(Math.max(mask.width, mask.height) * 0.5);
      const ax0 = Math.max(0, x0 - margin);
      const ay0 = Math.max(0, y0 - margin);
      area = { x: ax0, y: ay0, width: Math.min(W, x1 + margin) - ax0, height: Math.min(H, y1 + margin) - ay0 };
    }
    const scale = Math.min(1, 1536 / Math.max(area.width, area.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(area.width * scale));
    canvas.height = Math.max(1, Math.round(area.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const sent = canvas.toDataURL('image/png');

    const res = await fetch('/api/ai-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: sent.slice(sent.indexOf(',') + 1), mime_type: 'image/png', instruction }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail(data.error || `Server trả lỗi HTTP ${res.status}`);

    const layerName = `AI: ${instruction}`.slice(0, 60);
    const placed = await this._placeImageAsLayer(base64ToBuffer(data.image), area, layerName, mask, feather);
    this.undoDepth = 0;
    if (placed.isError) return placed;
    return ok(JSON.stringify({
      ...JSON.parse(placed.content),
      sent_area: area,
      note: 'Kết quả AI nằm ở layer mới phía trên; ảnh gốc vẫn ở bên dưới. Hãy kiểm tra bằng view_image.',
    }));
  }

  /** Mở ảnh như tài liệu tạm, chép layer sang tài liệu đang làm việc, co giãn vào `area`, thêm mask nếu có. */
  async _placeImageAsLayer(buffer, area, layerName, mask, feather) {
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
    const maskScript = mask
      ? `dst.selection.select(${rectPoints(mask.x, mask.y, mask.width, mask.height)}, SelectionType.REPLACE, ${Number(feather) || 0});
var md = new ActionDescriptor(); var mr = new ActionReference(); mr.putEnumerated(_c('Chnl'), _c('Chnl'), _c('Msk '));
md.putClass(_c('Nw  '), _c('Chnl')); md.putReference(_c('At  '), mr); md.putEnumerated(_c('Usng'), _c('UsrM'), _c('RvlS'));
app.executeAction(_c('Mk  '), md, DialogModes.NO);
dst.selection.deselect();`
      : '';
    const result = await this._runWrapped(wrap(`
var src = app.activeDocument;
var dst = null;
for (var i = 0; i < app.documents.length; i++) { if (app.documents[i].name === ${JSON.stringify(token)}) { dst = app.documents[i]; } }
if (!dst) { __fail('Không tìm thấy tài liệu đích.'); return; }
// Layer chép sang được đặt ngay trên layer đang chọn của tài liệu đích, mang tên mặc định
// ("Layer 1"...) và trở thành layer đang chọn, nên lấy nó qua activeLayer.
src.activeLayer.duplicate(dst);
src.close(2);
app.activeDocument = dst;
dst.name = ${JSON.stringify(originalName)};
var L = dst.activeLayer;
if (!L) { __fail('Không chép được layer kết quả.'); return; }
if (dst.layers[0].name !== L.name) { L.move(dst.layers[0], ElementPlacement.PLACEBEFORE); }
var b = __bounds(L);
L.resize(${area.width} / b.width * 100, ${area.height} / b.height * 100, AnchorPosition.TOPLEFT);
b = __bounds(L);
L.translate(${area.x} - b.x, ${area.y} - b.y);
L.name = ${JSON.stringify(layerName)};
${maskScript}
__ok({ layer: L.name, bounds: __bounds(L), masked_to: ${mask ? JSON.stringify(mask) : 'null'} });`, { needsDocument: false }));
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
