<div align="center">

<img src="extension/icons/icon128.png" width="88" alt="">

# Stash · 文章打包

**Strip the ads and nav, save the article — text and images, in one clean file.**

Outputs Markdown + images, or a single-file HTML with every image embedded inline.

[中文](README.md) · English

</div>

---

## What it does

You find a good article and want to keep it — bookmarks rot, and "Save Page As" drags along
every ad and nav bar on the page.

This extension does one thing: **strip the article body, bundle it with its images into one
clean file, and save it to your own computer.**

```
Any article page → click the extension icon → Extract → download Markdown or HTML
```

The popup can be closed any time; the job keeps running in the background.

## Two output formats

| | |
|---|---|
| **Markdown + images** | Images go in their own folder, referenced by relative path. Drag straight into Obsidian / Logseq |
| **Single-file HTML** | Every image embedded as base64 — **zero external dependencies**. Opens offline, opens in ten years, never missing an image when you send it to someone |

## What it looks like

<img src="store-assets/screenshot-1-extract.png" width="100%" alt="Click the extension icon on an article page to extract it">

<img src="store-assets/screenshot-2-html.png" width="100%" alt="Single-file HTML with every image embedded">

<img src="store-assets/screenshot-3-markdown.png" width="100%" alt="Markdown + images, ready to drop into Obsidian">

## Where it works

Pretty much any article-shaped page: news, blogs, Wikipedia, personal sites, long forum posts.
Article detection uses the same algorithm as your browser's built-in reader mode
(Mozilla **Readability**).

**X (Twitter) long-form posts get dedicated handling** — it understands the DraftJS editor
structure, quoted tweets embedded in the body, and code blocks, instead of falling back to a
generic extractor that mangles them.

### Known rough edges

- Pages that require login to show their content
- Pages whose content loads asynchronously via JavaScript
- Content embedded inside an iframe

## Privacy

**This extension has no server.** It collects no data, has no analytics, no tracking, and
uploads nothing anywhere. Extraction results live only in the browser session (cleared when
the browser closes); the file it generates goes straight to your own Downloads folder.

The only network request that ever leaves your machine is **fetching images directly from
the source site** — no different from opening that image in your browser.

→ Full details in [`PRIVACY.md`](PRIVACY.md)

## Install

Not yet on the Chrome Web Store. Load it in developer mode:

1. Download this repo, unzip it into a **permanent location you won't delete**
2. Open `chrome://extensions`, enable "Developer mode" in the top right
3. Click "Load unpacked", select the `extension/` folder

> ⚠️ Deleting that folder removes the extension.

Detailed usage and FAQ: [`extension/使用说明.md`](extension/使用说明.md) (Chinese only for now).

## License

This project is **[MIT licensed](LICENSE)** — use it, modify it, ship it commercially,
the only requirement is keeping the copyright notice.

## Third-party components

| Library | License | Purpose |
|---|---|---|
| [Readability.js](https://github.com/mozilla/readability) | Apache-2.0 | Strips a webpage down to clean article content |
| [Turndown](https://github.com/mixmark-io/turndown) | MIT | HTML → Markdown conversion |

→ Full notices in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)

## Layout

```
extension/          The extension itself (this is all you need to package for the store)
  vendor/           Readability.js + turndown.js (runtime dependencies, don't remove)
  icons/            Icon source files and build script (build.sh --list shows all variants)
store-assets/       Store screenshots (also used in this README)
licenses/           Full text of third-party licenses
```

---
