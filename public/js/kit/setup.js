// Pieces for a game's invitation dialog, in the look chess has: a grid of
// time controls with "Custom" at the end, rows of choices, sliders with
// their value in a badge, and the bot's level and side. Each works on a
// `setup` object of the game's own, which it reads and changes in place.

import { el, loadStylesheet } from './dom.js';

loadStylesheet(new URL('./kit.css', import.meta.url));

// A row of buttons of which one is chosen. `choices` are [value, label]
// pairs; `pick(value)` hears each choice. The returned element has
// `select(value)` to change the choice from outside, and `disable(value, on)`.
export function choiceRow(choices, current, pick, className = '') {
  const row = el('div', { className: `kitChoice ${className}`.trim() });
  const buttons = choices.map(([value, label]) => el('button', {
    type: 'button',
    textContent: label,
    onclick: () => {
      pick(value);
      row.select(value);
    },
  }));
  row.append(...buttons);
  row.select = (value) => buttons.forEach((b, i) => b.classList.toggle('selected', choices[i][0] === value));
  row.disable = (value, disabled) => {
    buttons[choices.findIndex(([v]) => v === value)].disabled = disabled;
  };
  row.select(current);
  return row;
}

// A labelled slider over a list of `values` for `setup[key]`, with the value
// in a badge. Returns { node, render }; call render() after changing the
// setup from elsewhere.
export function slider(setup, key, label, values, format = (v) => v) {
  const input = el('input', { type: 'range', min: 0, max: values.length - 1, step: 1 });
  const badge = el('strong');
  const render = () => {
    input.value = Math.max(0, values.indexOf(setup[key]));
    badge.textContent = format(setup[key]);
  };
  input.oninput = () => {
    setup[key] = values[input.value];
    render();
  };
  render();
  return { node: el('label', {}, el('span', {}, `${label} `, badge), input), render };
}

// Sliders side by side, wrapping onto more lines when narrow.
export const sliders = (...nodes) => el('div', { className: 'kitSliders' }, ...nodes);

// The grid of time controls: `tiles` are { title, subtitle, onclick }, and
// the last tile, "Custom", calls `onCustom`.
export function timeTiles(tiles, onCustom) {
  const tile = (onclick, ...children) => el('button', { type: 'button', className: 'kitTimeTile', onclick }, ...children);
  return el('div', { className: 'kitTimes' },
    ...tiles.map(({ title, subtitle, onclick }) => tile(onclick,
      el('strong', { textContent: title }), el('span', { textContent: subtitle }))),
    tile(onCustom, el('span', { textContent: 'Custom' })));
}

// "← Back" and the button that sends the game off.
export function setupActions(onBack, label, onSubmit) {
  return el('div', { className: 'kitSetupActions' },
    el('button', { type: 'button', textContent: '← Back', onclick: onBack }),
    el('button', { type: 'button', className: 'primary', textContent: label, onclick: onSubmit }));
}

// The bot's level (`setup.level`, 1 to `levels`) and the side the player
// takes (`setup.side`, one of `sides`, [value, label] pairs).
export function opponent(setup, levels, sides) {
  const level = el('input', { type: 'range', min: 1, max: levels, step: 1, value: setup.level });
  const badge = el('strong', { textContent: setup.level });
  level.oninput = () => {
    setup.level = Number(level.value);
    badge.textContent = setup.level;
  };
  const row = choiceRow(sides, setup.side, (side) => {
    setup.side = side;
  });
  const node = el('div', { className: 'kitOpponent' }, el('label', {}, el('span', {}, 'Level ', badge), level), row);
  node.sides = row;
  return node;
}

// The whole form: optional choices above the time grid, and behind
// "Custom" the given custom part with Back and the submit button.
export function setupForm(container, { top = [], tiles, custom, submitLabel, onSubmit }) {
  const form = el('div', { className: 'kitSetup', hidden: true }, ...custom,
    setupActions(() => show(false), submitLabel, onSubmit));
  const grid = timeTiles(tiles, () => show(true));
  function show(isCustom) {
    grid.hidden = isCustom;
    form.hidden = !isCustom;
  }
  container.append(...top, grid, form);
}
