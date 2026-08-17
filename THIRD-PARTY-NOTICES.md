# 第三方组件声明 / Third-Party Notices

「文章打包 / Stash」在 `extension/vendor/` 下打包了两个第三方库。
它们各自的授权如下，**分发本插件时必须一并保留本文件**。

---

## 1. Readability.js

| | |
|---|---|
| **来源** | Mozilla — <https://github.com/mozilla/readability> |
| **原始出处** | arc90 Readability（2009） |
| **文件** | `extension/vendor/Readability.js` |
| **授权** | **Apache License 2.0** |
| **版权** | Copyright (c) 2010 Arc90 Inc |
| **许可证全文** | [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt) |
| **用途** | 把任意网页剥成干净正文（浏览器「阅读模式」用的就是这套算法） |

> 原文件头部已包含 Apache-2.0 声明，未作改动。

**Apache-2.0 的义务**（本项目已履行）：
- ✅ 保留原文件中的版权、专利、商标和归属声明
- ✅ 随分发附上许可证全文（见上表链接）
- ✅ 如有修改需注明 —— **本项目未修改该文件**

---

## 2. Turndown

| | |
|---|---|
| **来源** | <https://github.com/mixmark-io/turndown> |
| **文件** | `extension/vendor/turndown.js` |
| **授权** | **MIT License** |
| **版权** | Copyright (c) 2017 Dom Christie |
| **用途** | 把 Readability 输出的 HTML 转成 Markdown |

> ⚠️ **2026-08-17 补正**：本项目当初取用的构建产物**缺少 turndown 自身的版权头**
> （文件里那段 MIT 是它打包进来的依赖 collapse-whitespace 的，不是 turndown 的）。
> 已按 MIT 要求补回文件头部。

### MIT License 全文

```
MIT License

Copyright (c) 2017 Dom Christie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 2.1 collapse-whitespace（turndown 内嵌的依赖）

`turndown.js` 内部还含有一段独立的 MIT 声明：

| | |
|---|---|
| **版权** | Copyright (c) 2014 Luc Thevenard \<lucthevenard@gmail.com\> |
| **授权** | MIT（全文见 `turndown.js` 文件内） |

---

## 一句话总结

两个库的授权都**允许免费商用、允许打包进闭源产品**，
唯一义务是**保留版权声明**（本文件 + 两个源文件的头部注释）。

**⚠️ 别删 `extension/vendor/` 里两个文件头部的注释块，也别删本文件。**
