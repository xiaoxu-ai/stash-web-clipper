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

  // ⚠️ 交给 Readability 之前必须先做这一步，否则章节标题会全丢。
  //
  // 根因：Readability 组装正文时按「兄弟节点得分」筛选，而只装着一个标题、
  // 没有段落的包装元素得分极低，会被**整个丢掉** —— 标题跟着一起没。
  //
  // 实测中文维基「长城」：页面 28 个标题（26 个被 <div class="mw-heading"> 包着），
  // Readability 输出 0 个，正文变成 168 段平铺，层次全失。
  // 拆掉包装后立刻恢复成 26 个，层级也对（H2 历史 / H3 春秋战国时期 / …）。
  //
  // 不写死 .mw-heading —— 按**结构**判断，别的 CMS 也有同样的包法。
  function unwrapHeadingContainers(root) {
    let total = 0;
    // 嵌套的包装要多跑几轮：querySelectorAll 是文档序，外层先被检查、
    // 那时它还没有直接的标题子节点，得等内层拆完下一轮才轮到它。
    for (let pass = 0; pass < 3; pass++) {
      let n = 0;
      root.querySelectorAll("div, section, header, hgroup").forEach((el) => {
        const heads = el.querySelectorAll(
          ":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6"
        );
        if (heads.length !== 1) return;
        const h = heads[0];
        // 容器里除了标题不能有别的实质内容（放行「编辑」这类小挂件）
        if (el.querySelector("p, ul, ol, table, pre, blockquote, figure, img")) return;
        if ((el.textContent || "").length - (h.textContent || "").length > 40) return;
        el.replaceWith(h);
        n++;
      });
      total += n;
      if (!n) break;
    }
    return total;
  }

  // 很多文档站（MDN、GitBook 及各类技术文档）会把标题文字整个套进一个指向自身的
  // 锚点链接里 —— 就是标题旁边那个 🔗 图标。抓出来会变成：
  //     ## [你应该已经掌握哪些知识？](#你应该已经掌握哪些知识？)
  // 标题里挂着一条指向自己的链接，既难看又没用。
  //
  // 只拆 href 以 # 开头的（站内锚点）；标题里指向别的页面的链接是有意义的，保留。
  function stripHeadingAnchors(root) {
    let n = 0;
    root
      .querySelectorAll("h1 a[href^='#'], h2 a[href^='#'], h3 a[href^='#'], h4 a[href^='#'], h5 a[href^='#'], h6 a[href^='#']")
      .forEach((a) => {
        if ((a.textContent || "").trim()) a.replaceWith(...a.childNodes); // 有文字：拆掉链接留文字
        else a.remove();                                                   // 纯图标锚点：整个删掉
        n++;
      });
    return n;
  }

  // ─────────────────────── 维基百科：信息框（infobox）───────────────────────
  //
  // 维基条目右上角那张表（官方名称/任期/前任继任…）信息密度很高，但它**不是正文**。
  // Readability 会把它当正文的一部分交出来，夹在开头很碍事。
  //
  // 做法：先摘出来、从 DOM 里删掉（否则会重复），最后作为**附录接在文末**。
  // 放文末而不是开头 —— 这工具的承诺是「干净正文」，信息框是附加价值，不该挡在前面。
  // 实测蒋介石那页信息框 3478 字，放开头等于先读三千字表格才见正文。

  function isWikipedia() {
    try { return /(^|\.)wikipedia\.org$/i.test(location.hostname); } catch (e) { return false; }
  }

  // ─────────────────────── 微信「长图」文章：正文图在分享轮播里 ───────────────────────
  //
  // 有一类微信文章（整篇就是一张长图 + 图下几行说明文字）不走常规的 #js_content 正文流，
  // 图片单独放在一个「分享媒体轮播」组件里（`.share_media` / `#img_swiper_content` 之类的
  // id/class，同一个模板的图片轮播、点开"分享"看到的也是它）—— 跟正文文字是**两棵不相交的
  // DOM 子树**。Readability 按文字密度打分，纯图片的容器分数是 0，永远选不进正文，图片就这样
  // 悄悄消失了：文字提取完全正常（用户不会觉得"提取失败"），只有图片没了。
  //
  // 和维基信息框是同一类问题（内容在 Readability 选中的正文节点之外），解法也一样：
  // 单独摘出来，不依赖 Readability。
  //
  // ⚠️ 只在**主提取完全没抓到一张图**时才启用 —— 正常图文文章的图已经在 #js_content 里走完
  // 整套 data-src / 尺寸过滤逻辑了，这里要是无条件也摸一遍，有把同一张图重复收进来、或者
  // 误抓这个组件里其它内容（比如它在别的文章模板里到底装的是什么，没有逐一验证过）的风险。
  function isWeChatArticle() {
    try { return location.hostname === "mp.weixin.qq.com"; } catch (e) { return false; }
  }
  function takeWeChatSwiperImages(doc) {
    if (!isWeChatArticle()) return [];
    // ⚠️ 实测这个轮播里同一张图常出现两份：原图 + 微信另存的「转发用加水印版」——
    // 两者尺寸一样，但 file id 不同（各是独立文件，不是同一张图的懒加载/清晰度变体），
    // 水印版 URL 带 watermark=1。不排除的话，导出里这张图会重复出现一次。
    return [...doc.querySelectorAll(".share_media img")]
      .filter((img) => !/[?&]watermark=1(?:&|$)/.test(img.getAttribute("src") || ""));
  }

  // 从克隆的 DOM 里摘走信息框（会改动传入的 doc）
  function takeWikiInfobox(doc) {
    if (!isWikipedia()) return null;
    const box = doc.querySelector("table.infobox, table.infobox_v3, .infobox");
    if (!box) return null;
    box.remove();

    // ⚠️ 跳过默认折叠的嵌套表（class 含 mw-collapsed）。
    // 它们装的是「其他中央职务」这类履历，内容是真的，但：
    //   1. 页面上默认看不见，不属于「你读到的那一页」
    //   2. 纯文本取出来是粘连的（"任期1928年10月10日—1931年12月15日前任谭延闿继任林森"），
    //      要变得能读必须解析内部结构，成本远高于收益
    // 蒋介石那页有 3 张这种表（86 行）。决定先跳过，日后再单独做。
    box.querySelectorAll("table.mw-collapsible").forEach((t) => t.remove());
    box.querySelectorAll("style, script, sup.reference, .mw-editsection").forEach((t) => t.remove());
    return box;
  }

  // 取文本时给块级元素之间补分隔，否则会粘成一坨
  function boxText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("br, div, li, p, tr").forEach((n) => n.insertAdjacentText("beforebegin", "\n"));
    return clone.textContent.replace(/[ \t ]+/g, " ")
      .split("\n").map((s) => s.trim()).filter(Boolean).join(" · ").trim();
  }

  // 渲染成 Markdown。用「加粗键 + 列表」而不是表格 ——
  // ⚠️ 导出 HTML 用的 mdToHtml 不支持 Markdown 表格，写成表格会显示成一堆竖线。
  function renderWikiInfobox(box, onImage) {
    const out = ["", "---", "", "## 信息框", ""];
    const rows = box.querySelectorAll(":scope > tbody > tr");
    let wrote = 0;

    rows.forEach((tr) => {
      const th = tr.querySelector(":scope > th");
      const td = tr.querySelector(":scope > td");
      const k = boxText(th);
      const v = boxText(td);

      // 图片行：交给外面统一走图片过滤和收集
      const img = tr.querySelector("img");
      if (img) {
        const md = onImage(img);
        if (md) { out.push(md, ""); wrote++; }
        if (v && !k) { out.push("*" + v + "*", ""); }   // 图片说明
        return;
      }

      if (k && !v) { out.push("", "### " + k, ""); wrote++; return; }   // 分节标题
      if (k && v)  { out.push("- **" + k + "**：" + v); wrote++; return; } // 键值对
      if (!k && v) { out.push("- " + v); wrote++; return; }              // 只有内容
      // 两边都空 → 丢掉
    });

    return wrote ? out.join("\n") + "\n" : "";
  }

  function extractGeneric() {
    if (typeof Readability !== "function") {
      return { ok: false, error: "Readability 没加载成功（vendor/Readability.js）" };
    }

    // ⚠️ Readability 会改动传给它的 DOM，必须传克隆件，否则会把用户正在看的页面拆了
    const docClone = document.cloneNode(true);
    unwrapHeadingContainers(docClone);
    stripHeadingAnchors(docClone);
    // ⚠️ 必须在跑 Readability 之前摘走，否则信息框会被当正文收进去、出现两次
    const wikiBox = takeWikiInfobox(docClone);
    // 微信长图的分享轮播不会被 Readability 选中，不影响正文评分，摘不摘都行——
    // 但在 Readability.parse() 之前先摘引用快照，不依赖 parse() 之后 docClone 的状态
    // （它会怎么改动没选中的节点，没把握，不如摘早了稳）。
    const wechatSwiperImgs = takeWeChatSwiperImages(docClone);
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

    // ⚠️ 尺寸判据：看**最长边**，不是「任一边」。
    //
    // 旧写法是「任一边小于 150 就毙」，会误杀横构图的正文照片：
    // 维基缩略图的 HTML 属性写的是显示尺寸（常见 180×135），高度 135 < 150 →
    // 一张长城实景照被当成图标扔掉。实测「长城」条目因此只抓到 10 张（应有 21 张）。
    //
    // 而且这在真实使用中必然发生：用户打开长文**直接点提取**、没往下滚，
    // 首屏以外的图都还没懒加载（naturalWidth=0），判断就会落到 HTML 属性这一档。
    //
    // 新规则：内容图不管横竖，**总有一边是大的**；图标和头像则两边都小。
    //   保留条件 = 最长边 ≥ 150，且（若两边都知道）最短边 ≥ 60
    //   180×135 照片 → 留 ‖ 40×25 图标 → 扔 ‖ 64×64 头像 → 扔 ‖ 400×20 分隔条 → 扔
    const MIN_SHORT_PX = 60;
    function sizeLooksLikeContent(w, h) {
      const long = Math.max(w || 0, h || 0);
      if (!long) return null;                  // 一无所知，交给下一档判断
      if (long < MIN_PX) return false;
      if (w && h && Math.min(w, h) < MIN_SHORT_PX) return false;
      return true;
    }

    function isContentImage(node, url) {
      if (JUNK_URL.test(url)) return false;

      // 真实渲染尺寸（最可信）
      const live = liveSize.get(url);
      if (live) {
        const verdict = sizeLooksLikeContent(live.w, live.h);
        if (verdict !== null) return verdict;
      }

      // 退而求其次：URL 查询参数里的尺寸（Reddit、微信等 CDN 常这么写）
      try {
        const q = new URL(url).searchParams;
        const verdict = sizeLooksLikeContent(
          Number(q.get("width") || q.get("w") || 0),
          Number(q.get("height") || q.get("h") || 0)
        );
        if (verdict !== null) return verdict;
      } catch (e) {}

      // 最后看 HTML 属性（微信懒加载图不写 width/height，写的是 data-w/data-h）
      const verdict = sizeLooksLikeContent(
        parseInt(node.getAttribute("width") || node.getAttribute("data-w") || "0", 10),
        parseInt(node.getAttribute("height") || node.getAttribute("data-h") || "0", 10)
      );
      if (verdict !== null) return verdict;

      return true;   // 什么尺寸信息都没有 → 放行，宁可多抓不可漏
    }

    // ─────────────────────── 懒加载图片：取真实地址 ───────────────────────
    //
    // 微信公众号文章的正文图 src 要么整个不写，要么在滚动触发懒加载后被自己的
    // 脚本换成 1×1 占位符；真实地址一直都在 data-src 里（实测：抓包 3 篇公众号
    // 文章原始 HTML，27 张正文图 26 张没有 src 属性，全部只有 data-src）。
    // data-original / data-lazy-src / data-actualsrc 是同一套模式在其它站点的常见变体。
    //
    // ⚠️ 不能无脑优先 data-src —— 有些站点反过来，data-src 是低清占位、src 才是原图。
    // 所以只在 src 缺失或明显是占位符（空 / data: 内联）时才回落，src 有效就直接用。
    // 实测 Wikipedia / MDN 页面的 <img> 完全不带 data-src，这条回落对它们不生效。
    const LAZY_SRC_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-actualsrc"];
    function pickImgSrc(node) {
      const src = node.getAttribute("src") || "";
      if (src && !src.startsWith("data:")) return src;
      for (const attr of LAZY_SRC_ATTRS) {
        const v = node.getAttribute(attr);
        if (v) return v;
      }
      return src;
    }

    // ── 表格 ──
    //
    // Turndown **默认不带表格规则**，每个单元格会变成一个独立的块 →
    // 32 行 × 5 列的专辑列表被拆成 160 个碎片段落，行列对应关系全丢。
    // （实测维基「陳昇」条目：15 张 wikitable、526 个单元格，全糊了。）
    //
    // 用**另一个** TurndownService 实例来转单元格内容，不复用主实例：
    //   1. 避免在 replacement 里递归调用自己
    //   2. 这个实例没有表格规则，所以嵌套表格会自然退化成文字，不会无限套娃
    const tdCell = new TurndownService({
      headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*",
    });

    function cellToMd(cell) {
      let s = "";
      try { s = tdCell.turndown(cell.innerHTML || ""); }
      catch (e) { s = cell.textContent || ""; }
      // 表格里的竖线必须转义，否则会把这一格劈成两格
      s = s.replace(/\|/g, "\\|").trim();
      // ⚠️ Markdown 表格一格只能占一行 —— 单元格里的换行/列表统一压成 <br>。
      //    实测这页有 103 个单元格含列表或多段；压成空格会糊成一句，用 <br> 能保住结构。
      //    .md 文件里出现少量 HTML 标签是 Markdown 的常规做法。
      s = s.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).join("<br>").replace(/\n+/g, "<br>");
      return s || " ";
    }

    function tableToMd(table) {
      // 跳过默认折叠的内容（和信息框那边保持同一个决定）
      const t = table.cloneNode(true);
      t.querySelectorAll(".mw-collapsed, .mw-collapsible-content").forEach((n) => n.remove());

      const rows = [...t.querySelectorAll("tr")].filter((tr) => tr.children.length);
      if (!rows.length) return "";

      const grid = rows.map((tr) => [...tr.children].map(cellToMd));
      const width = Math.max(...grid.map((r) => r.length));
      grid.forEach((r) => { while (r.length < width) r.push(" "); });

      // 有 <th> 的第一行当表头；没有就补一行空表头 —— GFM 表格语法要求必须有表头行
      const firstIsHead = [...rows[0].children].some((c) => c.tagName === "TH");
      const head = firstIsHead ? grid.shift() : new Array(width).fill(" ");
      if (!grid.length) return "";

      const line = (cells) => "| " + cells.join(" | ") + " |";
      const cap = t.querySelector("caption");
      const capMd = cap && cap.textContent.trim() ? "**" + cap.textContent.trim() + "**\n\n" : "";
      return capMd + [line(head), "|" + " --- |".repeat(width), ...grid.map(line)].join("\n");
    }

    td.addRule("tables", {
      filter: (node) => node.nodeName === "TABLE",
      replacement: (content, node) => {
        const md = tableToMd(node);
        return md ? "\n\n" + md + "\n\n" : "";
      },
    });

    const images = [];
    tdCell.addRule("cellImages", {
      filter: "img",
      replacement: function (content, node) {
        const raw = pickImgSrc(node);
        if (!raw || raw.startsWith("data:")) return "";
        const u = absUrl(raw);
        if (!isContentImage(node, u)) return "";
        if (!images.includes(u)) images.push(u);
        return "![](" + u + ")";
      },
    });
    td.addRule("collectImages", {
      filter: "img",
      replacement: function (content, node) {
        const raw = pickImgSrc(node);
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

    // ── 去掉脚注标记 ──
    //
    // 维基正文里密布 [\[1\]](#cite_note-1) 这种脚注角标，参考文献那节里还有
    // [^](#cite_ref-1 "跳转") 的回跳箭头。在**离线的单文件**里它们毫无用处：
    // 跳转目标不存在（导出的 HTML 里没有对应的 id），点了原地不动。
    //
    // 而且它们本来也解析不出来 —— INLINE_RE 的链接分支写死了 https?://，
    // 匹配不上 # 开头的锚点，于是整条以**原始 Markdown 语法**露在正文里
    // （实测陳昇那页露出 62 处）。
    //
    // 决定（2026-08-18）：**直接删掉**。想看出处点正文里的原文链接即可。
    // 参考文献那一节**保留**，编号顺序和原文一致，需要查照样对得上。
    //
    // ⚠️ 只删 href 里含 cite/note/ref/fn 的锚点，别误伤正常的站内跳转。
    // 标记的文字形态太多，枚举不完 —— 实测就有四种：
    //     [\[1\]]            正文角标
    //     [^]                回跳箭头
    //     [**6.1**]          一源多引的回跳（加粗 + 小数点）
    //     [跳转到： **6.0**]  带中文前缀的回跳
    // 所以**安全阀放在 href 上**（只认 cite/note/ref/fn 锚点），文字部分放宽：
    // 要么是 [\[数字\]] 那种带转义方括号的，要么是一段不含方括号的短文字。
    body = body.replace(
      /\[(?:\\\[[^\]]{0,10}\\\]|[^\[\]]{0,30})\]\(#[^)]*(?:cite|note|ref|fn)[^)]*\)/gi,
      ""
    );

    // ── 维基信息框作为附录接在文末 ──
    // 图片走和正文完全相同的过滤与收集逻辑，所以内嵌导出时会一并带上
    if (wikiBox) {
      const appendix = renderWikiInfobox(wikiBox, (node) => {
        const raw = pickImgSrc(node);
        if (!raw || raw.startsWith("data:")) return "";
        const u = absUrl(raw);
        if (!isContentImage(node, u)) return "";
        if (!images.includes(u)) images.push(u);
        return "![](" + u + ")";
      });
      if (appendix) body = body.replace(/\s+$/, "") + "\n" + appendix;
    }

    // ── 微信长图兜底：主提取一张图都没抓到，才去分享轮播里摸 ──
    // 图放在正文最前面（跟着来源行），不是文末附录——它就是这篇的正文，不是附加信息。
    if (images.length === 0 && wechatSwiperImgs.length) {
      const swiperMd = [];
      wechatSwiperImgs.forEach((node) => {
        const raw = pickImgSrc(node);
        if (!raw || raw.startsWith("data:")) return;
        const u = absUrl(raw);
        if (!isContentImage(node, u)) return;
        if (images.includes(u)) return;
        images.push(u);
        swiperMd.push(`![](${u})`);
      });
      if (swiperMd.length) body = swiperMd.join("\n\n") + "\n\n" + body;
    }

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
