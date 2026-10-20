/* Dot drawing of an eye that scans files of machine code while a review
   runs, drawn locally: no images, fonts, network, or model usage. The scene
   is drawn into one small canvas per layer, read back as coverage, and every
   cell of a 156 × 38 grid becomes a dot. */
'use strict';
const scanner = (() => {
  const canvas = document.getElementById('scanner');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const W = 156, H = 38, TAU = Math.PI * 2;
  // Back to front: the topmost layer with something in a cell draws its dot.
  const LAYERS = ['rain', 'belt', 'beam', 'file', 'code', 'lit', 'minor', 'defect', 'flash', 'check', 'scan', 'ray', 'eye', 'iris', 'glint'];
  const L = Object.fromEntries(LAYERS.map((name, i) => [name, i]));
  const layer = LAYERS.map(() => {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round';
    return x;
  });
  const cov = LAYERS.map(() => new Float32Array(W * H));
  const palette = (name, bg, grid, colors) => ({ name, bg, grid, colors: LAYERS.map(n => colors[n] || null) });
  // Night for dark themes, day for light ones, both a little green.
  const PAL = {
    night: palette('night', ['#020b06', '#05150d'], 'rgba(110,255,165,0.06)', {
      rain: '#0d3d24', belt: '#2d6a49', beam: '#2bd774', file: '#3c9e69', code: '#1d5f3b', lit: '#5dff9b', minor: '#ffb547', defect: '#ff5f57',
      flash: '#e4fff0', check: '#7dffb3', scan: '#c2ffdc', ray: '#2a9a5c', eye: '#8dffbf', iris: '#2fe07a', glint: '#f3fff8' }),
    day: palette('day', ['#e3f2e9', '#f4fbf6'], 'rgba(20,90,50,0.07)', {
      rain: '#cde6d7', belt: '#7ea691', beam: '#2fb36a', file: '#2f8a58', code: '#a7ccb7', lit: '#0f8a47', minor: '#c46a00', defect: '#cf222e',
      flash: '#05391e', check: '#0f8a47', scan: '#0a6b37', ray: '#6fae8b', eye: '#0c5530', iris: '#14944e', glint: '#e9fff2' }),
  };
  const theme = () => ['vscode-light', 'vscode-high-contrast-light'].some(name => document.body.classList.contains(name)) ? PAL.day : PAL.night;

  function rng(seed) {
    return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  const ease = t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  // One cycle: the laser crosses the file under the eye, a short pause, the
  // belt brings the next one.
  const SCAN = 2.4, HOLD = .6, MOVE = 1.1, CYCLE = SCAN + HOLD + MOVE;
  const SLOT = 32, FW = 23, FH = 20, FY = 15.5, CX = 78, CY = 7;
  const LINES = 8, LINE0 = FY + 3.5;
  const SCAN_TOP = LINE0 - 1, SCAN_BOTTOM = LINE0 + 2 * (LINES - 1) + 1;
  // data-loop="N" repeats N files so that N cycles loop without a seam, for
  // a recording; the panel leaves it out and every file is new.
  const loop = Math.max(0, Number(canvas.dataset.loop) || 0), PERIOD = loop * CYCLE;
  const wave = speed => loop ? Math.max(1, Math.round(speed * PERIOD / TAU)) * TAU / PERIOD : speed;

  // Each file: its bits, line lengths and a finding or two, from its number.
  const files = new Map();
  function file(number) {
    const n = loop ? ((number % loop) + loop) % loop : number;
    if (!files.has(n)) {
      const R = rng(n * 977 + 13), lines = [];
      for (let i = 0; i < LINES; i++) {
        const length = i === 0 ? 8 : 9 + Math.floor(R() * 9);
        lines.push(Array.from({ length }, (_, j) => j === 8 ? -1 : R() < .55 ? 1 : 0));
      }
      const findings = [], count = R() < .3 ? 0 : R() < .7 ? 1 : 2;
      for (let k = 0; k < count; k++) {
        const line = 1 + Math.floor(R() * (LINES - 1));
        findings.push({ line, bit: Math.floor(R() * Math.min(8, lines[line].length)), kind: R() < .45 ? 'defect' : 'minor' });
      }
      files.set(n, { lines, findings });
      if (files.size > 40) files.delete(files.keys().next().value);
    }
    return files.get(n);
  }
  const RAIN = Array.from({ length: 26 }, (_, i) => {
    const R = rng(i * 31 + 5), len = 3 + Math.floor(R() * 5), span = H + len;
    const speed = 3 + R() * 6;
    return { x: Math.floor(R() * W), y: R() * H, len, v: loop ? Math.max(1, Math.round(speed * PERIOD / span)) * span / PERIOD : speed };
  });
  const DRIFT = wave(.8), FLICKER = wave(3);

  function scene(t) {
    for (const c of layer) c.clearRect(0, 0, W, H);
    const cycle = Math.floor(t / CYCLE), local = t - cycle * CYCLE;
    const scanning = local < SCAN, moving = local >= SCAN + HOLD;
    const progress = clamp(local / SCAN), move = moving ? ease(clamp((local - SCAN - HOLD) / MOVE)) : 0;
    const scanY = SCAN_TOP + (SCAN_BOTTOM - SCAN_TOP) * progress;

    // Far behind: green rain, a column at a time.
    const rain = layer[L.rain];
    for (const drop of RAIN) {
      const head = (drop.y + t * drop.v) % (H + drop.len);
      for (let k = 0; k < drop.len; k++) {
        const y = Math.floor(head) - k;
        if (y < 0 || y >= H) continue;
        rain.globalAlpha = k === 0 ? .55 : .45 - k * .07; rain.fillRect(drop.x, y, 1, 1);
      }
    }
    rain.globalAlpha = 1;

    // The belt: a rail, and rollers that turn while it moves.
    const belt = layer[L.belt], offset = (cycle + move) * SLOT;
    belt.fillRect(0, 36.3, W, .9);
    belt.globalAlpha = .8;
    for (let x = -((offset % 8) + 8); x < W + 8; x += 8) belt.fillRect(x, 37.4, 2, .6);
    belt.globalAlpha = 1;

    // Files on the belt: the one under the eye, those done to its left, those waiting to its right.
    for (let k = -3; k <= 3; k++) {
      const n = cycle + k, fx = CX - FW / 2 + k * SLOT - move * SLOT;
      if (fx > W + 2 || fx + FW < -2) continue;
      const f = file(n), done = k < 0 || (k === 0 && !scanning), here = k === 0;
      const F = layer[L.file];
      F.lineWidth = 1;
      F.beginPath(); F.moveTo(fx + .5, FY + .5); F.lineTo(fx + FW - 4.5, FY + .5); F.lineTo(fx + FW - .5, FY + 4.5);
      F.lineTo(fx + FW - .5, FY + FH - .5); F.lineTo(fx + .5, FY + FH - .5); F.closePath(); F.stroke();
      F.beginPath(); F.moveTo(fx + FW - 4.5, FY + .5); F.lineTo(fx + FW - 4.5, FY + 4.5); F.lineTo(fx + FW - .5, FY + 4.5); F.stroke();
      f.lines.forEach((bits, i) => {
        const y = LINE0 + 2 * i, passed = done || (here && scanY > y + .5);
        bits.forEach((bit, j) => {
          if (bit < 0) return;
          const x = fx + 3 + j, finding = passed && f.findings.find(item => item.line === i && item.bit === j);
          let target = passed ? L.lit : L.code;
          // A finding blinks while its file is under the eye, then stays.
          if (finding) {
            const since = here && scanning ? (scanY - y) / (SCAN_BOTTOM - SCAN_TOP) * SCAN : 1;
            const blink = here && local < SCAN + HOLD && Math.floor((since + local) * 6) % 2;
            target = blink ? L.lit : L[finding.kind];
          }
          const c = layer[target];
          c.globalAlpha = finding || bit ? 1 : .42;
          c.fillRect(x, y, 1, 1);
          // The line the laser is on flashes as it lights up.
          if (here && scanning && Math.abs(scanY - y) < 1.4 && bit) { layer[L.flash].globalAlpha = .9; layer[L.flash].fillRect(x, y, 1, 1); }
        });
      });
      for (const c of [layer[L.code], layer[L.lit], layer[L.minor], layer[L.defect], layer[L.flash]]) c.globalAlpha = 1;
      // A check on files the eye has passed.
      if (done) {
        const appear = here ? clamp((local - SCAN) / .25) : 1;
        if (appear > 0) {
          const C = layer[L.check]; C.lineWidth = 1.1; C.globalAlpha = appear;
          C.beginPath(); C.moveTo(fx + FW - 9, FY + 2.6); C.lineTo(fx + FW - 7.4, FY + 4.2); C.lineTo(fx + FW - 4.8, FY + 1.2); C.stroke();
          C.globalAlpha = 1;
        }
      }
    }

    // The eye: almond lids, an iris that follows the laser, a glint, rays at its sides.
    const blinkAt = SCAN + HOLD * .5, blinkEvery = loop ? loop : 3;
    const blinking = cycle % blinkEvery === blinkEvery - 1 ? Math.max(0, 1 - Math.abs(local - blinkAt) / .11) : 0;
    const open = 1 - .92 * blinking, hw = 15, hh = 5.6 * open;
    const lookAhead = moving ? 2.6 * Math.sin(Math.PI * clamp((local - SCAN - HOLD) / MOVE)) : 0;
    const ix = .6 * Math.sin(t * DRIFT) + lookAhead, iy = scanning ? -.6 + 2 * progress : moving ? 1.4 - 2 * move : 1.4;
    const almond = c => { c.beginPath(); c.moveTo(CX - hw, CY); c.quadraticCurveTo(CX, CY - 2 * hh, CX + hw, CY); c.quadraticCurveTo(CX, CY + 2 * hh, CX - hw, CY); c.closePath(); };
    const E = layer[L.eye]; E.lineWidth = 1.15; almond(E); E.stroke();
    const I = layer[L.iris];
    I.save(); almond(I); I.clip();
    I.beginPath(); I.arc(CX + ix, CY + iy, 4.4, 0, TAU); I.fill();
    I.globalCompositeOperation = 'destination-out'; I.beginPath(); I.arc(CX + ix, CY + iy, 1.9, 0, TAU); I.fill();
    I.restore(); I.globalCompositeOperation = 'source-over';
    if (open > .5) { const G = layer[L.glint]; G.beginPath(); G.arc(CX + ix - 1.5, CY + iy - 1.6, .75, 0, TAU); G.fill(); }
    const R = layer[L.ray]; R.lineWidth = .8;
    for (const side of [-1, 1]) for (const [a, k] of [[-28, 0], [-13, 1], [0, 2], [13, 3], [28, 4]]) {
      const angle = (side < 0 ? 180 - a : a) * Math.PI / 180;
      R.globalAlpha = .45 + .35 * Math.sin(t * FLICKER + k * 1.7 + side);
      R.beginPath(); R.moveTo(CX + Math.cos(angle) * 18, CY - Math.sin(angle) * 6.4); R.lineTo(CX + Math.cos(angle) * 23, CY - Math.sin(angle) * 8.2); R.stroke();
    }
    R.globalAlpha = 1;

    // The laser: a fan from the pupil to a bright line that walks down the file.
    if (scanning && open > .5) {
      const fx = CX - FW / 2, B = layer[L.beam], px = CX + ix, py = CY + iy + 2;
      B.globalAlpha = .17; B.beginPath(); B.moveTo(px, py); B.lineTo(fx + 1, scanY); B.lineTo(fx + FW - 1, scanY); B.closePath(); B.fill();
      B.globalAlpha = .5; B.lineWidth = .55; B.beginPath(); B.moveTo(px, py); B.lineTo(fx + 1, scanY); B.moveTo(px, py); B.lineTo(fx + FW - 1, scanY); B.stroke();
      B.globalAlpha = .3; B.fillRect(fx + 1, scanY - 1.6, FW - 2, 3.2); B.globalAlpha = 1;
      layer[L.scan].fillRect(fx + 1, scanY - .45, FW - 2, .9);
    }

    for (let l = 0; l < LAYERS.length; l++) {
      const data = layer[l].getImageData(0, 0, W, H).data, out = cov[l];
      for (let i = 0; i < W * H; i++) out[i] = data[i * 4 + 3] / 255;
    }
  }

  // Every cell becomes a dot, sized by how much of it its top layer covers.
  let background, backgroundKey;
  function backdropImage(w, h, pal) {
    const key = `${pal.name}:${w}:${h}`;
    if (key === backgroundKey) return background;
    background = document.createElement('canvas'); background.width = w; background.height = h;
    const c = background.getContext('2d'), grad = c.createLinearGradient(0, 0, 0, h), cw = w / W;
    grad.addColorStop(0, pal.bg[0]); grad.addColorStop(1, pal.bg[1]); c.fillStyle = grad; c.fillRect(0, 0, w, h);
    c.fillStyle = pal.grid;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { c.beginPath(); c.arc((x + .5) * cw, (y + .5) * cw, cw * .13, 0, TAU); c.fill(); }
    backgroundKey = key;
    return background;
  }
  function render() {
    const cssWidth = canvas.clientWidth;
    if (!cssWidth) return;
    const pal = theme(), dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(cssWidth * dpr), h = Math.round(w * H / W);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const c = canvas.getContext('2d'), cw = w / W;
    c.drawImage(backdropImage(w, h, pal), 0, 0);
    for (let i = 0; i < W * H; i++) {
      for (let l = LAYERS.length - 1; l >= 0; l--) {
        const k = cov[l][i];
        if (!pal.colors[l] || k <= .1) continue;
        c.fillStyle = pal.colors[l]; c.beginPath();
        c.arc((i % W + .5) * cw, (((i / W) | 0) + .5) * cw, cw * .46 * (.38 + .62 * Math.min(1, k)), 0, TAU); c.fill();
        break;
      }
    }
  }

  let active = false, t = 0, frame, last, drawn = 0;
  // With reduced motion: one still frame, the laser halfway down a file.
  const draw = () => { if (!canvas.clientWidth) return; scene(reducedMotion.matches ? SCAN * .55 : t); render(); };
  const running = () => active && !canvas.hidden && canvas.offsetParent !== null && !document.hidden && !reducedMotion.matches;
  function tick(now) {
    frame = undefined;
    if (!running()) return;
    frame = requestAnimationFrame(tick);
    if (last === undefined) last = now;
    // About 20 frames per second: smooth enough for dots, light on the sidebar.
    if (now - drawn < 48) return;
    t += Math.min(.06, (now - last) / 1000); last = now; drawn = now;
    draw();
  }
  function sync() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined; last = undefined;
    if (!active) return;
    draw();
    if (running()) frame = requestAnimationFrame(tick);
  }
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
  // A theme change switches day and night; a resize redraws at the new width.
  new MutationObserver(() => { if (active) draw(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(() => { if (active) draw(); }).observe(canvas);
  let shown;
  return {
    // Animates only while a review runs; a new review starts with a new file
    // under the eye, returning to Review carries on where it was.
    setActive(next, runId) {
      if (next && runId !== shown) { shown = runId; t = 0; }
      if (next === active) return;
      active = next; sync();
    },
  };
})();
