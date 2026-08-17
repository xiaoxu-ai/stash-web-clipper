// background.js — 后台 service worker，整个流程的编排者
//
// 关键设计（2026-08-15 重构）：
// 1. 提取结果落盘到 chrome.storage.session，**不再只活在 popup 的变量里** ——
//    弹窗随时可以关，结果不丢。
// 2. 下载和 docx 生成全在这里跑完，包括**最后那步下载动作**。
//    重构前 docx 是 background 生成 base64 → 回传 popup → popup 转 Blob 下载，
//    所以弹窗一关就断（旧 UI 上写着「请勿关闭弹窗」）。
//    MV3 的 service worker 里没有 URL.createObjectURL，但 chrome.downloads
//    可以直接吃 data: URL —— 原本下载 md 和图片就是这么做的，docx 照搬即可。
// 3. 进度写进 storage，popup 被动刷新 —— 关掉弹窗不影响正在跑的任务。
//    （不做独立结果页：提取是原样复原、没有需要人工判断的加工，
//     多开一个 tab 只是多一次点击。若将来加入 AI 加工，才需要摊开审。）
//
// ⚠️ 不要动 imageToDataUrl + downloadAndWait 这套：
//    Brave 的下载管理器直连 pbs.twimg.com 会卡死不结束，
//    必须后台自己 fetch 成字节 → data: URL → 再交给下载管理器（不联网、秒完成）。

importScripts("docx.js"); // 提供 buildDocxBytes / imgSize

const JOB_KEY = "job";       // UI 状态：小，写得勤
const ART_KEY = "article";   // 提取结果：大，关掉弹窗也要留着

// ---------------------------------------------------------------- 状态存取

async function setJob(patch) {
  const { [JOB_KEY]: cur } = await chrome.storage.session.get(JOB_KEY);
  const next = { ...(cur || {}), ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ [JOB_KEY]: next });
  return next;
}

async function getJob() {
  const { [JOB_KEY]: j } = await chrome.storage.session.get(JOB_KEY);
  return j || null;
}

async function getArticle() {
  const { [ART_KEY]: a } = await chrome.storage.session.get(ART_KEY);
  return a || null;
}

// service worker 闲置约 30 秒会被回收，光跑 fetch 不算「活跃」。
// 抓十几张图可能要几十秒，得靠周期性调用扩展 API 续命。
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// ---------------------------------------------------------------- 工具

function safeName(s) {
  let out = (s || "").normalize("NFC");
  out = out.replace(/[^\p{L}\p{N} _\-()]/gu, "_"); // 只保留 字母/数字(含中日韩)/空格/_-()
  out = out
    .replace(/[\\/:*?"<>|\n\r\t]/g, "_")
    .replace(/_+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[ _]+|[ _]+$/g, "")
    .trim();
  return (out || "x-article").slice(0, 50).trim() || "x-article";
}

function extOf(url) {
  const m = url.match(/format=(\w+)/);
  if (m) return m[1];
  const m2 = url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i);
  return m2 ? m2[1].toLowerCase() : "jpg";
}

// 带超时的 fetch（卡住时 15 秒放弃，报 AbortError，便于定位是网络问题）
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ArrayBuffer → base64（service worker 里没有 FileReader，手动转）
function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ 图片必须限速抓，不能开着循环猛冲。
//
// 实测：维基百科一篇文章 28 张图，无间隔连续请求 → 21 张返回 HTTP 429（被限流），
// 只成功 7 张。图床普遍有频率限制，图越多的文章丢得越惨。
//
// 所以：每张之间留个间隔，遇到 429 退避重试。慢一点，但不丢图。
const IMG_GAP_MS = 150;      // 相邻两张之间的间隔
const IMG_RETRIES = 3;

async function imageToDataUrl(url) {
  let lastErr = null;

  for (let attempt = 0; attempt < IMG_RETRIES; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, 15000);

      if (resp.status === 429 || resp.status === 503) {
        // 被限流：退避后重试。服务端给了 Retry-After 就听它的
        const ra = Number(resp.headers.get("retry-after")) || 0;
        const wait = ra ? ra * 1000 : 600 * Math.pow(2, attempt); // 600 / 1200 / 2400ms
        lastErr = new Error("HTTP" + resp.status + "（限流）");
        if (attempt < IMG_RETRIES - 1) {
          await sleep(Math.min(wait, 5000));
          continue;
        }
        throw lastErr;
      }

      if (!resp.ok) throw new Error("HTTP" + resp.status);

      const buf = await resp.arrayBuffer();
      const ct = resp.headers.get("content-type") || "image/jpeg";
      return `data:${ct};base64,` + abToBase64(buf);
    } catch (e) {
      lastErr = e;
      // 超时/网络抖动也重试一次
      if (attempt < IMG_RETRIES - 1 && e.name === "AbortError") {
        await sleep(500);
        continue;
      }
      if (attempt >= IMG_RETRIES - 1) break;
      if (!/429|503/.test(String(e.message))) break; // 其它错误重试无意义
    }
  }
  throw lastErr || new Error("图片抓取失败");
}

// 发起下载并轮询到完成/中断/超时（此处只下 data: URL，不联网，应秒完成）
function downloadAndWait(opts) {
  return new Promise((resolve) => {
    chrome.downloads.download(opts, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        return resolve({
          ok: false,
          error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "start_failed",
        });
      }
      const started = Date.now();
      const poll = () => {
        chrome.downloads.search({ id }, (items) => {
          const it = items && items[0];
          if (it && it.state === "complete") return resolve({ ok: true });
          if (it && it.state === "interrupted") return resolve({ ok: false, error: it.error || "interrupted" });
          if (Date.now() - started > 12000) return resolve({ ok: false, error: "timeout(" + (it ? it.state : "no_item") + ")" });
          setTimeout(poll, 200);
        });
      };
      poll();
    });
  });
}

// ---------------------------------------------------------------- 大文件下载

// chrome.downloads 吃 data: URL 有长度上限，内嵌图片的 HTML 动辄好几 MB，必然超。
// MV3 的 Service Worker 里又没有 URL.createObjectURL，
// 官方解法是开一个离屏文档，在里面造 blob: URL。
let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const has = await chrome.offscreen.hasDocument?.();
    if (has) return;
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "把生成的 HTML/文档转成 blob URL 以便下载（data: URL 有大小限制）",
      });
    } catch (e) {
      // 并发调用时可能已经被别的分支建好了，这种报错可以忽略
      if (!/single offscreen|already/i.test(String(e?.message || e))) throw e;
    }
  })();
  return offscreenReady;
}

// 把 base64 内容存成文件。大文件走 blob，小文件直接 data: URL（省一次跨文档往返）
async function downloadBytes(base64, mime, filename) {
  const approxBytes = Math.floor(base64.length * 0.75);

  if (approxBytes < 1_000_000) {
    return downloadAndWait({
      url: `data:${mime};base64,${base64}`,
      filename,
      conflictAction: "uniquify",
    });
  }

  await ensureOffscreen();
  const made = await chrome.runtime.sendMessage({
    target: "offscreen",
    action: "makeBlobUrl",
    base64,
    mime,
  });
  if (!made?.ok) return { ok: false, error: "生成 blob 失败：" + (made?.error || "无响应") };

  const res = await downloadAndWait({ url: made.url, filename, conflictAction: "uniquify" });

  // 下载完成后才能撤销，否则会中断
  chrome.runtime
    .sendMessage({ target: "offscreen", action: "revokeBlobUrl", url: made.url })
    .catch(() => {});
  return res;
}

// ---------------------------------------------------------------- ① 提取

// 提取脚本改为「按需注入」，不再写在 manifest 的 content_scripts 里。
// 两个好处：
//   1. 配合 activeTab，**任何网站**都能用 —— 只有用户主动点插件的那个标签页被授权，
//      不需要申请 <all_urls> 那种吓人的常驻权限。
//   2. 不用再要求用户「先刷新页面」。
//
// 注入顺序有讲究：两个第三方库必须排在 content.js 前面，它靠全局变量取用。
const INJECT_FILES = [
  "vendor/Readability.js",   // Apache-2.0，把任意网页剥成干净正文
  "vendor/turndown.js",      // MIT，HTML → Markdown
  "content.js",
];

async function askContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });

  // 用 func 调用而不是发消息：executeScript 对 func 的返回值有可靠的等待语义，
  // 也避免了重复注入导致挂多个消息监听器的问题。
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__xArticle.extract(),
  });
  return res && res[0] ? res[0].result : null;
}

async function doExtract(tabId) {
  await setJob({ status: "extracting", message: "正在提取正文…", current: 0, total: 0, error: null });

  const res = await askContentScript(tabId);
  if (!res || !res.ok) {
    throw new Error((res && res.error) || "页面没有响应，刷新一下再试");
  }

  await chrome.storage.session.set({
    [ART_KEY]: {
      title: res.title,
      url: res.url,
      markdown: res.markdown,
      images: res.images || [],
      count: res.count || 0,
      via: res.via || "",        // "x" 还是 "readability"，出问题时好定位
      suspect: res.suspect || null,   // 非空 = 这页可能不是文章
      extractedAt: Date.now(),
    },
  });

  await setJob({
    status: "extracted",
    message: `已提取 ${res.markdown.length} 字 · ${res.count} 张图`,
    via: res.via || "",
    title: res.title,
    chars: res.markdown.length,
    imageCount: res.count || 0,
  });

  return res;
}

// ---------------------------------------------------------------- ② 下载 md + 图片

async function doDownload() {
  const art = await getArticle();
  if (!art) throw new Error("没有可下载的内容，请先提取。");

  const { title, markdown, images } = art;
  const folder = safeName(title);

  // md 里的图片链接 → 本地相对文件名
  let md = markdown;
  images.forEach((u, i) => {
    md = md.split(`](${u})`).join(`](img_${i + 1}.${extOf(u)})`);
  });

  const errors = [];
  await setJob({
    status: "downloading",
    message: `正在下载：Markdown + ${images.length} 张图`,
    current: 0,
    total: images.length + 1,
    error: null,
  });

  // 下 md（data: URL）
  const mdUrl = "data:text/markdown;charset=utf-8," + encodeURIComponent(md);
  const mdRes = await downloadAndWait({ url: mdUrl, filename: `${folder}/${folder}.md`, conflictAction: "uniquify" });
  if (!mdRes.ok) errors.push("md:" + mdRes.error);
  await setJob({ current: 1, message: `Markdown ${mdRes.ok ? "已保存" : "失败"}，开始下载图片…` });

  // 图片：后台 fetch 成字节 → data URL → 下载（避免下载管理器联网卡死）
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < images.length; i++) {
    try {
      const dataUrl = await imageToDataUrl(images[i]);
      const res = await downloadAndWait({
        url: dataUrl,
        filename: `${folder}/img_${i + 1}.${extOf(images[i])}`,
        conflictAction: "uniquify",
      });
      if (res.ok) okCount++;
      else {
        failCount++;
        if (errors.length < 5) errors.push(`img${i + 1}:${res.error}`);
      }
    } catch (e) {
      failCount++;
      if (errors.length < 5) errors.push(`img${i + 1}:fetch_${e.name || e.message}`);
    }
    await setJob({ current: i + 2, message: `下载图片 ${i + 1}/${images.length}` });
    if (i < images.length - 1) await sleep(IMG_GAP_MS);   // 限速，别把图床惹毛
  }

  const allOk = mdRes.ok && failCount === 0;
  await setJob({
    status: "done",
    lastAction: "download",
    message: allOk
      ? `已保存到「${folder}」：Markdown + ${okCount} 张图`
      : `保存到「${folder}」：md ${mdRes.ok ? "✅" : "❌"} · 图片 ${okCount}/${okCount + failCount}`,
    result: { folder, mdOk: mdRes.ok, okCount, failCount, errors },
  });

  return { ok: true, folder, mdOk: mdRes.ok, okCount, failCount, errors };
}

// ---------------------------------------------------------------- ③ 导出单文件 HTML

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 行内解析：图片 / 粗体 / 链接。内容来自任意网站，一律先转义再拼。
//
// ⚠️ 图片的分支必须排在链接前面 —— ![x](y) 里面就含着 [x](y)，
//    顺序反了的话图片会被当成链接匹配掉。
//
// ⚠️ 而且这里**必须处理图片**：早先只认粗体和链接，结果维基文章里
//    夹在列表项里的 16 张图（`-   ![](...)`）全被当纯文本转义了，
//    只有独立成行的 12 张进了 HTML。
const INLINE_RE = new RegExp(
  '(!\\[([^\\]]*)\\]\\(\\s*([^\\s)]+)(?:\\s+"[^"]*")?\\s*\\))' +   // 1 图片 / 2 alt / 3 地址
  '|(\\*\\*(.+?)\\*\\*)' +                                          // 4 粗体 / 5 内容
  '|(\\[([^\\]]*)\\]\\(\\s*<?(https?://[^\\s)>]+)>?' +              // 6 链接 / 7 文字 / 8 地址
  '(?:\\s+"[^"]*"|\\s+\'[^\']*\')?\\s*\\))',
  'g'
);

// 图片渲染：抓到了就用内嵌的 data URL，没抓到退回原始地址并标注出来
function imgTagHtml(url, imgMap, alt) {
  const embedded = imgMap.get(url);
  const src = embedded || url;
  return (
    `<figure><img src="${esc(src)}" alt="${esc(alt || "")}" loading="lazy">` +
    (embedded ? "" : `<figcaption>⚠️ 这张图没能内嵌，仍指向原站：${esc(url)}</figcaption>`) +
    `</figure>`
  );
}

function inlineToHtml(text, imgMap) {
  let out = "";
  let last = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out += imgTagHtml(m[3], imgMap, m[2]);
    } else if (m[4] !== undefined) {
      out += `<strong>${esc(m[5])}</strong>`;
    } else {
      out += `<a href="${esc(m[8])}" target="_blank" rel="noopener noreferrer">${esc(m[7] || m[8])}</a>`;
    }
    last = INLINE_RE.lastIndex;
  }
  out += esc(text.slice(last));
  return out;
}

// Markdown → HTML。只处理我们自己会产出的那几种结构，不做通用解析。
function mdToHtml(md, imgMap) {
  const lines = String(md).split("\n");
  const out = [];
  let i = 0;
  let inList = false;
  const closeList = () => {
    if (inList) { out.push("</ul>"); inList = false; }
  };
  const inl = (t) => inlineToHtml(t, imgMap);

  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (!line) { closeList(); i++; continue; }

    if (line.startsWith("```")) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^-{3,}$/.test(line.trim())) { closeList(); out.push("<hr>"); i++; continue; }

    if (line.startsWith("> ")) {
      closeList();
      const buf = [];
      while (i < lines.length && lines[i].startsWith("> ")) buf.push(lines[i++].slice(2));
      out.push(`<blockquote>${buf.map((t) => `<p>${inl(t)}</p>`).join("")}</blockquote>`);
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inl(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inl(line.replace(/^[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }

    closeList();
    out.push(`<p>${inl(line)}</p>`);
    i++;
  }
  closeList();
  return out.join("\n");
}

function buildHtmlDoc(title, bodyHtml, meta) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
/* 配色跟着图标 P6 走：纸白米黄 + 麂皮驼 + 赭石。与 popup.html 同一套值。
   浅色主题用深的赭石、深色主题用浅的麂皮驼 —— 强调色要托在对比底上才立得住。 */
:root{--paper:#FAF7F0;--paper2:#F1ECE0;--ink:#1B1C20;--soft:#6A665E;--rule:#E2DACA;--accent:#8B4A26}
@media(prefers-color-scheme:dark){:root{--paper:#1A1714;--paper2:#241F1A;--ink:#EDE5D7;--soft:#A09687;--rule:#3A322A;--accent:#C9925B}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-size:16px;line-height:1.85;
 font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif;
 -webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:40px 24px 100px}
h1{font-size:27px;line-height:1.35;margin:0 0 16px}
h2{font-size:20px;margin:38px 0 13px;padding-top:13px;position:relative}
h2::before{content:"";position:absolute;top:0;left:0;width:32px;height:3px;border-radius:2px;background:var(--accent)}
h3{font-size:17px;margin:30px 0 10px}
h4{font-size:15px;margin:24px 0 8px;color:var(--soft)}
p{margin:13px 0}
a{color:var(--accent);text-underline-offset:2px;word-break:break-word}
strong{font-weight:650}
hr{border:0;height:1px;background:var(--rule);margin:30px 0}
ul{margin:13px 0;padding-left:22px}
li{margin:7px 0}
blockquote{margin:18px 0;padding:11px 16px;border-left:3px solid var(--accent);
 background:var(--paper2);border-radius:0 8px 8px 0;color:var(--soft);font-size:14.5px}
blockquote p{margin:5px 0}
pre{margin:18px 0;padding:14px 16px;overflow-x:auto;background:var(--paper2);
 border:1px solid var(--rule);border-radius:8px;font-size:13px;line-height:1.6;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
figure{margin:22px 0}
figure img{max-width:100%;height:auto;border-radius:10px;border:1px solid var(--rule);display:block}
figcaption{margin-top:7px;font-size:11.5px;color:var(--soft);word-break:break-all}
.foot{margin-top:60px;padding-top:18px;border-top:1px solid var(--rule);
 font-size:12px;color:var(--soft);line-height:1.8}
@media print{body{background:#fff}main{max-width:none;padding:0}.foot{display:none}}
</style></head>
<body><main>
${bodyHtml}
<div class="foot">${meta}</div>
</main></body></html>`;
}

async function doHtml() {
  const art = await getArticle();
  if (!art) throw new Error("没有可导出的内容，请先提取。");

  const { title, url, markdown, images } = art;
  const folder = safeName(title);

  await setJob({
    status: "building",
    message: `正在抓取 ${images.length} 张图并内嵌…`,
    current: 0,
    total: images.length,
    error: null,
  });

  // 图片全部转成 data: URL 内嵌 —— 这样生成的 HTML 是自包含的，
  // 断网能看、换设备能看、发给别人也能看，不依赖原站。
  const imgMap = new Map();
  let failed = 0;
  for (let i = 0; i < images.length; i++) {
    try {
      imgMap.set(images[i], await imageToDataUrl(images[i]));
    } catch (e) {
      failed++;
    }
    await setJob({ current: i + 1, message: `内嵌图片 ${i + 1}/${images.length}` });
    if (i < images.length - 1) await sleep(IMG_GAP_MS);   // 限速，别把图床惹毛
  }

  await setJob({ message: "正在生成 HTML…" });

  const metaBits = [
    url ? `来源：<a href="${esc(url)}">${esc(url)}</a>` : "",
    `提取时间：${new Date().toISOString().slice(0, 10)}`,
    `由「文章打包」生成 · 图片已内嵌，此文件可离线阅读`,
  ].filter(Boolean);

  const html = buildHtmlDoc(title, mdToHtml(markdown, imgMap), metaBits.join("<br>"));

  // 转 base64（service worker 里没有 TextEncoder→btoa 的直通路径，先编码再转）
  const bytes = new TextEncoder().encode(html);
  const b64 = abToBase64(bytes.buffer);

  const dl = await downloadBytes(b64, "text/html;charset=utf-8", `${folder}.html`);
  if (!dl.ok) throw new Error("HTML 下载失败：" + dl.error);

  await setJob({
    status: "done",
    lastAction: "html",
    message:
      `已导出「${folder}.html」（${(bytes.length / 1024 / 1024).toFixed(1)} MB，` +
      `内嵌 ${imgMap.size} 张图${failed ? `，${failed} 张抓取失败` : ""}）`,
    result: { folder: folder + ".html", imgCount: imgMap.size, failed },
  });

  return { ok: true };
}

// ---------------------------------------------------------------- 【已停用】导出 docx
//
// ⚠️ 这个功能**代码完整保留，但界面上已经不暴露了**（v0.7.0 起）。
//
// 背景：它当初是为「腾讯文档导入 → 分享到微信」这条路做的 ——
// 因为往腾讯文档里直接粘贴会丢远程图片，只能把图片内嵌进 docx 再走「导入」。
// 后来这条路作废了（改用单文件 HTML），所以按钮撤掉了。
//
// 但 docx.js 里那套 OOXML 是手搓的（zip 结构 + document.xml + 图片关系映射），
// 花了不少功夫，而且能正常工作，删掉可惜，所以整套留着。
//
// 想恢复只要三步：
//   1. popup.html 加回一个 <button id="btnDocx">
//   2. popup.js 里绑定 chrome.runtime.sendMessage({ action: "docx" })
//   3. 完事 —— 下面这个函数和 onMessage 里的 "docx" 分支从来没删过
//
// 注意：大文件建议改走 downloadBytes()（离屏 blob），
// 现在这里还是直接 data: URL，图多的文章可能超长度限制。

async function doDocx() {
  const art = await getArticle();
  if (!art) throw new Error("没有可导出的内容，请先提取。");

  const { title, markdown, images } = art;
  const folder = safeName(title);

  await setJob({
    status: "building",
    message: `正在抓取 ${images.length} 张图并打包 docx…`,
    current: 0,
    total: images.length,
    error: null,
  });

  const urlToMedia = new Map();
  let idx = 0;
  for (let i = 0; i < images.length; i++) {
    const url = images[i];
    if (urlToMedia.has(url)) continue;
    try {
      const resp = await fetchWithTimeout(url, 15000);
      if (!resp.ok) throw new Error("HTTP" + resp.status);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      idx++;
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      urlToMedia.set(url, {
        rId: `rIdImg${idx}`,
        name: `image${idx}.${isPng ? "png" : "jpg"}`,
        data: bytes,
        dim: imgSize(bytes),
      });
    } catch (e) {
      /* 单张失败跳过，不影响整篇 */
    }
    await setJob({ current: i + 1, message: `抓取图片 ${i + 1}/${images.length}` });
    if (i < images.length - 1) await sleep(IMG_GAP_MS);
  }

  await setJob({ message: "正在生成 docx…" });
  const docBytes = buildDocxBytes(markdown, urlToMedia);
  const b64 = abToBase64(docBytes);

  // ★ 关键改动：下载这一步留在后台。
  // 以前是把 base64 回传给 popup，由 popup 转 Blob 下载 —— 弹窗一关就断。
  // service worker 里没有 URL.createObjectURL，但 downloads 能直接吃 data: URL。
  const dl = await downloadAndWait({
    url: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64," + b64,
    filename: `${folder}.docx`,
    conflictAction: "uniquify",
  });

  if (!dl.ok) throw new Error("docx 下载失败：" + dl.error);

  await setJob({
    status: "done",
    lastAction: "docx",
    message: `已导出「${folder}.docx」（含 ${urlToMedia.size} 张图）。去腾讯文档点「导入」选它。`,
    result: { folder: folder + ".docx", imgCount: urlToMedia.size },
  });

  return { ok: true, folder, imgCount: urlToMedia.size };
}

// ---------------------------------------------------------------- 编排

let inFlight = false;

async function run(fn) {
  if (inFlight) throw new Error("已有任务在跑，请等它结束。");
  inFlight = true;
  startKeepAlive();
  try {
    return await fn();
  } catch (err) {
    await setJob({ status: "error", error: err?.message || String(err) });
    throw err;
  } finally {
    inFlight = false;
    stopKeepAlive();
  }
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    try {
      if (req.action === "extract") {
        // 立刻回执，任务在后台跑 —— popup 关掉也不影响
        sendResponse({ ok: true });
        run(() => doExtract(req.tabId)).catch(() => {});
        return;
      }

      if (req.action === "download") {
        sendResponse({ ok: true });
        run(doDownload).catch(() => {});
        return;
      }

      if (req.action === "html") {
        sendResponse({ ok: true });
        run(doHtml).catch(() => {});
        return;
      }

      if (req.action === "docx") {
        sendResponse({ ok: true });
        run(doDocx).catch(() => {});
        return;
      }

      if (req.action === "getState") {
        sendResponse({ ok: true, job: await getJob(), article: await getArticle() });
        return;
      }

      if (req.action === "clear") {
        await chrome.storage.session.remove([JOB_KEY, ART_KEY]);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "未知 action: " + req.action });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true; // 异步响应
});
