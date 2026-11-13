// Cầu nối giữa trang web và Photopea (nhúng trong iframe), dùng "Live Messaging API":
//   - Gửi chuỗi  -> Photopea chạy như script.
//   - Gửi ArrayBuffer -> Photopea mở như một file (jpg, png, psd...).
//   - Photopea gửi lại: chuỗi từ app.echoToOE(...), ArrayBuffer từ saveToOE(...), và "done" khi xong.
//
// Vấn đề: khi script bị lỗi, Photopea KHÔNG gửi "done" (và try/catch không bắt được lỗi).
// Giải pháp "sentinel": sau mỗi lệnh, gửi thêm một script nhỏ echo một mã duy nhất.
//   Thành công: [kết quả..., "done", MÃ, "done"]
//   Thất bại:   [MÃ, "done"]               (không có "done" nào trước MÃ)
// Nhờ vậy phát hiện lỗi ngay lập tức thay vì phải chờ hết thời gian.

const END_PREFIX = '__BOKIN_END__';

export class PhotopeaBridge {
  /**
   * @param {HTMLIFrameElement} iframe
   * @param {{ config?: object }} [options] - cấu hình Photopea (https://www.photopea.com/api/)
   */
  constructor(iframe, { config = {} } = {}) {
    this.iframe = iframe;
    this.inbox = [];
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.isReady = false;
    this.ready = new Promise((resolve) => { this._resolveReady = resolve; });
    window.addEventListener('message', (event) => this._onMessage(event));
    iframe.src = `https://www.photopea.com#${encodeURIComponent(JSON.stringify(config))}`;
  }

  _onMessage(event) {
    if (event.source !== this.iframe.contentWindow) return;
    const data = event.data;
    if (!this.isReady) {
      // "done" đầu tiên = Photopea đã khởi động xong.
      if (data === 'done') {
        this.isReady = true;
        this._resolveReady();
      }
      return;
    }
    this.inbox.push(data);
    for (const listener of this.listeners) listener();
  }

  /** Chạy lần lượt từng thao tác (Photopea xử lý tuần tự, và ta cần tách kết quả của từng lệnh). */
  _enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Gửi một script (string) hoặc file (ArrayBuffer) cho Photopea và chờ xử lý xong.
   * @returns {Promise<{completed: boolean, echoes: string[], files: ArrayBuffer[]}>}
   *   completed=false nghĩa là Photopea gặp lỗi khi chạy.
   */
  exec(payload, { timeoutMs = 180000 } = {}) {
    return this._enqueue(async () => {
      await this.ready;
      const marker = END_PREFIX + Math.random().toString(36).slice(2) + Date.now().toString(36);
      this.inbox = [];
      const target = this.iframe.contentWindow;
      target.postMessage(payload, '*');
      target.postMessage(`app.echoToOE(${JSON.stringify(marker)});`, '*');

      await new Promise((resolve, reject) => {
        const check = () => {
          const i = this.inbox.indexOf(marker);
          if (i !== -1 && this.inbox.indexOf('done', i + 1) !== -1) {
            cleanup();
            resolve();
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Photopea không phản hồi (quá thời gian chờ). Thử tải lại trang.'));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          this.listeners.delete(check);
        };
        this.listeners.add(check);
        check();
      });

      const before = this.inbox.slice(0, this.inbox.indexOf(marker));
      return {
        completed: before.includes('done'),
        echoes: before.filter((m) => typeof m === 'string' && m !== 'done'),
        files: before.filter((m) => m instanceof ArrayBuffer),
      };
    });
  }

  /** Mở file ảnh trong Photopea và đặt tên tài liệu. */
  async openFile(buffer, name) {
    const r = await this.exec(buffer);
    if (!r.completed) throw new Error('Photopea không mở được file này.');
    if (name) await this.exec(`if (app.documents.length) { app.activeDocument.name = ${JSON.stringify(name)}; }`);
  }

  /**
   * Xuất tài liệu đang mở. format theo cú pháp saveToOE: "png", "jpg:0.9", "webp:0.8", "psd".
   * @returns {Promise<{buffer: ArrayBuffer, docName: string} | null>} null nếu chưa mở ảnh nào.
   */
  async exportDocument(format) {
    const r = await this.exec(
      `if (app.documents.length === 0) { app.echoToOE('__NO_DOC__'); } else { app.echoToOE('__NAME__' + app.activeDocument.name); app.activeDocument.saveToOE(${JSON.stringify(format)}); }`,
    );
    if (r.echoes.includes('__NO_DOC__')) return null;
    if (!r.completed || r.files.length === 0) throw new Error('Photopea không xuất được ảnh.');
    const nameEcho = r.echoes.find((e) => e.startsWith('__NAME__'));
    return { buffer: r.files.at(-1), docName: nameEcho ? nameEcho.slice('__NAME__'.length) : 'anh' };
  }
}
