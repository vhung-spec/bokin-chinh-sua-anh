// Hoàn tác / làm lại theo THAO TÁC thay vì từng bước lịch sử lẻ của Photopea.
// Một preset màu (2–3 bước), một lần Generative Fill (~10 bước), hay toàn bộ việc Claude làm cho một câu lệnh
// được ghi thành một mục: bấm Hoàn tác một lần là gỡ cả cụm.
//
// Vị trí lịch sử = mã riêng của bước đang đứng (runner.historyInfo): tăng dần, không dùng lại, vẫn đúng khi Photopea
// đã đủ 20 bước và bỏ bớt bước cũ, hay khi người dùng tự Ctrl+Z trong Photopea. Hoàn tác một thao tác = về đúng bước
// trước nó (runner.gotoHistory), không đếm số bước.

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

  /** Mã của bước lịch sử đang đứng, hoặc null nếu chưa mở ảnh. */
  async position() {
    return this.runner._position();
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
      const out = await this.runner.gotoHistory(top.before);
      if (out.isError) return { ...out, label: top.label };
      this.undoStack.pop();
      this.redoStack.push(top);
      await this.runner.onExecuted?.('undo', out, {});
      return { ...out, label: top.label, entry: top };
    }
    return { ...(await this.runner.execute('undo', { steps: 1 })), label: null };
  }

  /** Làm lại cả mục vừa hoàn tác; nếu không có thì làm lại một bước. */
  async redo() {
    const top = this.redoStack.at(-1);
    if (top && (await this.position()) === top.before) {
      const out = await this.runner.gotoHistory(top.after);
      if (out.isError) return { ...out, label: top.label };
      this.redoStack.pop();
      this.undoStack.push(top);
      await this.runner.onExecuted?.('redo', out, {});
      return { ...out, label: top.label, entry: top };
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

  /**
   * Tạm hiện ảnh gốc (lúc vừa mở / vừa tạo) để so sánh; gọi restore() để quay lại. Bước gốc đã bị Photopea bỏ
   * (quá 20 bước) thì hiện bước cũ nhất còn giữ.
   */
  async showOriginal() {
    const info = await this.runner.historyInfo();
    if (!info) return;
    this.comparingFrom = info.index;
    let index = info.exact ? info.ids.indexOf(this.origin) : this.origin;
    if (index < 0) index = info.exact && this.origin < info.ids[0] ? 0 : info.index;
    await this.bridge.exec(`if (app.documents.length) { var __hs = app.activeDocument.historyStates; app.activeDocument.activeHistoryState = __hs[Math.min(${Math.floor(index)}, __hs.length - 1)]; }`);
  }

  async restore() {
    const index = this.comparingFrom;
    this.comparingFrom = null;
    if (index === null || index === undefined) return;
    await this.bridge.exec(`if (app.documents.length) { var __hs = app.activeDocument.historyStates; app.activeDocument.activeHistoryState = __hs[Math.min(${index}, __hs.length - 1)]; }`);
  }
}
