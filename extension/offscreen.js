// offscreen.js — 只干一件事：把数据转成 blob: URL 交回给 background。
//
// blob: URL 的生命周期绑在创建它的文档上，所以这个文档必须活到下载完成之后
// 才能关掉，否则下载会中断。关闭时机由 background 控制。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;

  if (msg.action === "makeBlobUrl") {
    try {
      // 用 base64 传输：Uint8Array 经过消息通道会退化成普通对象，不可靠
      const bin = atob(msg.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: msg.mime }));
      sendResponse({ ok: true, url });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  if (msg.action === "revokeBlobUrl") {
    try {
      URL.revokeObjectURL(msg.url);
    } catch (e) {}
    sendResponse({ ok: true });
    return true;
  }
});
