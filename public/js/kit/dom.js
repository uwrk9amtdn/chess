// Small helpers for building game screens: elements, icons, clocks and
// remembered choices.

export const LOW_TIME_MS = 10_000;

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';

// A 24x24 icon drawn from an SVG path.
export function icon(path) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const shape = document.createElementNS(SVG, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

export const capitalise = (text) => text[0].toUpperCase() + text.slice(1);

const pad = (n) => String(n).padStart(2, '0');

// "04:59", or "00:09.4" in the last seconds.
export function formatClock(ms) {
  if (ms < LOW_TIME_MS) {
    const tenths = Math.floor(ms / 100);
    return `00:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  const seconds = Math.ceil(ms / 1000);
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

// A stylesheet, added to the page once however often it is asked for.
export function loadStylesheet(url) {
  const href = String(url);
  if ([...document.styleSheets].some((s) => s.href === href)) return;
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href }));
}

// Remembered choices. Storage can be unavailable (a private window, blocked
// site data); a choice then lasts until the page closes.
export function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered, then.
  }
}
