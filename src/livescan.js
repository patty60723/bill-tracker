// 即時掃條碼:開相機,把鏡頭靠近繳費單上的條碼,一條一條讀也可以。
// 照片裡條碼太小、太糊讀不到時,用這個最可靠(超商/銀行繳費 app 也都是這樣做)。

import { detectCanvas } from './scan.js';

const FRAME_INTERVAL_MS = 200;

/**
 * @param describe (texts) => html  顯示目前讀到哪些(例如「第一段 ✓ 截止日 10/31」)
 * @param isEnough (texts) => bool  滿足就自動結束
 * @returns Promise<string[] | null>  讀到的條碼;使用者按取消回傳 null
 */
export function liveScan({ describe, isEnough }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'live-scan';
    dlg.innerHTML = `
      <div class="live-wrap">
        <video playsinline muted autoplay></video>
        <div class="live-guide"><span></span></div>
        <div class="live-panel">
          <div class="live-hint">把條碼放進框內、<b>靠近一點</b>讓條碼佔滿框的寬度。三條可以一條一條掃。</div>
          <div class="live-found"></div>
          <div class="live-actions">
            <button type="button" class="btn" data-act="cancel">取消</button>
            <button type="button" class="btn primary" data-act="done">完成</button>
          </div>
        </div>
      </div>`;
    document.body.append(dlg);
    const video = dlg.querySelector('video');
    const foundBox = dlg.querySelector('.live-found');
    const texts = new Set();
    let stream;
    let stopped = false;

    const finish = (result) => {
      if (stopped) return;
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    const render = () => { foundBox.innerHTML = describe([...texts]); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') finish(null);
      if (act === 'done') finish([...texts]);
    });
    dlg.showModal();
    render();

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
      } catch (e) {
        foundBox.innerHTML = `<div class="bad">⚠️ 無法開啟相機:${e.message || e}<br>請確認已允許這個網站使用相機(需要 HTTPS)。</div>`;
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      video.srcObject = stream;
      await video.play().catch(() => {});

      const frame = document.createElement('canvas');
      while (!stopped) {
        const started = Date.now();
        if (video.readyState >= 2 && video.videoWidth) {
          frame.width = video.videoWidth;
          frame.height = video.videoHeight;
          frame.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
          const before = texts.size;
          for (const t of await detectCanvas(frame)) texts.add(t);
          if (texts.size > before) {
            navigator.vibrate?.(60);
            render();
            if (isEnough([...texts])) {
              await new Promise((r) => setTimeout(r, 500)); // 讓使用者看到全部打勾
              finish([...texts]);
              return;
            }
          }
        }
        await new Promise((r) => setTimeout(r, Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started))));
      }
    })();
  });
}
