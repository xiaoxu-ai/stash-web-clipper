// docx.js — 把提取到的 Markdown + 图片字节，手搓成一个「图片已内嵌」的 .docx。
// docx 本质是 OOXML 的 zip 包：图片以二进制存在包内（不是远程链接），
// 因此腾讯文档「导入」后图片能跟着进去。本文件不依赖任何外部库。

// ---------- ZIP（store 存储，无压缩）----------
const _CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function _concat(arrs) {
  let len = 0; arrs.forEach((a) => (len += a.length));
  const out = new Uint8Array(len); let o = 0;
  arrs.forEach((a) => { out.set(a, o); o += a.length; });
  return out;
}
const _u16 = (n) => new Uint8Array([n & 255, (n >> 8) & 255]);
const _u32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

function zipStore(files) {
  const enc = new TextEncoder();
  const locals = []; const central = []; let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const local = _concat([
      _u32(0x04034b50), _u16(20), _u16(0), _u16(0), _u16(0), _u16(0),
      _u32(crc), _u32(data.length), _u32(data.length), _u16(nameBytes.length), _u16(0),
      nameBytes, data,
    ]);
    locals.push(local);
    central.push(_concat([
      _u32(0x02014b50), _u16(20), _u16(20), _u16(0), _u16(0), _u16(0), _u16(0),
      _u32(crc), _u32(data.length), _u32(data.length), _u16(nameBytes.length),
      _u16(0), _u16(0), _u16(0), _u16(0), _u32(0), _u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const centralData = _concat(central);
  const end = _concat([
    _u32(0x06054b50), _u16(0), _u16(0), _u16(files.length), _u16(files.length),
    _u32(centralData.length), _u32(offset), _u16(0),
  ]);
  return _concat([_concat(locals), centralData, end]);
}

// ---------- 图片像素尺寸（用于排版）----------
function _pngSize(d) {
  return { w: (d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19],
           h: (d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23] };
}
function _jpgSize(d) {
  let i = 2;
  while (i < d.length) {
    if (d[i] !== 0xFF) { i++; continue; }
    const m = d[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: (d[i + 5] << 8) | d[i + 6], w: (d[i + 7] << 8) | d[i + 8] };
    }
    i += 2 + ((d[i + 2] << 8) | d[i + 3]);
  }
  return { w: 800, h: 600 };
}
function imgSize(d) {
  return (d[0] === 0x89 && d[1] === 0x50) ? _pngSize(d) : _jpgSize(d);
}

// ---------- Markdown → 块 ----------
function xmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function parseBlocks(md) {
  const lines = md.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.trim().startsWith("```")) {
      const code = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i++; }
      i++;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    let m;
    const img = line.match(/^!\[\]\((.+)\)\s*$/);
    if (img) { blocks.push({ type: "image", url: img[1] }); i++; continue; }
    if (line.trim() === "---") { blocks.push({ type: "hr" }); i++; continue; }
    if ((m = line.match(/^##\s+(.*)/))) { blocks.push({ type: "h2", text: m[1] }); i++; continue; }
    if ((m = line.match(/^#\s+(.*)/))) { blocks.push({ type: "h1", text: m[1] }); i++; continue; }
    if ((m = line.match(/^>\s?(.*)/))) { blocks.push({ type: "quote", text: m[1] }); i++; continue; }
    blocks.push({ type: "p", text: line }); i++;
  }
  return blocks;
}
// 行内：去链接语法、拆粗体
function inlineRuns(text) {
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  const runs = []; const re = /\*\*([^*]+)\*\*/g; let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false });
  return runs.length ? runs : [{ text: "", bold: false }];
}

// ---------- OOXML 段落 ----------
function _para(runs, opts) {
  opts = opts || {};
  const rlist = runs.map((r) => {
    const rpr = [];
    if (r.bold || opts.bold) rpr.push("<w:b/>");
    if (opts.italic) rpr.push("<w:i/>");
    if (opts.color) rpr.push(`<w:color w:val="${opts.color}"/>`);
    if (opts.sz) rpr.push(`<w:sz w:val="${opts.sz}"/><w:szCs w:val="${opts.sz}"/>`);
    if (opts.mono) rpr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
    const rprx = rpr.length ? `<w:rPr>${rpr.join("")}</w:rPr>` : "";
    return `<w:r>${rprx}<w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`;
  }).join("");
  const ppr = [];
  if (opts.before != null || opts.after != null)
    ppr.push(`<w:spacing w:before="${opts.before || 0}" w:after="${opts.after || 0}"/>`);
  if (opts.center) ppr.push('<w:jc w:val="center"/>');
  if (opts.indent) ppr.push('<w:ind w:left="360"/>');
  const pprx = ppr.length ? `<w:pPr>${ppr.join("")}</w:pPr>` : "";
  return `<w:p>${pprx}${rlist}</w:p>`;
}
function _hr() {
  return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>';
}
function _code(text) {
  const runs = text.split("\n").map((l, i) =>
    (i > 0 ? "<w:r><w:br/></w:r>" : "") +
    `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${xmlEsc(l)}</w:t></w:r>`
  ).join("");
  return `<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:ind w:left="120"/></w:pPr>${runs}</w:p>`;
}
function _image(rId, cx, cy, id) {
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="img${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="img${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

// ---------- 组装 docx ----------
// media: [{name:'image1.jpg', data:Uint8Array, rId, dim:{w,h}}]，按 url 映射
// 返回 Uint8Array
function buildDocxBytes(markdown, urlToMedia) {
  const enc = new TextEncoder();
  const blocks = parseBlocks(markdown);
  const MAXW = 5486400; // 6 英寸(EMU)
  let body = ""; let idc = 1; let seenTitle = false;
  for (const b of blocks) {
    if (b.type === "image") {
      const info = urlToMedia.get(b.url);
      if (!info) continue;
      let cx = Math.round((info.dim.w || 800) * 9525);
      let cy = Math.round((info.dim.h || 600) * 9525);
      if (cx > MAXW) { cy = Math.round(cy * MAXW / cx); cx = MAXW; }
      body += _image(info.rId, cx, cy, idc++);
    } else if (b.type === "hr") body += _hr();
    else if (b.type === "code") body += _code(b.text);
    else if (b.type === "h1") {
      if (!seenTitle) { // 文章大标题：更大、居中
        seenTitle = true;
        body += _para(inlineRuns(b.text), { bold: true, sz: 44, center: true, after: 240 });
      } else { // 章节标题
        body += _para(inlineRuns(b.text), { bold: true, sz: 34, before: 320, after: 120 });
      }
    }
    else if (b.type === "h2") body += _para(inlineRuns(b.text), { bold: true, sz: 28, before: 240, after: 100 });
    else if (b.type === "quote") body += _para(inlineRuns(b.text), { italic: true, color: "888888", sz: 20, indent: true, after: 120 });
    else body += _para(inlineRuns(b.text), { after: 120 });
  }

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  // 全局默认样式：中文字体 + 1.5 倍行距 + 段后距（让导入后不至于太丑）
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:docDefaults><w:rPrDefault><w:rPr>" +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑" w:cs="微软雅黑"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto" w:after="120"/></w:pPr></w:pPrDefault>' +
    "</w:docDefaults></w:styles>";

  const rels = [...urlToMedia.values()].map((v) =>
    `<Relationship Id="${v.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${v.name}"/>`
  ).join("");
  const docRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    rels + "</Relationships>";

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    "</Types>";

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";

  const files = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "word/document.xml", data: enc.encode(document) },
    { name: "word/styles.xml", data: enc.encode(styles) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(docRels) },
  ];
  for (const v of urlToMedia.values()) files.push({ name: `word/media/${v.name}`, data: v.data });
  return zipStore(files);
}
