// Thực thi các lệnh tool mà Claude yêu cầu, ngay trong trình duyệt.
import { TOOL_MAP } from '/shared/tools.js';
import { validate } from '/shared/validate.js';
import { RESULT_PREFIX, wrap, findUnsupportedSyntax } from '/shared/script-kit.js';

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
