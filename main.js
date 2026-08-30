const { Plugin, editorLivePreviewField } = require("obsidian");
const { StateField } = require("@codemirror/state");
const {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} = require("@codemirror/view");

const NOTE_START = /^\{%\s*note(?:\s+([^\s%]+))?\s*%\}\s*$/i;
const NOTE_END = /^\{%\s*(?:endnote|end\s+note)\s*%\}\s*$/i;
const FOLD_START = /^\{%\s*fold(?:\s+(.+?))?\s*%\}\s*$/i;
const FOLD_END = /^\{%\s*(?:endfold|end\s+fold)\s*%\}\s*$/i;
const RAW_START = /^\{%\s*raw\s*%\}\s*$/i;
const RAW_END = /^\{%\s*endraw\s*%\}\s*$/i;
const BLOCK_MARKER = /\{%\s*[^{}\r\n]*?%\}/gi;
const FENCE_START = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_END = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const READING_MARKER_SKIP = "pre, code, script, style";
const READING_DOCUMENT_CACHE_LIMIT = 16;

const BLOCK_TYPES = [
  "primary",
  "info",
  "success",
  "warning",
  "danger",
  "secondary",
  "light",
];
const BLOCK_TYPE_SET = new Set(BLOCK_TYPES);
const BLOCK_TYPE_CLASSES = BLOCK_TYPES.map((type) => `hexo-note-${type}`);
const BLOCK_PARENT_CLASSES = BLOCK_TYPES.map(
  (type) => `hexo-block-parent-${type}`,
);

function normalizeText(text) {
  return text.replace(/\u00a0/g, " ");
}

function normalizeType(rawType, fallback) {
  const type = (rawType || fallback).toLowerCase();

  // Keep compatibility with the existing typo in this vault.
  if (type === "seconary") return "secondary";
  if (type === "default") return fallback;
  return BLOCK_TYPE_SET.has(type) ? type : fallback;
}

function isKnownType(rawType) {
  if (!rawType) return false;
  const type = rawType.toLowerCase();
  return type === "default" || type === "seconary" || BLOCK_TYPE_SET.has(type);
}

function parseFoldArguments(rawArguments) {
  const source = (rawArguments || "").trim();
  if (!source) return { type: "secondary", label: "详情" };

  const at = source.indexOf("@");
  if (at !== -1) {
    const rawType = source.slice(0, at).trim().split(/\s+/)[0];
    const label = source.slice(at + 1).trim();
    return {
      type: normalizeType(rawType, "secondary"),
      label: label || "详情",
    };
  }

  const [first, ...rest] = source.split(/\s+/);
  if (isKnownType(first)) {
    return {
      type: normalizeType(first, "secondary"),
      label: rest.join(" ").trim() || "详情",
    };
  }

  // Keep the documented no-@ shorthand without treating an English title as a type.
  return { type: "secondary", label: source };
}

function parseBlockStart(text) {
  const source = normalizeText(text);
  const noteMatch = source.match(NOTE_START);
  if (noteMatch) {
    // Fluid renders an omitted/default note class with post.updated.note_class.
    // This vault configures that class as "light".
    const type = normalizeType(noteMatch[1], "light");
    return {
      kind: "note",
      type,
      label: type,
    };
  }

  const foldMatch = source.match(FOLD_START);
  if (foldMatch) {
    const { type, label } = parseFoldArguments(foldMatch[1]);
    return {
      kind: "fold",
      type,
      label,
    };
  }

  return null;
}

function parseMarker(text) {
  const definition = parseBlockStart(text);
  if (definition) return { position: "start", definition };

  const kind = parseBlockEnd(text);
  return kind ? { position: "end", kind } : null;
}

function markerKey(marker) {
  if (!marker) return "";
  if (marker.position === "end") return `end:${marker.kind}`;
  const { kind, type, label } = marker.definition;
  return `start:${kind}:${type}:${label}`;
}

function parseBlockEnd(text) {
  const source = normalizeText(text);
  if (NOTE_END.test(source)) return "note";
  if (FOLD_END.test(source)) return "fold";
  return null;
}

function findBlockMarkers(text, requireOwnLine = true) {
  const markers = [];
  const pattern = new RegExp(BLOCK_MARKER.source, BLOCK_MARKER.flags);
  let match;

  while ((match = pattern.exec(text))) {
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const nextLine = text.indexOf("\n", pattern.lastIndex);
    const lineEnd = nextLine === -1 ? text.length : nextLine;
    const isOwnLine =
      !text.slice(lineStart, match.index).trim() &&
      !text.slice(pattern.lastIndex, lineEnd).trim();

    if (requireOwnLine && !isOwnLine) continue;
    const marker = parseMarker(match[0]);
    if (!marker) continue;

    markers.push({
      from: match.index,
      to: pattern.lastIndex,
      text: match[0],
      marker,
    });
  }

  return markers;
}

function textPointAt(element, offset) {
  const view = element.ownerDocument.defaultView;
  const walker = element.ownerDocument.createTreeWalker(
    element,
    view.NodeFilter.SHOW_TEXT,
  );
  let node;
  let last = null;

  while ((node = walker.nextNode())) {
    last = node;
    const length = node.nodeValue.length;
    if (offset <= length) return { node, offset };
    offset -= length;
  }

  return last
    ? { node: last, offset: last.nodeValue.length }
    : { node: element, offset: 0 };
}

function deleteTextRange(element, from, to) {
  if (from >= to) return;

  const start = textPointAt(element, from);
  const end = textPointAt(element, to);
  const range = element.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  range.deleteContents();
}

function removeBoundaryBreak(element, fromStart) {
  const view = element.ownerDocument.defaultView;
  const walker = element.ownerDocument.createTreeWalker(
    element,
    view.NodeFilter.SHOW_ELEMENT | view.NodeFilter.SHOW_TEXT,
  );
  let candidate = null;
  let node;

  while ((node = walker.nextNode())) {
    const isText = node.nodeType === 3;
    const isContent = isText
      ? Boolean(node.nodeValue.trim())
      : node.tagName === "BR" || node.childNodes.length === 0;
    if (!isContent) continue;

    candidate = node;
    if (fromStart) break;
  }

  if (candidate && candidate.nodeType === 1 && candidate.tagName === "BR") {
    candidate.remove();
  }
}

function cloneReadingUnitSegment(unit, from, to) {
  const clone = unit.cloneNode(true);
  const length = (clone.textContent || "").length;
  deleteTextRange(clone, to, length);
  deleteTextRange(clone, 0, from);
  if (from > 0) removeBoundaryBreak(clone, true);
  if (to < length) removeBoundaryBreak(clone, false);
  if (!normalizeText(clone.textContent || "").trim()) return null;

  clone.removeAttribute("id");
  return clone;
}

function markerInsideSkippedElement(root, marker) {
  const offset = marker.from + Math.floor((marker.to - marker.from) / 2);
  const point = textPointAt(root, offset);
  const markerElement =
    point.node.nodeType === 1 ? point.node : point.node.parentElement;
  return Boolean(
    markerElement && markerElement.closest(READING_MARKER_SKIP),
  );
}

function paragraphForReadingUnit(unit) {
  if (unit.matches("p")) return unit;
  if (
    unit.classList.contains("el-p") &&
    unit.children.length === 1 &&
    unit.firstElementChild.matches("p")
  ) {
    return unit.firstElementChild;
  }
  return null;
}

function prepareReadingMarkers(container, expectedMarkers) {
  let expectedIndex = 0;
  const matchExpected = (candidate) => {
    if (!expectedMarkers) return candidate;
    const expected = expectedMarkers[expectedIndex];
    if (!expected || markerKey(expected.marker) !== markerKey(candidate)) {
      return null;
    }
    expectedIndex += 1;
    return expected.marker;
  };

  for (const unit of Array.from(container.children)) {
    if (!unit.parentNode || unit.closest(".hexo-block-reading-segment")) {
      continue;
    }

    // Without source positions, keep the conservative top-level-only fallback.
    // Source-backed sections can safely recover markers nested by Markdown in
    // structures such as a list whose closing tag has no preceding blank line.
    if (!expectedMarkers && !paragraphForReadingUnit(unit)) continue;

    const text = unit.textContent || "";
    const markers = findBlockMarkers(text, !expectedMarkers)
      .filter((marker) => !markerInsideSkippedElement(unit, marker))
      .map((marker) => ({ ...marker, resolved: matchExpected(marker.marker) }))
      .filter((marker) => marker.resolved);
    if (markers.length === 0) continue;

    const output = [];
    let cursor = 0;
    for (const marker of markers) {
      const segment = cloneReadingUnitSegment(unit, cursor, marker.from);
      if (segment) output.push(segment);

      const markerUnit = unit.ownerDocument.createElement("div");
      markerUnit.textContent = marker.text;
      markerUnit.__hexoMarker = marker.resolved;
      markerUnit.classList.add("hexo-block-reading-marker");
      output.push(markerUnit);
      cursor = marker.to;
    }

    const segment = cloneReadingUnitSegment(unit, cursor, text.length);
    if (segment) output.push(segment);
    unit.replaceWith(...output);
  }
}

function isProtectedSourceLine(line, lineNumber, state) {
  const source = lineNumber === 0 ? line.replace(/^\uFEFF/, "") : line;

  if (lineNumber === 0 && /^---[ \t]*$/.test(source)) {
    state.frontmatter = true;
    return true;
  }
  if (state.frontmatter) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(source)) state.frontmatter = false;
    return true;
  }

  if (state.raw) {
    if (RAW_END.test(source)) state.raw = false;
    return true;
  }

  if (state.fence) {
    const closing = source.match(FENCE_END);
    if (
      closing &&
      closing[1][0] === state.fence.character &&
      closing[1].length >= state.fence.length
    ) {
      state.fence = null;
    }
    return true;
  }

  if (state.htmlLiteral) {
    if (source.toLowerCase().includes(`</${state.htmlLiteral}>`)) {
      state.htmlLiteral = null;
    }
    return true;
  }

  if (state.comment) {
    if (source.includes("-->")) state.comment = false;
    return true;
  }

  const commentStart = source.indexOf("<!--");
  if (commentStart !== -1) {
    if (source.indexOf("-->", commentStart + 4) === -1) state.comment = true;
    return true;
  }

  const fence = source.match(FENCE_START);
  if (fence) {
    state.fence = { character: fence[1][0], length: fence[1].length };
    return true;
  }

  if (RAW_START.test(source)) {
    state.raw = true;
    return true;
  }

  const htmlLiteral = source.match(/^<(pre|code)\b/i);
  if (htmlLiteral) {
    const tag = htmlLiteral[1].toLowerCase();
    if (!source.toLowerCase().includes(`</${tag}>`)) state.htmlLiteral = tag;
    return true;
  }

  return false;
}

function blockLine(definition, hierarchy, position) {
  return {
    definition,
    position,
    depth: hierarchy.length,
    parent: hierarchy[hierarchy.length - 2] || null,
    hierarchy: hierarchy.slice(),
  };
}

function buildReadingDocument(source) {
  const stackBeforeLine = [];
  const lineBlocks = new Map();
  const bodyBlocks = new Map();
  const markers = [];
  const openBlocks = [];
  const protectedState = {
    frontmatter: false,
    raw: false,
    fence: null,
    htmlLiteral: null,
    comment: false,
  };
  const lines = source.split(/\r?\n/);

  const addBodyLine = (lineNumber) => {
    const current = openBlocks[openBlocks.length - 1];
    if (!current) return;
    const info = blockLine(current, openBlocks, "body");
    lineBlocks.set(lineNumber + 1, info);
    bodyBlocks.set(lineNumber + 1, info);
  };

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    stackBeforeLine.push(openBlocks.slice());

    if (isProtectedSourceLine(line, lineNumber, protectedState)) {
      addBodyLine(lineNumber);
      continue;
    }

    const marker = parseMarker(line);
    if (marker && marker.position === "start") {
      openBlocks.push(marker.definition);
      const info = blockLine(marker.definition, openBlocks, "start");
      lineBlocks.set(lineNumber + 1, info);
      markers.push({ line: lineNumber, marker });
      continue;
    }

    const current = openBlocks[openBlocks.length - 1];
    if (
      marker &&
      marker.position === "end" &&
      current &&
      marker.kind === current.kind
    ) {
      const info = blockLine(current, openBlocks, "end");
      lineBlocks.set(lineNumber + 1, info);
      markers.push({ line: lineNumber, marker });
      openBlocks.pop();
      continue;
    }

    addBodyLine(lineNumber);
  }

  return { source, stackBeforeLine, lineBlocks, bodyBlocks, markers };
}

function readingSegmentClasses(definition, stack, position) {
  const parent = stack[stack.length - 2];
  return [
    "hexo-block-reading-segment",
    `hexo-${definition.kind}-reading-segment`,
    `hexo-note-${definition.type}`,
    `hexo-block-reading-depth-${Math.min(stack.length, 2)}`,
    position ? `hexo-block-reading-${position}` : "",
    parent ? `hexo-block-parent-${parent.type}` : "",
  ].filter(Boolean);
}

function createReadingSegment(unit, definition, stack, position) {
  const segment = unit.ownerDocument.createElement("div");
  segment.classList.add(...readingSegmentClasses(definition, stack, position));
  segment.setAttribute("data-hexo-block", definition.kind);
  segment.setAttribute("data-hexo-type", definition.type);

  if (position) {
    segment.classList.add("hexo-block-reading-marker");
    if (position === "start") {
      const title = unit.ownerDocument.createElement("span");
      title.className = `hexo-block-reading-title hexo-${definition.kind}-reading-title`;
      title.textContent = definition.label;
      segment.appendChild(title);
    }
  }

  return segment;
}

function replaceReadingMarker(unit, segment, depth, position) {
  if (depth !== 1) {
    unit.replaceWith(segment);
    return;
  }

  const spacer = unit.ownerDocument.createElement("div");
  spacer.className = "hexo-block-reading-spacer";
  spacer.setAttribute("aria-hidden", "true");

  if (position === "start") {
    unit.replaceWith(spacer, segment);
  } else {
    unit.replaceWith(segment, spacer);
  }
}

function renderReadingSection(element, initialStack, expectedMarkers = null) {
  if (
    Array.from(element.children).some((child) =>
      child.classList.contains("hexo-block-reading-segment"),
    )
  ) {
    return;
  }

  prepareReadingMarkers(element, expectedMarkers);
  const stack = initialStack.slice();
  const units = Array.from(element.children);

  for (const unit of units) {
    const marker = unit.__hexoMarker;
    if (marker && marker.position === "start") {
      const definition = marker.definition;
      stack.push(definition);
      const segment = createReadingSegment(unit, definition, stack, "start");
      replaceReadingMarker(unit, segment, stack.length, "start");
      continue;
    }

    const current = stack[stack.length - 1];
    if (
      marker &&
      marker.position === "end" &&
      current &&
      marker.kind === current.kind
    ) {
      const segment = createReadingSegment(unit, current, stack, "end");
      replaceReadingMarker(unit, segment, stack.length, "end");
      stack.pop();
      continue;
    }

    if (current) {
      const segment = createReadingSegment(unit, current, stack, null);
      unit.replaceWith(segment);
      segment.appendChild(unit);
    }
  }
}

function renderStandaloneReadingBlocks(element) {
  renderReadingSection(element, []);
}

class BlockStartWidget extends WidgetType {
  constructor(definition) {
    super();
    this.kind = definition.kind;
    this.type = definition.type;
    this.label = definition.label;
  }

  eq(other) {
    return (
      other.kind === this.kind &&
      other.type === this.type &&
      other.label === this.label
    );
  }

  toDOM(view) {
    const ownerDocument = view ? view.dom.ownerDocument : document;
    const label = ownerDocument.createElement("span");
    label.className = `hexo-block-live-label hexo-${this.kind}-live-label`;
    label.textContent = this.label;
    if (!this.label) label.setAttribute("aria-hidden", "true");
    return label;
  }

  ignoreEvent() {
    return false;
  }
}

function isLivePreview(state) {
  if (!editorLivePreviewField) return true;
  return state.field(editorLivePreviewField, false) !== false;
}

function hierarchyClasses(depth, parent) {
  const classes = [`hexo-block-live-depth-${Math.min(depth, 2)}`];
  if (parent) classes.push(`hexo-block-parent-${parent.type}`);
  return classes;
}

function liveLineClass(definition, position, hierarchy) {
  const parent = hierarchy[hierarchy.length - 2];
  return [
    "hexo-block-live-line",
    `hexo-block-live-${position}`,
    `hexo-${definition.kind}-live-line`,
    `hexo-note-${definition.type}`,
    ...hierarchyClasses(hierarchy.length, parent),
  ]
    .filter(Boolean)
    .join(" ");
}

function selectedMarkerLines(state, document) {
  const markerLines = new Set(document.markers.map(({ line }) => line + 1));
  const active = new Set();
  for (const range of state.selection.ranges) {
    const lineNumber = state.doc.lineAt(range.head).number;
    if (markerLines.has(lineNumber)) active.add(lineNumber);
  }
  return active;
}

function sameNumberSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function buildBaseEditorDecorations(state, document) {
  const decorations = [];
  for (const [lineNumber, block] of document.lineBlocks) {
    const line = state.doc.line(lineNumber);
    decorations.push(
      Decoration.line({
        attributes: {
          class: liveLineClass(
            block.definition,
            block.position,
            block.hierarchy,
          ),
        },
      }).range(line.from),
    );
  }
  return Decoration.set(decorations, true);
}

function addMarkerEditorDecorations(base, state, document, activeLines) {
  const decorations = [];
  for (const { line: zeroBasedLine, marker } of document.markers) {
    const lineNumber = zeroBasedLine + 1;
    const line = state.doc.line(lineNumber);
    if (activeLines.has(lineNumber)) {
      decorations.push(
        Decoration.line({
          attributes: { class: "hexo-block-live-marker-active" },
        }).range(line.from),
      );
      continue;
    }

    if (marker.position === "start") {
      decorations.push(
        Decoration.replace({
          widget: new BlockStartWidget(marker.definition),
        }).range(line.from, line.to),
      );
    } else {
      decorations.push(Decoration.replace({}).range(line.from, line.to));
    }
  }
  return base.update({ add: decorations, sort: true });
}

function createEditorBlockState(state) {
  const live = isLivePreview(state);
  if (!live) {
    return {
      live,
      document: null,
      base: Decoration.none,
      activeLines: new Set(),
      decorations: Decoration.none,
    };
  }

  const document = buildReadingDocument(state.doc.toString());
  const base = buildBaseEditorDecorations(state, document);
  const activeLines = selectedMarkerLines(state, document);
  return {
    live,
    document,
    base,
    activeLines,
    decorations: addMarkerEditorDecorations(
      base,
      state,
      document,
      activeLines,
    ),
  };
}

function clearEmbedBlockClasses(element) {
  element.classList.remove(
    "hexo-block-live-embed",
    "hexo-note-live-embed",
    "hexo-fold-live-embed",
    "hexo-block-live-depth-1",
    "hexo-block-live-depth-2",
    ...BLOCK_TYPE_CLASSES,
    ...BLOCK_PARENT_CLASSES,
  );
}

function styleRenderedEmbedBlocks(view) {
  const embeds = view.contentDOM.querySelectorAll(".cm-embed-block");
  if (!isLivePreview(view.state)) {
    for (const embed of embeds) clearEmbedBlockClasses(embed);
    return;
  }

  const field = view.state.field(editorBlockField, false);
  const lineBlocks =
    field && field.document ? field.document.bodyBlocks : new Map();

  for (const embed of embeds) {
    clearEmbedBlockClasses(embed);
    if (embed.closest(".cm-line.hexo-block-live-line")) continue;

    let position;
    try {
      position = view.posAtDOM(embed);
    } catch (_error) {
      continue;
    }

    const lineNumber = view.state.doc.lineAt(position).number;
    const block = lineBlocks.get(lineNumber);
    if (!block) continue;

    embed.classList.add(
      "hexo-block-live-embed",
      `hexo-${block.definition.kind}-live-embed`,
      `hexo-note-${block.definition.type}`,
      ...hierarchyClasses(block.depth, block.parent),
    );
  }
}

const editorBlockField = StateField.define({
  create(state) {
    return createEditorBlockState(state);
  },

  update(value, transaction) {
    const live = isLivePreview(transaction.state);
    if (transaction.docChanged || live !== value.live) {
      return createEditorBlockState(transaction.state);
    }
    if (!live || !value.document) return value;
    if (transaction.startState.selection.eq(transaction.state.selection)) {
      return value;
    }

    const activeLines = selectedMarkerLines(transaction.state, value.document);
    if (sameNumberSet(activeLines, value.activeLines)) return value;
    return {
      ...value,
      activeLines,
      decorations: addMarkerEditorDecorations(
        value.base,
        transaction.state,
        value.document,
        activeLines,
      ),
    };
  },

  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  },
});

const renderedEmbedBlockPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.frame = 0;
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(view.contentDOM, { childList: true, subtree: true });
      this.schedule();
    }

    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        styleRenderedEmbedBlocks(this.view);
      });
    }

    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        isLivePreview(update.startState) !== isLivePreview(update.state)
      ) {
        this.schedule();
      }
    }

    destroy() {
      this.observer.disconnect();
      if (this.frame) cancelAnimationFrame(this.frame);
    }
  },
);

module.exports = class HexoNotePreviewPlugin extends Plugin {
  onload() {
    this.readingDocuments = new Map();
    this.registerMarkdownPostProcessor((element, context) => {
      const section = context.getSectionInfo(element);
      if (!section) {
        renderStandaloneReadingBlocks(element);
        return;
      }

      const cacheKey = context.docId || context.sourcePath || "__anonymous__";
      let document = this.readingDocuments.get(cacheKey);
      if (!document || document.source !== section.text) {
        document = buildReadingDocument(section.text);
        this.readingDocuments.set(cacheKey, document);
      } else {
        this.readingDocuments.delete(cacheKey);
        this.readingDocuments.set(cacheKey, document);
      }
      while (this.readingDocuments.size > READING_DOCUMENT_CACHE_LIMIT) {
        this.readingDocuments.delete(this.readingDocuments.keys().next().value);
      }

      const expectedMarkers = document.markers.filter(
        ({ line }) => line >= section.lineStart && line <= section.lineEnd,
      );
      renderReadingSection(
        element,
        document.stackBeforeLine[section.lineStart] || [],
        expectedMarkers,
      );
    });
    this.registerEditorExtension([editorBlockField, renderedEmbedBlockPlugin]);
  }

  onunload() {
    this.readingDocuments.clear();
  }
};
