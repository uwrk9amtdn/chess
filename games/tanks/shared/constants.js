// The numbers of the battle, shared by the server's simulation, the
// browser's prediction and the bot. Lengths are in arena pixels, times in
// seconds unless the name says otherwise.

export const MAP_W = 1280;
export const MAP_H = 800;
export const TICK_RATE = 20; // simulation steps, and snapshots, per second

export const TANK_RADIUS = 18;
export const TANK_SPEED = 160; // pixels per second
export const TURRET_TURN_SPEED = Math.PI; // radians per second
export const BARREL_LENGTH = 28;
export const MAX_HP = 3;

export const BULLET_SPEED = 420; // pixels per second, never changes
export const BULLET_RADIUS = 4;
export const MAX_BOUNCES = 1;
export const FIRE_COOLDOWN = 0.5;

// The pause before each round, after one, and how long a round may last
// before the tank with more armour left takes it.
export const COUNTDOWN_MS = 3000;
export const ROUND_OVER_MS = 2500;
export const ROUND_LIMIT_MS = 120_000;

// What a match can be: the best of this many rounds.
export const ROUND_CHOICES = [1, 3, 5];

// One colour per seat.
export const TANK_COLOURS = ['#4caf50', '#2196f3'];
