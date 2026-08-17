// popup.js — 操作面板：发起提取、发起下载、看进度。
//
// 重构前这里存着 `let current = null`（提取结果），**弹窗一关就丢**，
// 想再下载一次得重新提取。现在结果落在 background 的 storage.session 里，
// 弹窗纯粹是个仪表盘：关掉再打开，文章还在，按钮照样能点。

const $ = (id) => document.getElementById(id);
const RUNNING = ["extracting", "downloading", "building"];

let cached = { job: null, article: null };

// ---------------------------------------------------------------- 渲染

function setStatus(text, type = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + type;
}

function setBar(on, current, total) {
  const bar = $("bar");
  if (!on) {
    bar.className = "bar";
    return;
  }
  if (total > 0) {
    bar.className = "bar on";
    $("barFill").style.width = Math.round((current / total) * 100) + "%";
  } else {
    bar.className = "bar indet on";
  }
}

function showArticle(article) {
  const card = $("card");
  if (!article) {
    card.className = "card";
    return;
  }
  $("cardTitle").textContent = article.title || "(无标题)";

  card.querySelectorAll(".warn").forEach((n) => n.remove());
  const meta = $("cardMeta");
  meta.replaceChildren();
  const via = article.via === "readability" ? "通用提取" : article.via === "x" ? "X 专用" : "";
  meta.appendChild(
    document.createTextNode(`${article.markdown.length} 字 · ${article.count} 张图${via ? " · " + via : ""}　`)
  );

  // 提取器觉得这页不像文章时给个提醒 —— 不拦，只是让用户先看一眼再决定要不要存
  if (article.suspect) {
    const w = document.createElement("div");
    w.className = "warn";
    w.textContent = "⚠️ " + article.suspect;
    meta.parentElement.appendChild(w);
  }
  if (article.url) {
    const a = document.createElement("a");
    a.href = article.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "查看原文";
    meta.appendChild(a);
  }
  card.className = "card on";
}

function render(job, article) {
  const busy = !!job && RUNNING.includes(job.status);

  showArticle(article);

  // 有文章才能下载；任何任务进行中就全部锁住
  $("btnExtract").disabled = busy;
  $("btnMd").disabled = busy || !article;
  $("btnHtml").disabled = busy || !article;
  $("linkCopy").style.visibility = article ? "visible" : "hidden";

  if (!job) {
    setStatus("在任意文章页点下面的按钮。");
    return setBar(false);
  }
  if (busy) {
    setStatus(job.message || "处理中…");
    return setBar(true, job.current || 0, job.total || 0);
  }
  if (job.status === "error") {
    setStatus(job.error || "出错了", "err");
    return setBar(false);
  }
  if (job.status === "extracted") {
    setStatus("提取完成。核对一下标题和图片数，然后选一种保存方式。", "ok");
    return setBar(false);
  }
  if (job.status === "done") {
    setStatus(job.message || "完成", "ok");
    return setBar(false);
  }
  setStatus(job.message || "");
  setBar(false);
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ action: "getState" }).catch(() => null);
  cached = { job: res?.job || null, article: res?.article || null };
  render(cached.job, cached.article);
}

// ---------------------------------------------------------------- 按钮
//
// ⚠️ 按钮事件必须**最先**绑定，任何可能抛异常的初始化都排在它们后面。
//
// 教训（2026-08-15）：曾经把 chrome.storage.session.onChanged 的注册写在这上面，
// 而 manifest 里漏了 "storage" 权限 —— chrome.storage 是 undefined，那行直接抛异常，
// 导致下面所有 addEventListener 一个都没执行。
// 表现是「界面完全正常，但点任何按钮都毫无反应」，极难定位。

$("btnExtract").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  // 现在任何网站都能提取，只需要排除浏览器自己的内部页面（那些注入不进去）
  if (!/^https?:\/\//i.test(url)) {
    setStatus("这个页面不能提取。请打开一个正常的网页（http/https）再试。", "err");
    return;
  }
  $("btnExtract").disabled = true;
  setStatus("正在提取正文…");
  setBar(true, 0, 0);

  const res = await chrome.runtime.sendMessage({ action: "extract", tabId: tab.id });
  if (!res?.ok) {
    setStatus(res?.error || "启动失败", "err");
    setBar(false);
    refresh();
  }
});

// 图片可能在任意域名上（尤其是通用提取的网站）。后台去 fetch 图片需要该域名的权限，
// 否则会被跨域拦掉。这里按实际图片地址**精确申请**，而不是一上来就要 <all_urls>。
//
// ⚠️ chrome.permissions.request 必须在用户手势里发起，所以放在点击处理函数的最前面，
//    前面不能有任何 await（等待过久手势会失效，弹窗就出不来）。
function imageOrigins() {
  const out = new Set();
  for (const u of cached.article?.images || []) {
    try {
      out.add(new URL(u).origin + "/*");
    } catch (e) {}
  }
  return [...out];
}

async function withImagePermission(fn) {
  const origins = imageOrigins();
  if (origins.length) {
    let granted = false;
    try {
      // 已经有权限时 Chrome 会直接返回 true，不会弹窗
      granted = await chrome.permissions.request({ origins });
    } catch (e) {}
    if (!granted) {
      setStatus(
        "没拿到图片所在域名的访问权限，图片会下载失败（正文不受影响）。可以再点一次并选「允许」。",
        "err"
      );
      // 不 return —— 让用户仍然能拿到正文
    }
  }
  fn();
}

$("btnMd").addEventListener("click", () => {
  withImagePermission(() => {
    setStatus("已交后台下载，这个窗口可以关掉。");
    setBar(true, 0, 0);
    chrome.runtime.sendMessage({ action: "download" });
  });
});

$("btnHtml").addEventListener("click", () => {
  withImagePermission(() => {
    setStatus("已交后台打包，这个窗口可以关掉。");
    setBar(true, 0, 0);
    chrome.runtime.sendMessage({ action: "html" });
  });
});

// 注：DOCX 导出功能仍然完整保留在 background.js 的 doDocx() 和 docx.js 里，
// 只是界面上不再暴露（腾讯文档那条路已作废）。想恢复：
//   1. popup.html 加回一个 id="btnDocx" 的按钮
//   2. 这里加 chrome.runtime.sendMessage({ action: "docx" })
// background 那边的 "docx" 消息分支一直没删，接上就能用。

$("linkCopy").addEventListener("click", async (e) => {
  e.preventDefault();
  if (!cached.article) return;
  const link = $("linkCopy");
  const old = link.textContent;
  try {
    await navigator.clipboard.writeText(cached.article.markdown);
    link.textContent = "已复制 ✓";
  } catch (err) {
    link.textContent = "复制失败";
  }
  setTimeout(() => (link.textContent = old), 1500);
});

$("linkClear").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ action: "clear" });
  refresh();
});

// ---------------------------------------------------------------- 初始化
// 单独包一层：万一 storage 出问题，也只是失去自动刷新，按钮仍然可用。

try {
  chrome.storage.session.onChanged.addListener(() => refresh());
} catch (e) {
  setStatus("进度不会自动刷新（storage 不可用）：" + (e?.message || e), "err");
}

refresh();
