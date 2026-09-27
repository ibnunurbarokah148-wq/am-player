/* AM editor foundation: model, time/keyframes, parenting, commands, XML IO. */
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

export const AM_TIME = Object.freeze({
  layerMsToNormalized(ms, startMs, endMs) {
    const span = Math.max(0, finite(endMs) - finite(startMs));
    return span ? Math.max(0, Math.min(1, (finite(ms) - finite(startMs)) / span)) : 0;
  },
  normalizedToLayerMs(t, startMs, endMs) {
    return finite(startMs) + Math.max(0, Math.min(1, finite(t))) * Math.max(0, finite(endMs) - finite(startMs));
  }
});

function readAttributes(element) {
  const attrs = {};
  if (!element?.attributes) return attrs;
  for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
  return attrs;
}
function parseValue(value) {
  if (typeof value !== 'string') return value;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return Number(value);
  if (value.includes(',')) return value.split(',').map(x => finite(x, 0));
  return value;
}
function elementToNode(element) {
  const node = { tag: element.tagName, attrs: readAttributes(element), children: [], text: '' };
  for (const child of Array.from(element.childNodes || [])) {
    if (child.nodeType === 1) node.children.push(elementToNode(child));
    else if (child.nodeType === 3 && child.nodeValue.trim()) node.text += child.nodeValue;
  }
  return node;
}
function nodeToElement(node, doc) {
  const element = doc.createElement(node.tag);
  for (const [key, value] of Object.entries(node.attrs || {})) element.setAttribute(key, String(value));
  if (node.text) element.appendChild(doc.createTextNode(node.text));
  for (const child of node.children || []) element.appendChild(nodeToElement(child, doc));
  return element;
}
export function parseSceneXml(xml, parser = globalThis.DOMParser) {
  if (!parser) throw new Error('DOMParser tidak tersedia; gunakan parser browser atau kirim model');
  const doc = typeof parser === 'function' ? new parser().parseFromString(String(xml), 'application/xml') : parser.parseFromString(String(xml), 'application/xml');
  if (!doc?.documentElement || doc.documentElement.tagName !== 'scene' || doc.querySelector?.('parsererror')) throw new Error('XML tidak valid: root harus <scene>');
  return createSceneModel(elementToNode(doc.documentElement));
}
function findChildren(node, tag) { return (node.children || []).filter(child => child.tag === tag); }
function findChild(node, tag) { return findChildren(node, tag)[0]; }
function makeProperty(node) {
  const kfs = findChildren(node, 'kf').map(k => ({ t: finite(k.attrs.t), v: parseValue(k.attrs.v ?? '') , easing: k.attrs.e, attrs: { ...k.attrs } }));
  return { name: node.attrs.name || node.tag, type: node.attrs.type || 'string', value: parseValue(node.attrs.value ?? ''), keyframes: kfs, attrs: node.attrs, node };
}
function decorateLayer(node, parentId = null, sceneDuration = 0) {
  const id = node.attrs.id || null;
  const properties = {};
  for (const child of node.children || []) {
    if (child.tag === 'property' || child.tag === 'transform') {
      if (child.tag === 'transform') for (const p of child.children || []) properties[p.attrs.name || p.tag] = makeProperty(p);
      else properties[child.attrs.name || child.tag] = makeProperty(child);
    }
  }
  const explicitParent = node.attrs.parent || null;
  const startTime = finite(node.attrs.startTime, 0);
  const endTime = hasOwn(node.attrs, 'endTime') ? finite(node.attrs.endTime, sceneDuration) : sceneDuration;
  return { id, type: node.tag, label: node.attrs.label || '', parentId: explicitParent || parentId, startTime, endTime, attrs: node.attrs, properties, effects: findChildren(node, 'effect').map(e => ({ ...e.attrs, params: findChildren(e, 'property').map(makeProperty), node: e })), node };
}
export function createSceneModel(root) {
  const layers = [];
  const duration = finite(root.attrs.totalTime, 0);
  const layerTags = new Set(['shape', 'text', 'media', 'color', 'drawing', 'audio', 'camera', 'embedScene']);
  const walk = (node, inheritedParent = null) => {
    const isLayer = layerTags.has(node.tag);
    const layer = isLayer ? decorateLayer(node, inheritedParent, duration) : null;
    if (layer) layers.push(layer);
    const childParent = layer?.id || inheritedParent;
    for (const child of node.children || []) {
      if (child.tag === 'group' || layerTags.has(child.tag)) walk(child, child.attrs.parent || childParent);
    }
  };
  walk(root);
  return { kind: 'am-scene', version: 1, root, attrs: { ...root.attrs }, width: finite(root.attrs.width, 1080), height: finite(root.attrs.height, 1920), fps: finite(root.attrs.fps, 30), duration, layers };
}
function interpolate(a, b, t) {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => finite(v) + (finite(b[i], finite(v)) - finite(v)) * t);
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  return t < 1 ? a : b;
}
function cubicBezier(x1, y1, x2, y2, t) {
  const bez = (u, p1, p2) => 3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u;
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 10; i++) {
    const x = bez(u, x1, x2);
    if (Math.abs(x - t) < 1e-5) break;
    if (x < t) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  return bez(u, y1, y2);
}
function easeValue(spec, t) {
  const parts = String(spec || '').trim().split(/\s+/);
  const i = parts[0] === 'local' ? 1 : 0;
  if (parts[i] === 'cubicBezier' && parts.length >= i + 5) {
    const n = parts.slice(i + 1, i + 5).map(Number);
    if (n.every(Number.isFinite)) return cubicBezier(...n, t);
  }
  if (parts[i] === 'reverse' && parts[i + 1] === 'cubicBezier') return 1 - easeValue(parts.slice(i + 1).join(' '), 1 - t);
  return t;
}
export function evaluateKeyframes(property, layerTimeMs, layerStartMs = 0, layerEndMs = 1) {
  const frames = [...(property?.keyframes || [])].sort((a, b) => a.t - b.t);
  if (!frames.length) return clone(property?.value);
  const t = AM_TIME.layerMsToNormalized(layerTimeMs, layerStartMs, layerEndMs);
  if (t <= frames[0].t) return clone(frames[0].v);
  if (t >= frames.at(-1).t) return clone(frames.at(-1).v);
  let next = frames.findIndex(frame => frame.t >= t); const b = frames[next], a = frames[next - 1];
  const segment = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return interpolate(a.v, b.v, easeValue(a.easing, segment));
}
const identity = () => [1, 0, 0, 1, 0, 0];
const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
function localMatrix(layer, timeMs) {
  const p = layer.properties || {}, value = name => evaluateKeyframes(p[name] || {}, timeMs, layer.startTime, layer.endTime);
  const pos = value('location') || [0, 0], pivot = value('pivot') || [0, 0], scale = value('scale') || [1, 1], skew = value('skew') || [0, 0];
  const rotation = finite(value('rotation')) * Math.PI / 180, c = Math.cos(rotation), s = Math.sin(rotation);
  const sx = finite(scale[0], 1), sy = finite(scale[1], 1);
  const kx = Math.tan(finite(skew[0]) * Math.PI / 180), ky = Math.tan(finite(skew[1]) * Math.PI / 180);
  const base = [c * sx + (-s * sy) * ky, s * sx + c * sy * ky, c * sx * kx - s * sy, s * sx * kx + c * sy, finite(pos[0]), finite(pos[1])];
  const px = finite(pivot[0]), py = finite(pivot[1]);
  return multiply(multiply([1, 0, 0, 1, px, py], base), [1, 0, 0, 1, -px, -py]);
}
export function resolveParentTransform(layer, layers, timeMs, seen = new Set()) {
  if (!layer || seen.has(layer.id)) return identity();
  seen.add(layer.id); const local = localMatrix(layer, timeMs);
  const parent = layers.find(item => item.id && item.id === layer.parentId);
  return parent ? multiply(resolveParentTransform(parent, layers, timeMs, seen), local) : local;
}
export function evaluateSceneTransform(scene, id, timeMs) {
  const layer = scene?.layers?.find(item => String(item.id) === String(id));
  if (!layer) return { pos: [0, 0], scale: [1, 1], rot: 0, opacity: 1, z: 0, matrix: identity() };
  const matrix = resolveParentTransform(layer, scene.layers, timeMs);
  const rot = Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI;
  return {
    pos: [matrix[4], matrix[5]],
    scale: [Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3])],
    rot,
    opacity: finite(evaluateKeyframes(layer.properties.opacity || {}, timeMs, layer.startTime, layer.endTime), 1),
    z: finite(evaluateKeyframes(layer.properties.location || {}, timeMs, layer.startTime, layer.endTime)?.[2]),
    matrix
  };
}

export class CommandHistory {
  constructor(limit = 100) { this.limit = limit; this.undoStack = []; this.redoStack = []; }
  execute(command) { command.do(); this.undoStack.push(command); if (this.undoStack.length > this.limit) this.undoStack.shift(); this.redoStack.length = 0; return command; }
  undo() { const command = this.undoStack.pop(); if (!command) return false; command.undo(); this.redoStack.push(command); return true; }
  redo() { const command = this.redoStack.pop(); if (!command) return false; command.do(); this.undoStack.push(command); return true; }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
}
export class MutationCommand {
  constructor(target, key, next, label = 'mutation') { this.target = target; this.key = key; this.next = clone(next); this.previous = clone(target[key]); this.label = label; }
  do() { this.target[this.key] = clone(this.next); }
  undo() { this.target[this.key] = clone(this.previous); }
}
function findContainer(root, node) { if (root.children?.includes(node)) return root; for (const child of root.children || []) { const found = findContainer(child, node); if (found) return found; } return null; }
function reversible(doAction, undoAction, label) { return { label, do: doAction, undo: undoAction }; }
export const commands = {
  addLayer(scene, node, index = scene.root.children.length) {
    if (!node || !node.tag || !node.attrs) throw new Error('Node layer tidak valid');
    const layer = decorateLayer(node); if (!layer.id || scene.layers.some(l => l.id === layer.id)) throw new Error('ID layer harus unik');
    return reversible(() => { scene.root.children.splice(index, 0, node); scene.layers.splice(index, 0, layer); }, () => { scene.root.children.splice(scene.root.children.indexOf(node), 1); scene.layers.splice(scene.layers.indexOf(layer), 1); }, 'add layer');
  },
  removeLayer(scene, id) {
    const layer = scene.layers.find(l => l.id === id); if (!layer) throw new Error('Layer tidak ditemukan');
    const parent = findContainer(scene.root, layer.node); if (!parent) throw new Error('Parent layer tidak ditemukan');
    const nodeIndex = parent.children.indexOf(layer.node), index = scene.layers.indexOf(layer);
    return reversible(() => { parent.children.splice(nodeIndex, 1); scene.layers.splice(index, 1); }, () => { parent.children.splice(nodeIndex, 0, layer.node); scene.layers.splice(index, 0, layer); }, 'remove layer');
  },
  setLayerAttribute(layer, key, value) {
    const previous = layer.attrs[key];
    const apply = v => { if (v == null) delete layer.attrs[key]; else layer.attrs[key] = String(v); layer[key] = key === 'startTime' || key === 'endTime' ? finite(v) : v; };
    return reversible(() => apply(value), () => apply(previous), 'set layer attribute');
  },
  setProperty(layer, key, value) {
    const prop = layer.properties[key]; if (!prop) throw new Error('Property tidak ditemukan: ' + key);
    const previous = clone(prop.value);
    const apply = v => { prop.value = clone(v); prop.node.attrs.value = Array.isArray(v) ? v.join(',') : String(v); prop.attrs = prop.node.attrs; };
    return reversible(() => apply(value), () => apply(previous), 'set property');
  },
  setKeyframe(property, index, frame) {
    const previous = property.keyframes[index]; if (!previous) throw new Error('Keyframe tidak ditemukan');
    const node = property.node.children.filter(c => c.tag === 'kf')[index];
    const apply = v => { const k = clone(v); property.keyframes[index] = k; node.attrs.t = String(k.t); node.attrs.v = Array.isArray(k.v) ? k.v.join(',') : String(k.v); if (k.easing == null) delete node.attrs.e; else node.attrs.e = k.easing; };
    return reversible(() => apply(frame), () => apply(previous), 'set keyframe');
  },
  addEffect(layer, effect) {
    const entry = clone(effect); entry.node = { tag: 'effect', attrs: { ...effect }, children: [], text: '' };
    return reversible(() => { layer.effects.push(entry); layer.node.children.push(entry.node); }, () => { layer.effects.splice(layer.effects.indexOf(entry), 1); layer.node.children.splice(layer.node.children.indexOf(entry.node), 1); }, 'add effect');
  },
  removeEffect(layer, index) {
    const effect = layer.effects[index]; if (!effect) throw new Error('Effect tidak ditemukan');
    const nodeIndex = layer.node.children.indexOf(effect.node);
    return reversible(() => { layer.effects.splice(index, 1); layer.node.children.splice(layer.node.children.indexOf(effect.node), 1); }, () => { layer.effects.splice(index, 0, effect); layer.node.children.splice(nodeIndex, 0, effect.node); }, 'remove effect');
  }
};
export function serializeScene(scene, serializer = globalThis.XMLSerializer, implementation = globalThis.document?.implementation) {
  if (!serializer || !implementation) throw new Error('XMLSerializer dan DOM document diperlukan');
  const doc = implementation.createDocument('', '', null); const root = nodeToElement(scene.root, doc); doc.appendChild(root); return new serializer().serializeToString(doc);
}
export function createEditor() { return { history: new CommandHistory(), parse: parseSceneXml, evaluate: evaluateKeyframes, resolveParent: resolveParentTransform, evaluateTransform: evaluateSceneTransform, serialize: serializeScene }; }

const api = { AM_TIME, parseSceneXml, createSceneModel, evaluateKeyframes, resolveParentTransform, evaluateSceneTransform, CommandHistory, MutationCommand, commands, serializeScene, createEditor };
if (typeof window !== 'undefined') window.AMEditor = Object.assign(window.AMEditor || {}, api, { createEditor });
if (typeof globalThis !== 'undefined') globalThis.AMEditor = Object.assign(globalThis.AMEditor || {}, api);
