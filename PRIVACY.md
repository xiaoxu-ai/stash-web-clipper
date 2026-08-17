# 隐私政策 · Privacy Policy

**「文章打包 / Stash」浏览器扩展**

最后更新：2026-08-17

---

## 中文

### 一句话

**本扩展不收集、不存储、不传输任何用户数据。开发者没有服务器，也收不到任何东西。**

### 具体说明

#### 我们不做的事

- ❌ 不收集个人信息（姓名、邮箱、账号、位置等一概没有）
- ❌ 不收集浏览记录、不记录你访问过哪些网站
- ❌ 没有任何统计、埋点、遥测或崩溃上报
- ❌ 不向开发者或任何第三方服务器发送数据 —— **开发者根本没有服务器**
- ❌ 不投放广告，不做用户画像

#### 扩展实际会碰到的数据，以及它去了哪里

| 数据 | 何时产生 | 去了哪里 |
|---|---|---|
| **当前网页的正文和图片地址** | **只在你点击扩展图标并主动触发提取时** | 留在你的浏览器内存里 |
| **提取结果**（正文 Markdown） | 提取完成后 | 存入 `chrome.storage.session`，**关闭浏览器即自动清除**；也可被你手动清除 |
| **生成的 .md / .html 文件和图片** | 你点击下载时 | **只存到你自己电脑的下载文件夹** |

#### ⚠️ 一件需要你知道的事：图片会直接从原网站下载

为了把图片嵌进导出的文件，扩展会**直接向图片所在的服务器发起下载请求**
（例如维基百科的图床、`pbs.twimg.com` 等）。

这意味着：**那些图片服务器会看到你的 IP 地址和浏览器标识**，
就跟你在浏览器里正常打开那张图片时一样。

这些请求**不经过开发者的任何服务器**，开发者看不到、也无法记录。
但这些第三方网站有它们自己的隐私政策，不受本扩展控制。

#### 权限说明

| 权限 | 为什么需要 |
|---|---|
| `activeTab` + `scripting` | **只在你点击扩展图标时**，向当前这一个标签页注入提取脚本。不常驻、不监听其它标签页 |
| `downloads` | 把生成的文件保存到你的下载文件夹 |
| `storage` | 暂存提取结果（会话级，关浏览器即清） |
| `offscreen` | 生成大文件下载所需的临时链接（技术限制，MV3 后台无法直接生成） |
| `clipboardWrite` | 你主动点击"复制"时使用 |
| 网站访问权限 | **不常驻**。仅在你对某个网站主动触发提取、需要下载该站图片时，按域名精确申请 |

#### 儿童隐私

本扩展不面向儿童，也不会有意收集任何人的信息（因为它谁的信息都不收集）。

#### 变更

本政策如有变更，会更新本文件顶部的日期并在扩展的版本更新说明中注明。

#### 联系

通过项目仓库的 Issues 联系。

---

## English

### In one sentence

**This extension collects, stores, and transmits no user data whatsoever.
The developer operates no server and receives nothing.**

### What we do NOT do

- ❌ No collection of personal information of any kind
- ❌ No browsing history, no record of which sites you visit
- ❌ No analytics, telemetry, or crash reporting
- ❌ No data sent to the developer or any third-party server — **the developer has no server**
- ❌ No advertising, no profiling

### Data the extension touches, and where it goes

| Data | When | Where it goes |
|---|---|---|
| **Article text and image URLs of the current page** | **Only when you click the extension icon and trigger extraction** | Stays in your browser's memory |
| **Extraction result** (article Markdown) | After extraction | Stored in `chrome.storage.session`, **automatically cleared when you close the browser** |
| **Generated .md / .html files and images** | When you click download | **Only to your own computer's Downloads folder** |

### ⚠️ One thing you should know: images are fetched directly from their original hosts

To embed images into the exported file, the extension fetches them **directly from the
servers hosting them** (e.g. Wikipedia's image servers, `pbs.twimg.com`).

This means **those image servers will see your IP address and user agent** — exactly as they
would if you opened the image in your browser normally.

These requests **do not pass through any server operated by the developer**, who cannot see
or log them. Those third-party sites have their own privacy policies, outside our control.

### Permissions

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | Injects the extraction script into the current tab **only when you click the icon**. Not persistent; does not observe other tabs |
| `downloads` | Saves the generated file to your Downloads folder |
| `storage` | Temporarily holds the extraction result (session-scoped; cleared on browser close) |
| `offscreen` | Creates the temporary URL needed for large-file downloads (an MV3 service-worker limitation) |
| `clipboardWrite` | Used only when you click "copy" |
| Host permissions | **Not persistent.** Requested per-domain only when you actively trigger extraction on a site and its images must be fetched |

### Children's privacy

This extension is not directed at children and does not knowingly collect information from
anyone — because it collects information from no one.

### Changes

Any change will be reflected in the date at the top of this file and noted in the
extension's release notes.

### Contact

Via the Issues page of the project repository.
