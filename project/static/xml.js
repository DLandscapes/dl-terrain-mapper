// @ts-check
// A SMALL XML READER — enough for a QGIS style file and no more.
//
// ⚠️ WRITTEN RATHER THAN BORROWED, FOR THE SAME REASON AS THE TIFF AND EXIF
// READERS. The browser has DOMParser; Node does not, and the whole test suite
// runs in Node. A parser that only exists in the page is a parser whose
// behaviour is asserted by nobody, and this one decides what a laser will do.
// It is about 120 lines because the input is machine-generated XML from one
// program, not the format in general.
//
// ⚠️ WHAT IT DELIBERATELY DOES NOT DO: namespaces beyond stripping the prefix,
// DTD resolution, entity declarations, processing instructions, mixed content
// with meaningful whitespace. A QML or an SLD needs none of them. If a file
// arrives that does, this returns a tree that is missing something rather than
// a tree that is wrong — and `readQGISStyle` reports what it could not find.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Resolve the five named entities and numeric ones. */
function unescape(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/**
 * @typedef {object} XNode
 * @property {string} name       the tag, with any namespace prefix stripped
 * @property {Record<string,string>} attrs
 * @property {XNode[]} children
 * @property {string} text       direct text content, trimmed
 */

/**
 * Parse a document into a tree.
 *
 * @param {string} src
 * @returns {XNode} the root element
 */
export function parseXML(src) {
  let i = 0;
  const n = src.length;
  /** @type {XNode[]} */
  const stack = [];
  /** @type {XNode|null} */
  let root = null;

  const mk = (name) => ({ name, attrs: {}, children: [], text: "" });

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    // text before this tag belongs to the open element
    if (lt > i && stack.length) {
      const t = src.slice(i, lt).trim();
      if (t) stack[stack.length - 1].text += unescape(t);
    }
    // ⚠️ COMMENTS, DECLARATIONS AND DOCTYPES ARE SKIPPED WHOLE. A DOCTYPE can
    // contain a bracketed internal subset with '>' inside it, so it cannot be
    // scanned for the next '>' the way an ordinary tag can — QGIS writes
    // <!DOCTYPE qgis PUBLIC '...' 'SYSTEM'> at the top of every QML.
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      let j = lt + 2, depth = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    // closing tag
    if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      if (end < 0) break;
      stack.pop();
      i = end + 1;
      continue;
    }
    // opening tag
    const end = findTagEnd(src, lt);
    if (end < 0) break;
    const raw = src.slice(lt + 1, end);
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const sp = body.search(/[\s]/);
    const rawName = (sp < 0 ? body : body.slice(0, sp)).trim();
    // ⚠️ THE NAMESPACE PREFIX IS DROPPED. An SLD is <se:LineSymbolizer> in one
    // export and <sld:LineSymbolizer> in another, from the same program; the
    // local name is the only part that is stable.
    const name = rawName.includes(":") ? rawName.slice(rawName.indexOf(":") + 1) : rawName;
    const node = mk(name);
    if (sp >= 0) readAttrs(body.slice(sp), node.attrs);

    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (!root) root = node;
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }
  return root || mk("");
}

/** The '>' that closes a tag, skipping any inside quoted attribute values. */
function findTagEnd(src, from) {
  let i = from + 1, quote = "";
  while (i < src.length) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = ""; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
    i++;
  }
  return -1;
}

function readAttrs(s, out) {
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) {
    const key = m[1].includes(":") ? m[1].slice(m[1].indexOf(":") + 1) : m[1];
    out[key] = unescape(m[3] !== undefined ? m[3] : m[4]);
  }
}

// ── walking ────────────────────────────────────────────────────────────────

/** Every descendant with this tag name, in document order. */
export function findAll(node, name, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** The first descendant with this tag name, or null. */
export function find(node, name) {
  return findAll(node, name)[0] || null;
}

/**
 * QGIS writes symbol properties two ways depending on its version, and a
 * reader that knows only one silently returns an empty style.
 *
 *   3.20 and later:  <Option type="QString" name="line_color" value="..."/>
 *   before that:     <prop k="line_color" v="..."/>
 *
 * ⚠️ BOTH ARE STILL IN THE WILD, because a QML saved years ago still loads in
 * current QGIS and people keep their style libraries for a long time.
 * @param {XNode} node @returns {Record<string,string>}
 */
export function readProps(node) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const p of findAll(node, "prop")) {
    if (p.attrs.k !== undefined) out[p.attrs.k] = p.attrs.v ?? "";
  }
  for (const o of findAll(node, "Option")) {
    if (o.attrs.name !== undefined && o.attrs.value !== undefined) out[o.attrs.name] = o.attrs.value;
  }
  return out;
}
