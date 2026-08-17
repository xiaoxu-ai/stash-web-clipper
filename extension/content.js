// content.js — 把当前页面的文章正文和图片提取成 Markdown。
//
// 两条路线，按域名分流：
//   x.com / twitter.com → extractX()：手工调过的 X 专用逻辑（DraftJS 结构、引用推文、代码块）
//   其它任何网站        → extractGeneric()：Readability + Turndown 通用提取
//
// 为什么不统一用 Readability：它是为传统文章页调的（一堆 <p> 装在一个容器里），
// 而 X 是单页应用、正文是 DraftJS 的 data-block 碎块，Readability 抓得比手工逻辑差得多。
// 所以是「分流」不是「替换」—— X 那套一行都没动。
//
// 本文件由 background 用 chrome.scripting.executeScript 按需注入，
// 依赖 vendor/Readability.js 和 vendor/turndown.js 先注入好。

(function () {
  "use strict";

  // 按需注入可能重复执行，装一次就够了
  if (window.__xArticle && window.__xArticle.installed) return;

  // ---------- 工具：X 图片 URL 升到大图 ----------
  function toLargeImage(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes("pbs.twimg.com") && u.searchParams.has("name")) {
        u.searchParams.set("name", "large");
      }
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  function cleanMarkdown(md) {
    return md.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  }

  // 从容器里取一张正文图片 URL：优先 <img>，退回背景图 URL（背景图即使懒加载也已填）
  function mediaUrlIn(el) {
    const im = el.querySelector('img[src*="pbs.twimg.com/media"]');
    if (im && im.src) return im.src;
    const bg = el.querySelector('[style*="background-image"]');
    if (bg) {
      const m = (bg.getAttribute("style") || "").match(/url\("?([^")]*media[^")]*)"?\)/);
      if (m) return m[1].replace(/&amp;/g, "&");
    }
    return null;
  }

  // ========== 策略 0：X 长文 Article（结构化，最精准）==========
  // 取一个 DraftJS 文本块的文字，保留加粗。
  function blockText(block) {
    const line = block.querySelector(".public-DraftStyleDefault-block") || block;
    let s = "";
    // 收集块内所有文字节点（含被包成背景图的 emoji），按文档顺序
    line.querySelectorAll('[data-text="true"]').forEach((t) => {
      const txt = t.textContent;
      // 加粗：向上查祖先 span 是否 font-weight bold
      let bold = false, p = t;
      while (p && p !== line) {
        const st = (p.getAttribute && p.getAttribute("style")) || "";
        if (/font-weight:\s*(bold|[6-9]00)/.test(st)) { bold = true; break; }
        p = p.parentElement;
      }
      s += bold ? `**${txt}**` : txt;
    });
    return s.trim();
  }

  // 一个 section 是不是「嵌入的推文」（引用别人的推文/文章）
  function isEmbeddedTweet(block) {
    return !!block.querySelector('[data-testid="User-Name"], [data-testid="Tweet-User-Avatar"]');
  }

  // 把嵌入的推文渲染成引用块，而不是丢掉 —— 作者特意引它，通常是正文的一部分
  function embeddedTweetToMd(block) {
    const lines = [];
    const un = block.querySelector('[data-testid="User-Name"]');
    if (un) {
      const t = (un.innerText || "").replace(/\s+/g, " ").trim();
      const m = t.match(/@(\w+)/);
      if (m) lines.push(`**引用推文** · @${m[1]}`);
      else if (t) lines.push(`**引用推文** · ${t.split(" ")[0]}`);
    }
    if (!lines.length) lines.push("**引用推文**");

    block.querySelectorAll('[data-testid="tweetText"]').forEach((t) => {
      const txt = (t.innerText || "").trim();
      if (txt) lines.push(txt);
    });

    const imgs = [];
    const src = mediaUrlIn(block);
    if (src) imgs.push(toLargeImage(src));

    // 引用块：每行前面加 "> "
    const md = lines.join("\n\n").split("\n").map((l) => "> " + l).join("\n");
    return { md, images: imgs };
  }

  function extractArticle() {
    const comp = document.querySelector('[data-testid="longformRichTextComponent"]');
    if (!comp) return null;

    const parts = [];
    const images = [];

    // 头图/封面：两种放法都覆盖——① article-cover-image；② 正文组件外的 tweetPhoto
    const readView = document.querySelector('[data-testid="twitterArticleReadView"]') || document.body;
    let coverSrc = null;
    const coverEl = readView.querySelector('[data-testid="article-cover-image"]');
    if (coverEl) coverSrc = mediaUrlIn(coverEl);
    if (!coverSrc) {
      const photos = readView.querySelectorAll('[data-testid="tweetPhoto"]');
      for (const ph of photos) {
        if (comp.contains(ph)) continue; // 跳过正文内的图
        const s = mediaUrlIn(ph);
        if (s) { coverSrc = s; break; }
      }
    }
    if (coverSrc) { const s = toLargeImage(coverSrc); images.push(s); parts.push(`![](${s})`); }

    // 按文档顺序遍历所有块（h1/h2/div/section 都算）
    const blocks = Array.from(comp.querySelectorAll('[data-block="true"]'));

    // ⚠️ 关键：先算出「最后一块真正的正文」在哪儿。
    //
    // 因为**文章中间嵌入的推文，和文末的"相关推文"，DOM 结构一模一样**。
    // 老版本见到推文块就无条件 break，结果作者只要在正文里引用了一条推文，
    // 提取就在那里当场停止，后面全丢 —— 实测两篇长文都只提到 300~800 字就断了。
    //
    // 正确做法是往后看：后面还有正文 → 这只是中途的引用，继续；
    // 后面全是推文块 → 才是真到尾巴了，停。
    let lastContent = -1;
    blocks.forEach((b, i) => {
      if (b.tagName.toLowerCase() === "section") {
        if (isEmbeddedTweet(b)) return;          // 推文块不算正文锚点
        lastContent = i;                          // 分割线 / 代码块 / 正文图都算
      } else if (blockText(b)) {
        lastContent = i;
      }
    });

    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const name = block.tagName.toLowerCase();
      const cls = block.className || "";

      if (name === "section") {
        if (isEmbeddedTweet(block)) {
          if (bi > lastContent) break;            // 后面没正文了 = 文末相关推文，到此为止
          const emb = embeddedTweetToMd(block);   // 否则是正文里的引用，收进来
          if (emb.md) parts.push(emb.md);
          emb.images.forEach((s) => images.push(s));
          continue;
        }
        // 分割线
        if (block.querySelector('[role="separator"]')) { parts.push("---"); continue; }
        // 代码块（可复制的 Prompt）
        const cb = block.querySelector('[data-testid="markdown-code-block"]');
        if (cb) { parts.push("```\n" + cb.innerText.trim() + "\n```"); continue; }
        // 正文内嵌图片
        const src = mediaUrlIn(block);
        if (src) { const s = toLargeImage(src); images.push(s); parts.push(`![](${s})`); }
        continue;
      }

      const txt = blockText(block);
      if (!txt) continue;
      if (cls.indexOf("longform-header-one") >= 0) parts.push("# " + txt);
      else if (cls.indexOf("longform-header-two") >= 0) parts.push("## " + txt);
      else if (cls.indexOf("longform-blockquote") >= 0) parts.push("> " + txt);
      else parts.push(txt);
    }
    return { markdown: parts.join("\n\n"), images: [...new Set(images)] };
  }

  // ========== 收集图片（供退化策略用）==========
  function collectImages(root) {
    const imgs = [];
    root.querySelectorAll("img").forEach((img) => {
      const src = img.src || img.getAttribute("src") || "";
      if (!src) return;
      if (src.includes("/profile_images/")) return;
      if (src.includes("emoji")) return;
      if (src.startsWith("data:")) return;
      if (src.includes("pbs.twimg.com/media")) imgs.push(toLargeImage(src));
    });
    return [...new Set(imgs)];
  }

  // ========== 策略 1：普通推文 / 线程 ==========
  function extractFromTweets(col) {
    const textNodes = col.querySelectorAll('[data-testid="tweetText"]');
    if (!textNodes.length) return null;
    const parts = [];
    const images = [];
    const articles = col.querySelectorAll("article");
    const scope = articles.length ? articles : [col];
    scope.forEach((art) => {
      art.querySelectorAll('[data-testid="tweetText"]').forEach((t) => {
        const md = (t.innerText || "").trim();
        if (md) parts.push(md);
      });
      collectImages(art).forEach((src) => { images.push(src); parts.push(`![](${src})`); });
    });
    return { markdown: parts.join("\n\n"), images: [...new Set(images)] };
  }

  // ========== 策略 2：退化启发式（最大文本块）==========
  function extractLargestBlock(col) {
    let best = null, bestLen = 0;
    col.querySelectorAll("div, article, section").forEach((el) => {
      const len = (el.innerText || "").length;
      if (len > bestLen && len < 200000) { best = el; bestLen = len; }
    });
    if (!best) return null;
    const parts = [best.innerText.trim()];
    const images = collectImages(best);
    images.forEach((s) => parts.push(`![](${s})`));
    return { markdown: parts.join("\n\n"), images };
  }

  // 取来源信息：作者名、@handle、发布日期
  function getMeta() {
    const un = document.querySelector('[data-testid="User-Name"]');
    let name = "", handle = "";
    if (un) {
      const txt = un.innerText.replace(/\r/g, "").trim();
      const m = txt.match(/@(\w+)/);
      handle = m ? "@" + m[1] : "";
      name = (handle ? txt.split("@")[0] : txt).split("\n")[0].trim();
    }
    let date = "";
    const idm = location.pathname.match(/status\/(\d+)/);
    const id = idm ? idm[1] : "";
    const times = document.querySelectorAll("time");
    for (const t of times) {
      const a = t.closest("a");
      if (id && a && (a.getAttribute("href") || "").includes("/status/" + id)) {
        date = t.textContent.trim(); break;
      }
    }
    if (!date) times.forEach((t) => { const s = t.textContent.trim(); if (s.length > date.length) date = s; });
    if (date.indexOf("·") >= 0) date = date.split("·").pop().trim();
    return { name, handle, date };
  }

  function buildByline() {
    const meta = getMeta();
    const bits = [];
    if (meta.name || meta.handle) {
      const url = meta.handle ? `https://x.com/${meta.handle.slice(1)}` : "";
      bits.push(url ? `[${meta.name} ${meta.handle}](${url})` : meta.name);
    }
    if (meta.date) bits.push(meta.date);
    bits.push(`[查看原文](${location.href})`);
    return "> 来源：" + bits.join(" · ");
  }

  // ================= X 专用（以下逻辑保持原样，未做改动）=================
  function extractX() {
    const col =
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector("main") ||
      document.body;

    const result = extractArticle() || extractFromTweets(col) || extractLargestBlock(col);
    if (!result) return { ok: false, error: "没找到可提取的正文" };

    const titleEl = document.querySelector('[data-testid="twitter-article-title"]');
    const title = (titleEl ? titleEl.innerText : (document.title || ""))
      .replace(/ \/ X$/, "").replace(/ \/ Twitter$/, "").trim();

    const md = cleanMarkdown(`# ${title}\n\n${buildByline()}\n\n${result.markdown}`);
    return { ok: true, title, url: location.href, markdown: md, images: result.images, count: result.images.length };
  }

  // ================= 通用提取（Readability + Turndown）=================

  function isXSite() {
    return /(^|\.)(x|twitter)\.com$/i.test(location.hostname);
  }

  function absUrl(u) {
    try { return new URL(u, location.href).href; } catch (e) { return u || ""; }
  }

  function extractGeneric() {
    if (typeof Readability !== "function") {
      return { ok: false, error: "Readability 没加载成功（vendor/Readability.js）" };
    }

    // ⚠️ Readability 会改动传给它的 DOM，必须传克隆件，否则会把用户正在看的页面拆了
    const docClone = document.cloneNode(true);
    let art = null;
    try {
      art = new Readability(docClone, { charThreshold: 200 }).parse();
    } catch (e) {
      return { ok: false, error: "解析失败：" + (e && e.message ? e.message : e) };
    }
    if (!art || !art.content) {
      return { ok: false, error: "这个页面提取不出文章正文（可能不是文章页，或正文太短）" };
    }

    // Readability 输出的是 HTML，转成 Markdown
    if (typeof TurndownService !== "function") {
      return { ok: false, error: "Turndown 没加载成功（vendor/turndown.js）" };
    }
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
      emDelimiter: "*",
    });

    // 先把页面上所有图片的**真实渲染尺寸**记下来。
    // 这是判断「是不是正文图」最可靠的依据 —— 比 HTML 属性和 URL 参数都准，
    // 因为它是浏览器实际加载后的结果。
    const liveSize = new Map();
    try {
      document.querySelectorAll("img").forEach((im) => {
        const src = im.currentSrc || im.src;
        if (src) liveSize.set(src, { w: im.naturalWidth || 0, h: im.naturalHeight || 0 });
      });
    } catch (e) {}

    const MIN_PX = 150;  // 正文配图通常 ≥300px；头像多在 64~128

    // 头像 / 图标 / 追踪像素的 URL 特征。
    // 实测 Reddit 帖子页抓出来的 3 张"图片"全是 profileIcon 和 avatar_default，
    // 而它们既没有 width/height 属性、尺寸只写在 URL 查询参数里，所以必须专门拦。
    const JUNK_URL = /avatar|profileicon|profile_image|\/icons?\/|logo|emoji|sprite|badge|favicon|spacer|pixel|blank\.gif|1x1/i;

    function isContentImage(node, url) {
      if (JUNK_URL.test(url)) return false;

      // 真实渲染尺寸（最可信）
      const live = liveSize.get(url);
      if (live && (live.w || live.h)) {
        return !((live.w && live.w < MIN_PX) || (live.h && live.h < MIN_PX));
      }

      // 退而求其次：URL 查询参数里的尺寸（Reddit、微信等 CDN 常这么写）
      try {
        const q = new URL(url).searchParams;
        const qw = Number(q.get("width") || q.get("w") || 0);
        const qh = Number(q.get("height") || q.get("h") || 0);
        if ((qw && qw < MIN_PX) || (qh && qh < MIN_PX)) return false;
      } catch (e) {}

      // 最后看 HTML 属性
      const aw = parseInt(node.getAttribute("width") || "0", 10);
      const ah = parseInt(node.getAttribute("height") || "0", 10);
      if ((aw && aw < MIN_PX) || (ah && ah < MIN_PX)) return false;

      return true;
    }

    const images = [];
    td.addRule("collectImages", {
      filter: "img",
      replacement: function (content, node) {
        const raw = node.getAttribute("src") || "";
        if (!raw || raw.startsWith("data:")) return "";   // 内联小图/追踪像素
        const u = absUrl(raw);
        if (!isContentImage(node, u)) return "";
        if (!images.includes(u)) images.push(u);
        return "\n\n![](" + u + ")\n\n";
      },
    });
    // 图片说明单独成行，别粘在正文里
    td.addRule("figcaption", {
      filter: "figcaption",
      replacement: (content) => (content.trim() ? "\n\n*" + content.trim() + "*\n\n" : ""),
    });

    let body = "";
    try {
      body = td.turndown(art.content);
    } catch (e) {
      return { ok: false, error: "转 Markdown 失败：" + (e && e.message ? e.message : e) };
    }

    // ── 清理 Turndown 的两个产物 ──
    //
    // 维基这类站点会给正文图片套一层链接（点图跳到文件页），Turndown 把它转成：
    //     [
    //     ![](图片地址)
    //     ](文件页地址)
    // 跨三行，Markdown 渲染器认不出来，显示成一个孤零零的 "[" 加一张图。
    // 那层链接对存档也没价值，直接拆掉只留图片。
    body = body.replace(
      /\[\s*\n*\s*(!\[[^\]]*\]\([^)]*\))\s*\n*\s*\]\([^)]*\)/g,
      "$1"
    );
    // 清掉空链接 []()。
    // ⚠️ 必须用 (?<!!) 排除掉图片 —— 图片写法 ![](地址) 内部就含有 []()，
    //    不加这个前置否定，每张图都会被砍掉后半截，只剩一个孤零零的 "!"。
    //    （这个坑我踩过：一次改动把 28 张图全删没了。）
    body = body.replace(/(?<!!)\[\s*\]\([^)]*\)/g, "");

    // ── 判断这页到底像不像「一篇文章」 ──
    //
    // Readability 对首页/列表页也会返回内容 —— 它把一堆标题链接当正文交出来。
    // 这里不硬拦（判断会错），只标记出来让用户自己决定。
    //
    // ⚠️ 试过 isProbablyReaderable()，**弃用了**：它靠数 <p>/<pre>/<article> 判断，
    // 而 Paul Graham 那种 1990 年代老 HTML（table + font，几乎没有 <p>）会被判成
    // "不像文章"—— 对一篇 6.7 万字的好文章报警属于纯噪音。误报比漏报更糟。
    //
    // 改用**链接文字占比**，而且必须在 DOM 上算：
    // 如果在 Markdown 文本上算，分母会被长长的 URL 撑大，比例被稀释
    // （实测 BBC 首页这么算只有 24%，完全测不出来）。
    let linkDensity = 0;
    try {
      const box = document.createElement("div");
      box.innerHTML = art.content;
      const allChars = (box.textContent || "").replace(/\s/g, "").length;
      const linkChars = Array.from(box.querySelectorAll("a"))
        .map((a) => a.textContent || "")
        .join("")
        .replace(/\s/g, "").length;
      linkDensity = allChars ? Math.min(1, linkChars / allChars) : 0;
    } catch (e) {}

    const plainLen = body.replace(/\s/g, "").length;
    let suspect = null;
    if (linkDensity > 0.5) suspect = "正文里一半以上的字都在链接里，这多半是首页或列表页";
    else if (plainLen < 300) suspect = "正文太短，可能没抓到主体内容";

    // 来源行，跟 X 那条格式对齐
    const bits = [];
    const site = art.siteName || location.hostname;
    bits.push(`[${site}](${location.origin})`);
    if (art.byline) bits.push(String(art.byline).replace(/\s+/g, " ").trim());
    bits.push(`[查看原文](${location.href})`);
    const byline = "> 来源：" + bits.join(" · ");

    const title = (art.title || document.title || "").trim();
    const md = cleanMarkdown(`# ${title}\n\n${byline}\n\n${body}`);

    return {
      ok: true,
      title: title || "untitled",
      url: location.href,
      markdown: md,
      images,
      count: images.length,
      via: "readability",
      suspect,                                  // 有值就说明这页可能不是文章
      linkDensity: Math.round(linkDensity * 100),
    };
  }

  // ================= 分流 =================

  function extract() {
    if (isXSite()) {
      const r = extractX();
      // X 页面但抓不到（比如个人主页、搜索页），也给通用提取一次机会
      if (r && r.ok) return Object.assign(r, { via: "x" });
    }
    return extractGeneric();
  }

  window.__xArticle = { installed: true, extract };
})();
