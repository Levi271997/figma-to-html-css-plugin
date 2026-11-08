// Figma to HTML/CSS: plugin sandbox.
// Walks the selected frame and sends the markup, CSS and font links to the UI,
// which builds either one self-contained HTML file or an HTML + CSS pair.
// Plain JavaScript on purpose, so there is no build step and designers can import it directly.

figma.showUI(__html__, { width: 480, height: 640, themeColors: true });

const CONTAINER_TYPES = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'];
const VECTOR_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE'];
const MAIN_ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
const CROSS_ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };
const TEXT_ALIGN = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' };
const TEXT_CASE = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' };
const SEGMENT_FIELDS = ['fontName', 'fontSize', 'fills', 'textDecoration', 'textCase', 'letterSpacing', 'lineHeight', 'hyperlink'];
// Values that undo a base text style inside a span, when the span does not set that property itself.
const TEXT_RESET = {
  'font-style': 'normal',
  'line-height': 'normal',
  'letter-spacing': 'normal',
  'text-transform': 'none',
  'text-decoration': 'none',
};
// Icons up to this size are exported as SVG when Figma flags them as an asset.
const MAX_AUTO_ICON = 256;

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'close') {
    figma.closePlugin();
    return;
  }
  if (msg.type === 'convert') {
    try {
      const result = await convertSelection();
      figma.ui.postMessage({ type: 'result', ...result });
    } catch (err) {
      figma.ui.postMessage({ type: 'error', message: err.message || String(err) });
    }
  }
};

figma.on('selectionchange', postSelection);
postSelection();

function postSelection() {
  const sel = figma.currentPage.selection;
  const ok = sel.length === 1 && CONTAINER_TYPES.includes(sel[0].type);
  figma.ui.postMessage({
    type: 'selection',
    ok,
    label: ok ? `${sel[0].name} (${Math.round(sel[0].width)} × ${Math.round(sel[0].height)})` : '',
    count: sel.length,
  });
}

async function convertSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1 || !CONTAINER_TYPES.includes(selection[0].type)) {
    throw new Error('Select exactly one frame or section to convert.');
  }
  const root = selection[0];
  const ctx = {
    rules: [],
    fonts: new Map(),
    classCount: 0,
    svgCount: 0,
    inLink: false,
    counts: { layers: 0, text: 0, images: 0, svgs: 0 },
  };
  const body = await renderNode(root, 'NONE', ctx, { isRoot: true, isSection: false, offset: { x: 0, y: 0 } });
  return {
    title: root.name,
    fileBase: slugify(root.name) || 'page',
    width: root.width,
    height: root.height,
    body,
    css: buildCss(ctx),
    fontLinks: buildFontLinks(ctx),
    stats: ctx.counts,
  };
}

// Renders one layer and its children.
// parentMode is the parent's layout: 'HORIZONTAL', 'VERTICAL', 'GRID', or 'NONE' when children are placed by x/y.
// opts.offset is subtracted from x/y, for children of a group that is drawn as its own box.
async function renderNode(node, parentMode, ctx, opts) {
  if (node.visible === false) return '';
  const asSvg = shouldExportSvg(node);

  // Groups have no coordinate space of their own. In a free-form parent their children are flattened into it.
  if (node.type === 'GROUP' && !asSvg && parentMode === 'NONE') {
    let html = '';
    for (const child of node.children) {
      html += await renderNode(child, parentMode, ctx, opts);
    }
    return html;
  }

  ctx.counts.layers++;
  const cls = className(node, ctx);
  // Reserve the rule now so the CSS follows document order (parent before children and spans).
  const rule = { selector: `.${cls}`, decls: [] };
  ctx.rules.push(rule);

  const rules = placeRules(node, parentMode, opts, asSvg);
  if (typeof node.opacity === 'number' && node.opacity < 1) rules.push(`opacity: ${round(node.opacity)}`);

  let tag = 'div';
  let inner = '';
  let attrs = ` data-figma-name="${escapeHtml(node.name)}" data-figma-type="${node.type}"`;
  if (opts.isSection) attrs += ` data-section="${escapeHtml(node.name)}"`;

  // Buttons become links. Links cannot nest, so anything inside one stays a plain element.
  const link = !opts.isRoot && !ctx.inLink ? linkFor(node) : null;
  if (link) {
    tag = 'a';
    attrs = ` href="${escapeHtml(link.href)}"${link.newTab ? ' target="_blank" rel="noopener"' : ''}${attrs}`;
    ctx.inLink = true;
  }

  if (asSvg) {
    attrs += ' data-svg';
    inner = await svgMarkup(node, ctx);
  } else if (node.type === 'TEXT') {
    ctx.counts.text++;
    const text = textContent(node, cls, ctx);
    tag = textTag(node, text.maxSize);
    rules.push(...text.baseRules, ...textBoxRules(node), ...effectRules(node, true));
    inner = text.inner;
  } else if (node.type === 'GROUP') {
    // A group inside auto layout is one flex item: draw it as a box and place its children inside it.
    rules.push(...effectRules(node, false));
    for (const child of node.children) {
      inner += await renderNode(child, 'NONE', ctx, { isRoot: false, isSection: false, offset: { x: node.x, y: node.y } });
    }
  } else {
    rules.push(...layoutRules(node));
    rules.push(...(await backgroundRules(node, ctx)));
    rules.push(...strokeRules(node));
    rules.push(...cornerRules(node));
    rules.push(...effectRules(node, false));
    if (node.clipsContent) rules.push('overflow: hidden');

    const childMode = 'layoutMode' in node && node.layoutMode !== 'NONE' ? node.layoutMode : 'NONE';
    for (const child of node.children || []) {
      const mode = child.layoutPositioning === 'ABSOLUTE' ? 'NONE' : childMode;
      inner += await renderNode(child, mode, ctx, { isRoot: false, isSection: opts.isRoot, offset: { x: 0, y: 0 } });
    }
  }

  // Containers are the positioning context for absolutely placed children,
  // unless they are already absolutely placed themselves.
  if (inner && !asSvg && node.type !== 'TEXT' && !rules.some((r) => r.startsWith('position:'))) {
    rules.unshift('position: relative');
  }
  if (link) {
    ctx.inLink = false;
    // <a> is inline by default; give it a box like the frame it came from.
    if (!rules.some((r) => r.startsWith('display:'))) rules.push('display: block');
    rules.push('cursor: pointer');
  }
  rule.decls = dedupe(rules);
  return `<${tag} class="${cls}"${attrs}>${inner}</${tag}>`;
}

// ---------- Links ----------

// A frame, component or instance is a link when its prototype opens a URL, or when its name
// contains "button", "btn" or "cta", or starts with "link". The href comes from the prototype
// "Open link" action, then from a hyperlink on text inside it, and falls back to "#".
function linkFor(node) {
  if (!['FRAME', 'COMPONENT', 'INSTANCE'].includes(node.type)) return null;
  const proto = prototypeUrl(node);
  if (proto) return proto;
  if (!/\b(button|btn|cta)\b|^link\b/i.test(node.name)) return null;
  return { href: textLinkInside(node) || '#', newTab: false };
}

function prototypeUrl(node) {
  let reactions = [];
  try {
    reactions = node.reactions || [];
  } catch (e) {
    return null;
  }
  for (const r of reactions) {
    const actions = r.actions || (r.action ? [r.action] : []);
    for (const a of actions) {
      if (a && a.type === 'URL' && a.url) return { href: a.url, newTab: !!a.openInNewTab };
    }
  }
  return null;
}

function textLinkInside(node) {
  if (!('findAll' in node)) return null;
  for (const t of node.findAll((n) => n.type === 'TEXT')) {
    try {
      const h = t.hyperlink;
      if (h && h !== figma.mixed && h.type === 'URL') return h.value;
      for (const seg of t.getStyledTextSegments(['hyperlink'])) {
        if (seg.hyperlink && seg.hyperlink.type === 'URL') return seg.hyperlink.value;
      }
    } catch (e) {
      // Ignore unreadable text and keep looking.
    }
  }
  return null;
}

// ---------- Position and size ----------

function placeRules(node, parentMode, opts, asSvg) {
  if (opts.isRoot) return ['position: relative', 'width: 100%', `max-width: ${px(node.width)}`, 'margin: 0 auto'];

  const isText = node.type === 'TEXT';
  const rotated = Math.abs(node.rotation || 0) > 0.01;
  // An exported SVG already contains the rotation, so it is placed by its rotated bounding box.
  const box = asSvg && rotated ? rotatedBox(node) : { x: node.x, y: node.y, w: node.width, h: node.height };

  if (parentMode === 'NONE') {
    const rules = ['position: absolute', `left: ${px(box.x - opts.offset.x)}`, `top: ${px(box.y - opts.offset.y)}`];
    if (isText) {
      if (node.textAutoResize !== 'WIDTH_AND_HEIGHT') rules.push(`width: ${px(box.w)}`);
    } else {
      rules.push(`width: ${px(box.w)}`, `height: ${px(box.h)}`);
    }
    if (rotated && !asSvg) rules.push('transform-origin: 0 0', `transform: rotate(${round(-node.rotation)}deg)`);
    return rules;
  }

  if (parentMode === 'GRID') return gridChildRules(node, box);

  // Parent is auto layout: translate FILL / FIXED / HUG into main and cross axis rules.
  const mainIsH = parentMode === 'HORIZONTAL';
  const sizingH = node.layoutSizingHorizontal || 'FIXED';
  const sizingV = node.layoutSizingVertical || 'FIXED';
  const mainSizing = mainIsH ? sizingH : sizingV;
  const crossSizing = mainIsH ? sizingV : sizingH;
  const mainProp = mainIsH ? 'width' : 'height';
  const crossProp = mainIsH ? 'height' : 'width';
  const mainDim = mainIsH ? box.w : box.h;
  const crossDim = mainIsH ? box.h : box.w;
  // Text sets its own height from its content, and hug-width text sets its own width.
  const skip = (prop) => isText && (prop === 'height' || node.textAutoResize === 'WIDTH_AND_HEIGHT');
  const rules = [];

  if (mainSizing === 'FILL') rules.push('flex: 1 1 0', `min-${mainProp}: 0`);
  else {
    if (mainSizing === 'FIXED' && !skip(mainProp)) rules.push(`${mainProp}: ${px(mainDim)}`);
    rules.push('flex-shrink: 0');
  }

  if (crossSizing === 'FILL') rules.push('align-self: stretch');
  else if (crossSizing === 'FIXED' && !skip(crossProp)) rules.push(`${crossProp}: ${px(crossDim)}`);

  return rules;
}

function gridChildRules(node, box) {
  const rules = [];
  if (typeof node.gridColumnAnchorIndex === 'number') {
    rules.push(`grid-column: ${node.gridColumnAnchorIndex + 1} / span ${node.gridColumnSpan || 1}`);
  }
  if (typeof node.gridRowAnchorIndex === 'number') {
    rules.push(`grid-row: ${node.gridRowAnchorIndex + 1} / span ${node.gridRowSpan || 1}`);
  }
  if (node.layoutSizingHorizontal === 'FIXED' && node.type !== 'TEXT') rules.push(`width: ${px(box.w)}`);
  if (node.layoutSizingVertical === 'FIXED' && node.type !== 'TEXT') rules.push(`height: ${px(box.h)}`);
  if (node.layoutSizingHorizontal === 'FILL') rules.push('justify-self: stretch');
  if (node.layoutSizingVertical === 'FILL') rules.push('align-self: stretch');
  return rules;
}

// Bounding box of a rotated layer in its parent's coordinates.
function rotatedBox(node) {
  const [[a, c, tx], [b, d, ty]] = node.relativeTransform;
  const pts = [[0, 0], [node.width, 0], [0, node.height], [node.width, node.height]].map(([x, y]) => [
    a * x + c * y + tx,
    b * x + d * y + ty,
  ]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function layoutRules(node) {
  const mode = 'layoutMode' in node ? node.layoutMode : 'NONE';
  if (!mode || mode === 'NONE') {
    // Children of a free-form frame are absolutely positioned, so the frame needs a height of its own.
    return 'children' in node && node.children.length ? [`min-height: ${px(node.height)}`] : [];
  }

  const padding = `padding: ${boxShorthand(node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft)}`;

  if (mode === 'GRID') {
    const rules = ['display: grid', padding];
    if (node.gridColumnCount) rules.push(`grid-template-columns: repeat(${node.gridColumnCount}, minmax(0, 1fr))`);
    if (node.gridRowCount) rules.push(`grid-template-rows: repeat(${node.gridRowCount}, auto)`);
    if (typeof node.gridRowGap === 'number') rules.push(`row-gap: ${px(node.gridRowGap)}`);
    if (typeof node.gridColumnGap === 'number') rules.push(`column-gap: ${px(node.gridColumnGap)}`);
    return rules;
  }

  const rules = [
    'display: flex',
    `flex-direction: ${mode === 'HORIZONTAL' ? 'row' : 'column'}`,
    `justify-content: ${MAIN_ALIGN[node.primaryAxisAlignItems] || 'flex-start'}`,
    `align-items: ${CROSS_ALIGN[node.counterAxisAlignItems] || 'flex-start'}`,
    padding,
  ];
  if (typeof node.itemSpacing === 'number' && node.primaryAxisAlignItems !== 'SPACE_BETWEEN') {
    rules.push(`${mode === 'HORIZONTAL' ? 'column-gap' : 'row-gap'}: ${px(node.itemSpacing)}`);
  }
  if (node.layoutWrap === 'WRAP') {
    rules.push('flex-wrap: wrap');
    if (typeof node.counterAxisSpacing === 'number') {
      rules.push(`${mode === 'HORIZONTAL' ? 'row-gap' : 'column-gap'}: ${px(node.counterAxisSpacing)}`);
    }
  }
  return rules;
}

// ---------- Fills ----------

async function backgroundRules(node, ctx) {
  const fills = visiblePaints(node, 'fills');
  if (!fills.length) return [];
  if (fills.length === 1 && fills[0].type === 'SOLID') return [`background-color: ${paintColor(fills[0])}`];

  // Figma lists fills bottom to top; CSS lists background layers top to bottom.
  const layers = [];
  for (const paint of fills.slice().reverse()) {
    const layer = await paintLayer(paint, node, ctx);
    if (layer) layers.push(layer);
  }
  if (!layers.length) return [];
  return [
    `background-image: ${layers.map((l) => l.image).join(', ')}`,
    `background-size: ${layers.map((l) => l.size).join(', ')}`,
    `background-position: ${layers.map((l) => l.position).join(', ')}`,
    `background-repeat: ${layers.map((l) => l.repeat).join(', ')}`,
  ];
}

async function paintLayer(paint, node, ctx) {
  const plain = { size: 'auto', position: '0 0', repeat: 'no-repeat' };
  if (paint.type === 'SOLID') {
    const c = paintColor(paint);
    return { image: `linear-gradient(${c}, ${c})`, ...plain };
  }
  if (paint.type.startsWith('GRADIENT_')) {
    const image = gradientCss(paint, node);
    return image ? { image, ...plain } : null;
  }
  if (paint.type === 'IMAGE' && paint.imageHash) {
    const image = figma.getImageByHash(paint.imageHash);
    if (!image) return null;
    const bytes = await image.getBytesAsync();
    ctx.counts.images++;
    const url = `url("data:${sniffMime(bytes)};base64,${figma.base64Encode(bytes)}")`;
    if (paint.scaleMode === 'TILE') {
      let size = 'auto';
      try {
        const dims = await image.getSizeAsync();
        const f = paint.scalingFactor || 1;
        size = `${px(dims.width * f)} ${px(dims.height * f)}`;
      } catch (e) {
        // Size is optional; the tile falls back to the image's natural size.
      }
      return { image: url, size, position: '0 0', repeat: 'repeat' };
    }
    return { image: url, size: paint.scaleMode === 'FIT' ? 'contain' : 'cover', position: 'center', repeat: 'no-repeat' };
  }
  return null;
}

// Converts a Figma gradient to CSS, keeping its angle, handle positions and stop positions.
function gradientCss(paint, node) {
  const w = node.width || 1;
  const h = node.height || 1;
  const inv = invertTransform(paint.gradientTransform);
  if (!inv) return null;
  // Gradient space -> layer pixels.
  const toPx = (gx, gy) => ({
    x: (inv[0][0] * gx + inv[0][1] * gy + inv[0][2]) * w,
    y: (inv[1][0] * gx + inv[1][1] * gy + inv[1][2]) * h,
  });
  const alpha = paint.opacity === undefined ? 1 : paint.opacity;
  const stops = (map) =>
    paint.gradientStops.map((s) => `${rgba(s.color, alpha)} ${round(map(s.position) * 100)}%`).join(', ');

  if (paint.type === 'GRADIENT_LINEAR') {
    const a = toPx(0, 0.5);
    const b = toPx(1, 0.5);
    const theta = Math.atan2(b.x - a.x, -(b.y - a.y));
    // CSS draws the gradient along a line through the centre whose length depends on the angle.
    // Project the Figma handles onto that line so the stops land in the same place.
    const ux = Math.sin(theta);
    const uy = -Math.cos(theta);
    const len = Math.abs(w * ux) + Math.abs(h * uy);
    const t = (p) => ((p.x - w / 2) * ux + (p.y - h / 2) * uy + len / 2) / len;
    const t0 = t(a);
    const t1 = t(b);
    return `linear-gradient(${round(deg(theta))}deg, ${stops((pos) => t0 + pos * (t1 - t0))})`;
  }
  if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
    const c = toPx(0.5, 0.5);
    const rx = toPx(1, 0.5);
    const ry = toPx(0.5, 1);
    const r1 = Math.hypot(rx.x - c.x, rx.y - c.y);
    const r2 = Math.hypot(ry.x - c.x, ry.y - c.y);
    return `radial-gradient(${px(r1)} ${px(r2)} at ${px(c.x)} ${px(c.y)}, ${stops((p) => p)})`;
  }
  if (paint.type === 'GRADIENT_ANGULAR') {
    const c = toPx(0.5, 0.5);
    const e = toPx(1, 0.5);
    const from = deg(Math.atan2(e.x - c.x, -(e.y - c.y)));
    return `conic-gradient(from ${round(from)}deg at ${px(c.x)} ${px(c.y)}, ${stops((p) => p)})`;
  }
  return null;
}

function invertTransform(m) {
  const [[a, b, c], [d, e, f]] = m;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-9) return null;
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  return [
    [ia, ib, -(ia * c + ib * f)],
    [id, ie, -(id * c + ie * f)],
  ];
}

// ---------- Strokes, corners, effects ----------

// Strokes are drawn with outline so they never move children, matching Figma,
// where strokes sit on top of the layer and do not affect layout.
function strokeRules(node) {
  const paint = visiblePaints(node, 'strokes').find((p) => p.type === 'SOLID');
  if (!paint) return [];
  const color = paintColor(paint);
  const style = Array.isArray(node.dashPattern) && node.dashPattern.length ? 'dashed' : 'solid';

  // Different weight per side: borders are the only CSS that supports it.
  const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => node[`stroke${s}Weight`]);
  if (typeof node.strokeWeight !== 'number' && sides.every((n) => typeof n === 'number')) {
    return sides.map((w, i) => `border-${['top', 'right', 'bottom', 'left'][i]}: ${px(w)} ${style} ${color}`);
  }

  const weight = node.strokeWeight;
  if (typeof weight !== 'number' || !weight) return [];
  const offset = { INSIDE: -weight, CENTER: -weight / 2, OUTSIDE: 0 }[node.strokeAlign] ?? -weight;
  return [`outline: ${px(weight)} ${style} ${color}`, `outline-offset: ${px(offset)}`];
}

function cornerRules(node) {
  if (node.type === 'ELLIPSE') return ['border-radius: 50%'];
  if (typeof node.cornerRadius === 'number') {
    return node.cornerRadius ? [`border-radius: ${px(node.cornerRadius)}`] : [];
  }
  // Mixed corner radii: use the per-corner values.
  if (typeof node.topLeftRadius === 'number') {
    return [`border-radius: ${px(node.topLeftRadius)} ${px(node.topRightRadius)} ${px(node.bottomRightRadius)} ${px(node.bottomLeftRadius)}`];
  }
  return [];
}

// Figma's blur radius is roughly twice the CSS blur() radius.
function effectRules(node, isText) {
  if (!Array.isArray(node.effects)) return [];
  const effects = node.effects.filter((e) => e.visible !== false);
  const rules = [];

  const shadows = effects.filter((e) => e.type === 'DROP_SHADOW' || (!isText && e.type === 'INNER_SHADOW'));
  if (shadows.length) {
    if (isText) {
      rules.push(`text-shadow: ${shadows.map((e) => `${px(e.offset.x)} ${px(e.offset.y)} ${px(e.radius)} ${rgba(e.color)}`).join(', ')}`);
    } else {
      rules.push(`box-shadow: ${shadows
        .map((e) => `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(e.offset.x)} ${px(e.offset.y)} ${px(e.radius)} ${px(e.spread || 0)} ${rgba(e.color)}`)
        .join(', ')}`);
    }
  }

  const blur = effects.find((e) => e.type === 'LAYER_BLUR');
  if (blur) rules.push(`filter: blur(${px(blur.radius / 2)})`);
  const bgBlur = effects.find((e) => e.type === 'BACKGROUND_BLUR');
  if (bgBlur) {
    rules.push(`-webkit-backdrop-filter: blur(${px(bgBlur.radius / 2)})`, `backdrop-filter: blur(${px(bgBlur.radius / 2)})`);
  }
  return rules;
}

// ---------- SVG ----------

function shouldExportSvg(node) {
  if (VECTOR_TYPES.includes(node.type)) return true;
  if (node.type === 'ELLIPSE') {
    // Plain circles and ovals stay as a div with border-radius; arcs and donuts need SVG.
    const arc = node.arcData;
    return !!arc && (arc.innerRadius > 0 || Math.abs(arc.endingAngle - arc.startingAngle) < Math.PI * 2 - 0.01);
  }
  if (!['FRAME', 'GROUP', 'INSTANCE', 'COMPONENT'].includes(node.type)) return false;
  // Layer name prefix forces SVG, e.g. "icon/arrow" or "svg Logo".
  if (/^(svg|icon)\b/i.test(node.name)) return true;
  let isAsset = false;
  try {
    isAsset = node.isAsset === true;
  } catch (e) {
    isAsset = false;
  }
  return isAsset && node.width <= MAX_AUTO_ICON && node.height <= MAX_AUTO_ICON && !containsTextOrImage(node);
}

function containsTextOrImage(node) {
  const hit = (n) => n.type === 'TEXT' || visiblePaints(n, 'fills').some((p) => p.type === 'IMAGE');
  if (hit(node)) return true;
  return 'findOne' in node && !!node.findOne(hit);
}

async function svgMarkup(node, ctx) {
  let svg;
  try {
    svg = await node.exportAsync({ format: 'SVG_STRING' });
  } catch (e) {
    try {
      svg = utf8Decode(await node.exportAsync({ format: 'SVG' }));
    } catch (e2) {
      // Figma refuses to export layers with nothing visible (empty vectors, hidden children,
      // no fills or strokes). Keep the empty box so the layout is unchanged instead of failing the whole conversion.
      return '';
    }
  }
  ctx.counts.svgs++;
  // Prefix ids so gradients, masks and clip paths from different icons cannot collide in one page.
  const prefix = `svg${++ctx.svgCount}-`;
  return svg
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
    .replace(/((?:xlink:)?href)="#([^"]+)"/g, `$1="#${prefix}$2"`)
    .trim();
}

function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

// ---------- Text ----------

// Splits a text layer into styled runs. The first run's style goes on the element;
// runs that differ get a span with only the differences, and links become <a>.
function textContent(node, cls, ctx) {
  let segments = null;
  try {
    segments = node.getStyledTextSegments(SEGMENT_FIELDS);
  } catch (e) {
    segments = null;
  }
  if (!segments || !segments.length) {
    const mixed = (v, fallback) => (v === figma.mixed || v === undefined ? fallback : v);
    segments = [{
      characters: node.characters,
      fontName: mixed(node.fontName, { family: 'Inter', style: 'Regular' }),
      fontSize: mixed(node.fontSize, 16),
      fills: mixed(node.fills, []),
      textDecoration: mixed(node.textDecoration, 'NONE'),
      textCase: mixed(node.textCase, 'ORIGINAL'),
      letterSpacing: mixed(node.letterSpacing, { unit: 'PIXELS', value: 0 }),
      lineHeight: mixed(node.lineHeight, { unit: 'AUTO' }),
      hyperlink: null,
    }];
  }

  const base = textStyle(segments[0], ctx);
  let inner = '';
  let maxSize = 0;
  segments.forEach((seg, i) => {
    maxSize = Math.max(maxSize, seg.fontSize || 0);
    const style = i === 0 ? base : textStyle(seg, ctx);
    const decls = Object.keys(style).filter((k) => style[k] !== base[k]).map((k) => `${k}: ${style[k]}`);
    Object.keys(base).forEach((k) => {
      if (!(k in style) && TEXT_RESET[k]) decls.push(`${k}: ${TEXT_RESET[k]}`);
    });

    let html = escapeHtml(seg.characters).replace(/\n/g, '<br>');
    if (decls.length) {
      const spanCls = `${cls}-s${i + 1}`;
      ctx.rules.push({ selector: `.${spanCls}`, decls });
      html = `<span class="${spanCls}">${html}</span>`;
    }
    const link = seg.hyperlink && seg.hyperlink.type === 'URL' ? seg.hyperlink.value : null;
    if (link && !ctx.inLink) html = `<a href="${escapeHtml(link)}">${html}</a>`;
    inner += html;
  });

  return { baseRules: Object.keys(base).map((k) => `${k}: ${base[k]}`), inner, maxSize: maxSize || 16 };
}

function textStyle(seg, ctx) {
  const font = seg.fontName && seg.fontName !== figma.mixed ? seg.fontName : { family: 'Inter', style: 'Regular' };
  const weight = weightOf(font.style);
  const italic = /italic|oblique/i.test(font.style);
  addFont(ctx, font.family, weight, italic);

  const s = {
    'font-family': `"${font.family}", sans-serif`,
    'font-size': px(seg.fontSize || 16),
    'font-weight': String(weight),
  };
  if (italic) s['font-style'] = 'italic';

  const lh = seg.lineHeight;
  if (lh && lh.unit === 'PIXELS') s['line-height'] = px(lh.value);
  else if (lh && lh.unit === 'PERCENT') s['line-height'] = String(round(lh.value / 100, 3));

  const ls = seg.letterSpacing;
  if (ls && ls.value) {
    s['letter-spacing'] = ls.unit === 'PIXELS' ? px(ls.value) : `${round(ls.value / 100, 3)}em`;
  }

  if (TEXT_CASE[seg.textCase]) s['text-transform'] = TEXT_CASE[seg.textCase];
  if (seg.textDecoration === 'UNDERLINE') s['text-decoration'] = 'underline';
  if (seg.textDecoration === 'STRIKETHROUGH') s['text-decoration'] = 'line-through';

  const fill = visiblePaints(seg, 'fills').find((p) => p.type === 'SOLID');
  if (fill) s.color = paintColor(fill);
  return s;
}

// Layer-level text rules: alignment, wrapping and truncation.
function textBoxRules(node) {
  const rules = [];
  if (TEXT_ALIGN[node.textAlignHorizontal]) rules.push(`text-align: ${TEXT_ALIGN[node.textAlignHorizontal]}`);
  if (node.textAutoResize === 'WIDTH_AND_HEIGHT') rules.push('white-space: nowrap');
  if (node.textTruncation === 'ENDING') {
    if (typeof node.maxLines === 'number' && node.maxLines > 1) {
      rules.push('display: -webkit-box', `-webkit-line-clamp: ${node.maxLines}`, '-webkit-box-orient: vertical', 'overflow: hidden');
    } else {
      rules.push('white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis');
    }
  }
  return rules;
}

// Layer names can force a tag, e.g. "h2 Pricing" or "p Intro". Otherwise the largest font size decides.
function textTag(node, size) {
  const named = node.name.match(/^(h[1-6]|p)\b/i);
  if (named) return named[1].toLowerCase();
  if (size >= 40) return 'h1';
  if (size >= 28) return 'h2';
  if (size >= 20) return 'h3';
  return 'p';
}

function weightOf(style = '') {
  const s = style.toLowerCase().replace(/\s|-/g, '');
  if (s.includes('thin') || s.includes('hairline')) return 100;
  if (s.includes('extralight') || s.includes('ultralight')) return 200;
  if (s.includes('light')) return 300;
  if (s.includes('medium')) return 500;
  if (s.includes('semibold') || s.includes('demibold')) return 600;
  if (s.includes('extrabold') || s.includes('ultrabold')) return 800;
  if (s.includes('bold')) return 700;
  if (s.includes('black') || s.includes('heavy')) return 900;
  return 400;
}

function addFont(ctx, family, weight, italic) {
  if (!family) return;
  if (!ctx.fonts.has(family)) ctx.fonts.set(family, new Set());
  ctx.fonts.get(family).add(`${italic ? 1 : 0},${weight}`);
}

// One <link> per family, so a font that is not on Google Fonts cannot break the others.
function buildFontLinks(ctx) {
  const links = [];
  ctx.fonts.forEach((variants, family) => {
    const tuples = [...variants]
      .map((v) => v.split(',').map(Number))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([i, w]) => `${i},${w}`)
      .join(';');
    const name = encodeURIComponent(family).replace(/%20/g, '+');
    links.push(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${name}:ital,wght@${tuples}&display=swap">`);
  });
  return links;
}

// ---------- Output ----------

function buildCss(ctx) {
  const reset = [
    '*, *::before, *::after { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; }',
    'h1, h2, h3, h4, h5, h6, p { margin: 0; }',
    'a { color: inherit; text-decoration: none; }',
    '[data-svg] > svg { display: block; width: 100%; height: 100%; overflow: visible; }',
  ].join('\n');
  const rules = ctx.rules
    .filter((r) => r.decls.length)
    .map((r) => `${r.selector} {\n${r.decls.map((d) => `  ${d};`).join('\n')}\n}`)
    .join('\n\n');
  return `${reset}\n\n${rules}\n`;
}

// Keeps the last value for each property, in first-seen order.
function dedupe(decls) {
  const map = new Map();
  decls.forEach((d) => {
    const prop = d.slice(0, d.indexOf(':')).trim();
    map.delete(prop);
    map.set(prop, d);
  });
  return [...map.values()];
}

function className(node, ctx) {
  const n = ++ctx.classCount;
  let base = slugify(node.name).slice(0, 24).replace(/-+$/, '');
  if (!base || /^[0-9]/.test(base)) base = node.type.toLowerCase().replace(/_/g, '-') + (base ? `-${base}` : '');
  return `${base}-${n}`;
}

// ---------- Helpers ----------

function visiblePaints(node, key) {
  return Array.isArray(node[key]) ? node[key].filter((p) => p.visible !== false) : [];
}

function paintColor(paint) {
  return rgba(paint.color, paint.opacity === undefined ? 1 : paint.opacity);
}

function rgba(color, opacity = 1) {
  const a = round((color.a === undefined ? 1 : color.a) * opacity, 3);
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  if (a === 1) return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function sniffMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'image/png';
}

function deg(rad) {
  return (rad * 180) / Math.PI;
}

// CSS shorthand for four sides: "8px", "8px 16px" or the full four values.
function boxShorthand(top = 0, right = 0, bottom = 0, left = 0) {
  if (top === right && right === bottom && bottom === left) return px(top);
  if (top === bottom && right === left) return `${px(top)} ${px(right)}`;
  return `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`;
}

function px(value) {
  return `${round(value)}px`;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
