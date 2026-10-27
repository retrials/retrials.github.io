/* Pure input ownership and Gamepad API mapping. No synthetic DOM keys. */
(function (root) {
  'use strict';
  const names = ['Left', 'Down', 'Up', 'Right', 'Start', 'Back', 'Select', 'Coin'];
  const defaults = [
    [{kind:'button',index:14},{kind:'axis',index:0,sign:-1}],
    [{kind:'button',index:13},{kind:'axis',index:1,sign:1}],
    [{kind:'button',index:12},{kind:'axis',index:1,sign:-1}],
    [{kind:'button',index:15},{kind:'axis',index:0,sign:1}],
    [{kind:'button',index:9},{kind:'button',index:0}], [{kind:'button',index:8},{kind:'button',index:1}], [{kind:'button',index:4}], []
  ];
  function validBindings(value) {
    return Array.isArray(value) && value.length === 8 && value.every(row => Array.isArray(row) && row.length <= 4 && row.every(b =>
      b && Number.isInteger(b.index) && b.index >= 0 &&
      ((b.kind === 'button' && b.index < 64) || (b.kind === 'axis' && b.index < 16 && (b.sign === 1 || b.sign === -1)))));
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function router(emit) {
    const sources = new Map(), counts = Array(8).fill(0);
    let enabled = false;
    function set(source, actions) {
      const next = new Set(enabled ? [...actions].filter(a => Number.isInteger(a) && a >= 0 && a < 8) : []);
      const previous = sources.get(source) || new Set();
      for (const a of previous) if (!next.has(a) && --counts[a] === 0) emit(a, false);
      for (const a of next) if (!previous.has(a) && counts[a]++ === 0) emit(a, true);
      if (next.size) sources.set(source, next); else sources.delete(source);
    }
    return {
      set, has: source => sources.has(source),
      clear() { for (const source of [...sources.keys()]) set(source, []); },
      enable(value, sendReleases = true) {
        if (!value && !sendReleases) { sources.clear(); counts.fill(0); }
        else if (!value) this.clear();
        enabled = !!value;
      }
    };
  }
  function active(binding, pad, threshold) {
    if (binding.kind === 'button') {
      const b = pad.buttons[binding.index];
      return !!b && (b.pressed || b.value >= threshold);
    }
    const value = pad.axes[binding.index];
    return Number.isFinite(value) && value * binding.sign >= threshold;
  }
  function gamepad(input) {
    let previousIndex = null, neutralRequired = true;
    return {
      reset() { input.set('gamepad', []); previousIndex = null; neutralRequired = true; },
      poll(pad, bindings, threshold, enabled) {
        if (!enabled || !pad || !pad.connected || !validBindings(bindings)) { this.reset(); return; }
        if ((pad.index + ':' + pad.id) !== previousIndex) { input.set('gamepad', []); neutralRequired = true; previousIndex = pad.index + ':' + pad.id; }
        const held = [];
        bindings.forEach((row, action) => { if (row.some(binding => active(binding, pad, threshold))) held.push(action); });
        if (neutralRequired) { if (!held.length) neutralRequired = false; input.set('gamepad', []); return; }
        input.set('gamepad', held);
      }
    };
  }
  root.OpenITGInputCore = { names, defaults, validBindings, clone, router, gamepad };
})(typeof window !== 'undefined' ? window : globalThis);
