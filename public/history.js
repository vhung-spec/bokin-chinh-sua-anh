// Hoàn tác / làm lại theo THAO TÁC thay vì từng bước lịch sử lẻ của Photopea.
// Một preset màu (2–3 bước), một lần Generative Fill (~10 bước), hay toàn bộ việc Claude làm cho một câu lệnh
// được ghi thành một mục: bấm Hoàn tác một lần là gỡ cả cụm.
//
// Vị trí lịch sử hiện tại = số bước - 1 - runner.undoDepth (Photopea không cho đọc trực tiếp vị trí này).
// Nếu người dùng tự bấm Ctrl+Z trong Photopea, vị trí có thể lệch: khi đó Bokin chỉ hoàn tác từng bước một.

export class ActionLog {
  /**
   * @param {import('./tool-runner.js').ToolRunner} runner
   * @param {import('./photopea-bridge.js').PhotopeaBridge} bridge
   */
  constructor(runner, bridge) {
    this.runner = runner;
    this.bridge = bridge;
    this.undoStack = [];
    this.redoStack = [];
    this.origin = 0; // vị trí lịch sử của "ảnh gốc" (ảnh mới tạo có vài bước dựng nền trước đó)
  }

  /** Số bước lịch sử của tài liệu đang mở, hoặc null nếu chưa mở ảnh. */
  async historyLength() {
    const r = await this.bridge.exec("if (app.documents.length) { app.echoToOE('__H__' + app.activeDocument.historyStates.length); }");
    const line = r.echoes.find((e) => e.startsWith('__H__'));
    return line ? Number(line.slice(5)) : null;
  }

  async position() {
    const len = await this.historyLength();
    return len === null ? null : len - 1 - this.runner.undoDepth;
  }

  /** Mục mới nhất có thể hoàn tác. */
  top() {
    return this.undoStack.at(-1) ?? null;
  }

  /** Mục này có còn là trạng thái hiện tại không (chưa có chỉnh sửa nào khác xen vào)? */
  async isCurrent(entry) {
    return Boolean(entry) && (await this.position()) === entry.after;
  }

  /**
   * Chạy một thao tác và ghi lại các bước lịch sử nó tạo ra thành một mục.
   * @param {{ label: string, kind?: string }} meta
   * @param {() => Promise<any>} fn
   */
  async record(meta, fn) {
    const before = await this.position();
    const out = await fn();
    const after = await this.position();
    if (before !== null && after !== null && after > before && !out?.isError) {
      this.undoStack.push({ ...meta, before, after });
      if (this.undoStack.length > 50) this.undoStack.shift();
      this.redoStack = [];
    }
    return out;
  }

  /** Hoàn tác cả mục mới nhất nếu nó đang là trạng thái hiện tại; nếu không thì hoàn tác một bước. */
  async undo() {
    const top = this.top();
    if (top && (await this.isCurrent(top))) {
      this.undoStack.pop();
      const out = await this.runner.execute('undo', { steps: top.after - top.before });
      if (!out.isError) this.redoStack.push(top);
      return { ...out, label: top.label };
    }
    return { ...(await this.runner.execute('undo', { steps: 1 })), label: null };
  }

  /** Làm lại cả mục vừa hoàn tác; nếu không có thì làm lại một bước. */
  async redo() {
    const top = this.redoStack.at(-1);
    if (top && (await this.position()) === top.before) {
      this.redoStack.pop();
      const out = await this.runner.execute('redo', { steps: top.after - top.before });
      if (!out.isError) this.undoStack.push(top);
      return { ...out, label: top.label };
    }
    return { ...(await this.runner.execute('redo', { steps: 1 })), label: null };
  }

  /** Có chỉnh sửa mới (lịch sử phía sau bị cắt): không còn gì để làm lại. */
  clearRedo() {
    this.redoStack = [];
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.origin = 0;
  }

  /** Ghi nhớ trạng thái hiện tại là "ảnh gốc" (gọi ngay sau khi mở hoặc tạo ảnh). */
  async markOrigin() {
    this.origin = Math.max(0, (await this.position()) ?? 0);
  }

  /** Tạm hiện ảnh gốc (lúc vừa mở / vừa tạo) để so sánh; gọi restore() để quay lại. */
  async showOriginal() {
    const o = Math.floor(this.origin);
    await this.bridge.exec(`if (app.documents.length) { var __hs = app.activeDocument.historyStates; app.activeDocument.activeHistoryState = __hs[Math.min(${o}, __hs.length - 1)]; }`);
  }

  async restore() {
    const len = await this.historyLength();
    if (len === null) return;
    const idx = Math.max(0, len - 1 - this.runner.undoDepth);
    await this.bridge.exec(`if (app.documents.length) { var __hs = app.activeDocument.historyStates; app.activeDocument.activeHistoryState = __hs[${idx}]; }`);
  }
}
