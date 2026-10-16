// The arena: its walls, as rectangles, and where each seat's tank starts.

import { MAP_W, MAP_H } from './constants.js';

const BORDER = 20;

// A rectangle in the top-left quarter, and its mirror images in the others.
function mirrored(r) {
  return [
    r,
    { ...r, x: MAP_W - r.x - r.w },
    { ...r, y: MAP_H - r.y - r.h },
    { ...r, x: MAP_W - r.x - r.w, y: MAP_H - r.y - r.h },
  ];
}

export const WALLS = [
  // The outer border.
  { x: 0, y: 0, w: MAP_W, h: BORDER },
  { x: 0, y: MAP_H - BORDER, w: MAP_W, h: BORDER },
  { x: 0, y: 0, w: BORDER, h: MAP_H },
  { x: MAP_W - BORDER, y: 0, w: BORDER, h: MAP_H },
  // L-shaped cover in front of each corner, with gaps to drive out.
  ...mirrored({ x: 90, y: 200, w: 190, h: 20 }),
  ...mirrored({ x: 260, y: 90, w: 20, h: 130 }),
  // Cover in the middle of the field.
  ...mirrored({ x: 420, y: 330, w: 20, h: 140 }),
  ...mirrored({ x: 540, y: 150, w: 200, h: 20 }),
  { x: MAP_W / 2 - 40, y: MAP_H / 2 - 40, w: 80, h: 80 },
].filter(
  // Mirroring a centred rectangle makes copies of it; one is enough.
  (r, i, all) => all.findIndex((o) => o.x === r.x && o.y === r.y && o.w === r.w && o.h === r.h) === i,
);

// Opposite corners, each behind its L of cover, facing the middle.
const corner = (x, y) => ({ x, y, angle: Math.atan2(MAP_H / 2 - y, MAP_W / 2 - x) });
export const SPAWNS = [corner(140, 140), corner(MAP_W - 140, MAP_H - 140)];
