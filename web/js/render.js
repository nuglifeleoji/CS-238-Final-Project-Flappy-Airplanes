/* Canvas renderer for Flappy Airplanes. Logical resolution 960x540, scaled for DPR. */
(function () {
  const W = 960, H = 540;
  const GROUND_Y = 474;     // top of the ground band (altitude 0)
  const TOP_Y = 18;         // altitude Y (ceiling)
  const SW = 9;             // pixels per slot
  const PLANE_SX = 200;     // plane screen x
  const TW = 1920;          // width of tileable background strips
  const CAP_H = 15;

  // ---------------------------------------------------------------- utils
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(n) {
    let x = (n | 0) * 374761393 + 668265263;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }
  function makeCanvas(w, h, s = 2) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * s); c.height = Math.ceil(h * s);
    const ctx = c.getContext('2d');
    ctx.scale(s, s);
    return [c, ctx];
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------------------------------------------------------------- themes
  const THEMES = {
    day: {
      sky: ['#4fb9ee', '#8fd6f5', '#d8f2fb'],
      sun: { x: 770, y: 92, r: 34, core: '#fff7d1', glow: 'rgba(255,244,190,0.55)' },
      far: { kind: 'hills', color: '#a5d9cf', base: 120, amp: 38 },
      mid: { kind: 'trees', color: '#6dbf8f', dark: '#58a97a', base: 62 },
      cloud: ['#ffffff', '#e3f1f8'], cloudAlpha: 0.96,
      pillar: { light: '#ffa77f', base: '#ef7350', dark: '#c04a2f', outline: '#5c2416',
                cap: '#ff8a5f', capDark: '#d65a3a', detail: 'bands' },
      ground: { grass: '#8ad85f', stripe: '#74c44c', edge: '#3c7a28', dirt: '#ecd49c', dirtDark: '#d9bb7d' },
      fog: [220, 242, 252], ceiling: 'rgba(20,60,100,0.10)', trail: 'rgba(255,255,255,',
    },
    sunset: {
      sky: ['#2a2b6b', '#7c3f86', '#e0627a', '#ffb36b'],
      sun: { x: 690, y: 330, r: 58, core: '#ffd28a', glow: 'rgba(255,150,90,0.55)' },
      far: { kind: 'mountains', color: '#8b4f86', base: 150, amp: 95 },
      mid: { kind: 'hills', color: '#55356e', base: 70, amp: 26 },
      cloud: ['#ffc2a8', '#f08e93'], cloudAlpha: 0.85,
      pillar: { light: '#9c8cff', base: '#6253e0', dark: '#3b2fa3', outline: '#170f4a',
                cap: '#7b6dff', capDark: '#4b3dc4', detail: 'gold' },
      ground: { grass: '#b3a94c', stripe: '#9a9140', edge: '#4d4620', dirt: '#cf9361', dirtDark: '#b57a4c' },
      fog: [255, 196, 160], ceiling: 'rgba(40,10,60,0.18)', trail: 'rgba(255,230,210,',
    },
    night: {
      sky: ['#050816', '#0f1640', '#283a7a'],
      moon: { x: 760, y: 88, r: 26 }, stars: true,
      far: { kind: 'skyline', color: '#151d48', window: 'rgba(255,214,120,0.28)', base: 160 },
      mid: { kind: 'skyline', color: '#0c1230', window: 'rgba(255,220,140,0.45)', base: 100 },
      cloud: ['#4a5a9c', '#33407a'], cloudAlpha: 0.35,
      pillar: { light: '#3d5ea8', base: '#253f80', dark: '#152452', outline: '#04071a',
                cap: '#2f56a8', capDark: '#1b3470', detail: 'windows', neon: '#4cc9f0' },
      ground: { grass: '#2e6a50', stripe: '#265a44', edge: '#0f2419', dirt: '#3a3452', dirtDark: '#2d2842' },
      fog: [16, 24, 64], ceiling: 'rgba(0,0,0,0.25)', trail: 'rgba(190,210,255,',
    },
    storm: {
      sky: ['#171923', '#2d3244', '#525a70'],
      far: { kind: 'jagged', color: '#363b4d', base: 150, amp: 80 },
      mid: { kind: 'jagged', color: '#262a36', base: 80, amp: 40 },
      cloud: ['#4b5064', '#3a3e4f'], cloudAlpha: 0.92, rain: true, lightning: true,
      pillar: { light: '#8c93a3', base: '#666d7d', dark: '#424856', outline: '#121419',
                cap: '#ffd60a', capDark: '#22252b', detail: 'hazard' },
      ground: { grass: '#52704a', stripe: '#46623f', edge: '#1c2819', dirt: '#5e5548', dirtDark: '#4c4439' },
      fog: [70, 76, 96], ceiling: 'rgba(0,0,0,0.25)', trail: 'rgba(210,215,225,',
    },
  };

  // ---------------------------------------------------------------- static layers
  function buildSky(th) {
    const [c, ctx] = makeCanvas(W, GROUND_Y + 4, 1.5);
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    th.sky.forEach((col, i) => g.addColorStop(i / (th.sky.length - 1), col));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, GROUND_Y + 4);
    const rnd = mulberry32(7);
    if (th.stars) {
      for (let i = 0; i < 190; i++) {
        const x = rnd() * W, y = rnd() * GROUND_Y * 0.8, r = 0.4 + rnd() * 1.2;
        ctx.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.7})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (th.sun) {
      const s = th.sun;
      const rg = ctx.createRadialGradient(s.x, s.y, s.r * 0.6, s.x, s.y, s.r * 4);
      rg.addColorStop(0, s.glow); rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, GROUND_Y);
      ctx.fillStyle = s.core;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    if (th.moon) {
      const m = th.moon;
      const rg = ctx.createRadialGradient(m.x, m.y, m.r, m.x, m.y, m.r * 5);
      rg.addColorStop(0, 'rgba(200,215,255,0.35)'); rg.addColorStop(1, 'rgba(200,215,255,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, W, GROUND_Y);
      ctx.fillStyle = '#f4f1de';
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(180,180,170,0.35)';
      [[-8, -6, 5], [6, 4, 7], [-4, 10, 3.5]].forEach(([dx, dy, r]) => {
        ctx.beginPath(); ctx.arc(m.x + dx, m.y + dy, r, 0, Math.PI * 2); ctx.fill();
      });
    }
    return c;
  }

  function buildStrip(spec, seed) {
    const h = 300;
    const [c, ctx] = makeCanvas(TW, h, 1);
    const rnd = mulberry32(seed);
    const comps = [];
    for (let i = 0; i < 5; i++) comps.push([rnd(), 1 + Math.floor(rnd() * (i + 1) * 3), rnd() * Math.PI * 2]);
    const ridge = (x) => {
      let v = 0, n = 0;
      for (const [a, k, ph] of comps) {
        const s = Math.sin((Math.PI * k * x) / TW + ph);
        v += spec.kind === 'mountains' || spec.kind === 'jagged' ? a * (1 - Math.abs(s)) : a * Math.sin((2 * Math.PI * k * x) / TW + ph);
        n += a;
      }
      return v / n;
    };
    ctx.fillStyle = spec.color;
    if (spec.kind === 'hills' || spec.kind === 'mountains' || spec.kind === 'jagged') {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= TW; x += 4) {
        let r = ridge(x);
        if (spec.kind === 'jagged') r += 0.08 * Math.sin((2 * Math.PI * 48 * x) / TW) + 0.05 * Math.sin((2 * Math.PI * 97 * x) / TW);
        const y = h - spec.base - spec.amp * (spec.kind === 'hills' ? r : r * 1.4 - 0.4);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(TW, h); ctx.closePath(); ctx.fill();
      if (spec.kind === 'mountains') {           // snowy rim light
        ctx.globalAlpha = 0.18; ctx.fillStyle = '#ffd9c2';
        ctx.beginPath(); ctx.moveTo(0, h);
        for (let x = 0; x <= TW; x += 4) ctx.lineTo(x, h - spec.base - spec.amp * (ridge(x) * 1.4 - 0.4) + 6);
        ctx.lineTo(TW, h); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      }
    } else if (spec.kind === 'trees') {
      ctx.fillRect(0, h - spec.base + 18, TW, spec.base);
      for (let x = 0; x < TW; x += 14) {
        const r = 14 + 12 * hash(x * 7 + seed);
        ctx.fillStyle = hash(x + seed) > 0.5 ? spec.color : spec.dark;
        const cx = x, cy = h - spec.base + 22 - r * 0.6 - 10 * Math.sin((2 * Math.PI * 3 * x) / TW);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        if (cx < r) { ctx.beginPath(); ctx.arc(cx + TW, cy, r, 0, Math.PI * 2); ctx.fill(); }
        if (cx > TW - r) { ctx.beginPath(); ctx.arc(cx - TW, cy, r, 0, Math.PI * 2); ctx.fill(); }
      }
    } else if (spec.kind === 'skyline') {
      let x = 0;
      while (x < TW) {
        let w = 34 + Math.floor(rnd() * 60);
        if (TW - x - w < 34) w = TW - x;
        const bh = spec.base * (0.45 + rnd() * 0.75);
        ctx.fillStyle = spec.color;
        ctx.fillRect(x, h - bh, w - 3, bh);
        if (rnd() < 0.3) ctx.fillRect(x + w / 2 - 2, h - bh - 14, 3, 14);       // antenna
        ctx.fillStyle = spec.window;
        for (let wy = h - bh + 8; wy < h - 6; wy += 11) {
          for (let wx = x + 5; wx < x + w - 9; wx += 9) {
            if (rnd() < 0.22) ctx.fillRect(wx, wy, 4, 5);
          }
        }
        x += w;
      }
    }
    return { canvas: c, h };
  }

  function buildCloudSprites(th) {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const rnd = mulberry32(100 + k);
      const w = 150 + rnd() * 90, h = 70;
      const [c, ctx] = makeCanvas(w, h, 2);
      const blobs = [];
      const n = 4 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        blobs.push([w * (0.15 + 0.7 * t), h * 0.62 - Math.sin(t * Math.PI) * (12 + rnd() * 14), 16 + Math.sin(t * Math.PI) * (12 + rnd() * 10)]);
      }
      ctx.fillStyle = th.cloud[1];
      blobs.forEach(([x, y, r]) => { ctx.beginPath(); ctx.arc(x, y + 4, r, 0, Math.PI * 2); ctx.fill(); });
      rr(ctx, w * 0.1, h * 0.55, w * 0.8, h * 0.3, h * 0.15); ctx.fill();
      ctx.fillStyle = th.cloud[0];
      blobs.forEach(([x, y, r]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); });
      rr(ctx, w * 0.1, h * 0.5, w * 0.8, h * 0.28, h * 0.14); ctx.fill();
      out.push({ canvas: c, w, h });
    }
    return out;
  }

  function buildFuelSprite() {
    const S = 40;
    const [c, ctx] = makeCanvas(S, S, 3);
    const cx = S / 2, cy = S / 2 + 2;
    const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, S / 2);
    glow.addColorStop(0, 'rgba(255,200,70,0.55)');
    glow.addColorStop(1, 'rgba(255,170,40,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, S, S);
    // droplet
    ctx.beginPath();
    ctx.moveTo(cx, cy - 11);
    ctx.bezierCurveTo(cx + 3, cy - 6, cx + 7, cy - 2, cx + 7, cy + 2.5);
    ctx.arc(cx, cy + 2.5, 7, 0, Math.PI, false);
    ctx.bezierCurveTo(cx - 7, cy - 2, cx - 3, cy - 6, cx, cy - 11);
    ctx.closePath();
    const fill = ctx.createRadialGradient(cx - 2, cy, 1, cx, cy + 2, 10);
    fill.addColorStop(0, '#fff3b0'); fill.addColorStop(0.45, '#ffc533'); fill.addColorStop(1, '#f2840c');
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = '#8a3d00'; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.ellipse(cx - 2.6, cy + 0.5, 1.6, 3, -0.3, 0, Math.PI * 2); ctx.fill();
    return { canvas: c, S };
  }

  // ---------------------------------------------------------------- plane
  function drawPlane(ctx, t, opts = {}) {
    const outline = '#1f2235';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = outline;
    // tail fin
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.moveTo(-17, -3); ctx.lineTo(-23, -14); ctx.lineTo(-15, -14); ctx.lineTo(-7, -4); ctx.closePath();
    ctx.fill(); ctx.stroke();
    // body
    ctx.fillStyle = '#fbf6ea';
    ctx.beginPath();
    ctx.moveTo(-22, -3.5);
    ctx.quadraticCurveTo(-8, -9.5, 7, -7.5);
    ctx.quadraticCurveTo(17, -6.5, 18.5, 0);
    ctx.quadraticCurveTo(17, 6.5, 7, 6.5);
    ctx.lineTo(-13, 4.5);
    ctx.quadraticCurveTo(-22, 2.5, -22, -3.5);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // belly shade
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(30,40,80,0.13)'; ctx.fillRect(-24, 2, 46, 8);
    ctx.fillStyle = '#e63946'; ctx.fillRect(-24, -1.2, 46, 2.6);
    ctx.restore();
    // window
    ctx.fillStyle = '#86d8ff';
    ctx.beginPath();
    ctx.moveTo(3.5, -7); ctx.quadraticCurveTo(10.5, -7.2, 13, -2.4); ctx.lineTo(3.5, -2.4); ctx.closePath();
    ctx.fill(); ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(5, -6, 2, 2.6);
    // stabilizer
    ctx.lineWidth = 1.4;
    ctx.fillStyle = '#c62f3b'; rr(ctx, -24, -2.4, 11, 4, 2); ctx.fill(); ctx.stroke();
    // wing
    ctx.fillStyle = '#e63946'; rr(ctx, -7, 1, 17, 5.5, 2.75); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; rr(ctx, -5, 1.8, 12, 1.4, 0.7); ctx.fill();
    // nose + propeller
    ctx.fillStyle = '#ffc533';
    ctx.beginPath(); ctx.ellipse(18.3, 0, 2.8, 3.6, 0, 0, Math.PI * 2); ctx.fill(); ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.ellipse(21, 0, 2.2, 12, 0, 0, Math.PI * 2); ctx.fill();
    const ph = Math.abs(Math.sin(t * 55));
    ctx.fillStyle = 'rgba(40,40,55,0.75)';
    ctx.beginPath(); ctx.ellipse(21, 0, 1.3, 1.5 + 10.5 * ph, 0, 0, Math.PI * 2); ctx.fill();
    // nav light
    if (opts.navLight && Math.sin(t * 6) > 0.6) {
      ctx.fillStyle = '#ff4d6d';
      ctx.beginPath(); ctx.arc(-20, -14, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,77,109,0.35)';
      ctx.beginPath(); ctx.arc(-20, -14, 6, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- renderer
  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cfg = { Y: 100, D: 40, r: 4, u: 3.5 };
      this.time = 0;
      this.particles = [];
      this.floaters = [];
      this.shake = 0;
      this.flash = 0;
      this.nextLightning = 3;
      this.cache = {};
      this.fuelSprite = buildFuelSprite();
      this.clouds = [];
      const rnd = mulberry32(42);
      for (let i = 0; i < 16; i++) {
        this.clouds.push({ x: rnd() * 2600, y: 30 + rnd() * 250, s: 0.45 + rnd() * 0.7, k: i % 4, par: rnd() < 0.5 ? 0.18 : 0.32 });
      }
      this.clouds.sort((a, b) => a.par - b.par);
      this.setTheme('day');
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas);
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(320, Math.round(rect.width * dpr));
      this.canvas.width = w;
      this.canvas.height = Math.round((w * H) / W);
      this.scale = this.canvas.width / W;
    }

    setConfig(cfg) { this.cfg = Object.assign({}, this.cfg, cfg); }

    setTheme(name) {
      if (!THEMES[name]) name = 'day';
      this.themeName = name;
      this.th = THEMES[name];
      if (!this.cache[name]) {
        this.cache[name] = {
          sky: buildSky(this.th),
          far: buildStrip(this.th.far, 11 + name.length),
          mid: buildStrip(this.th.mid, 23 + name.length * 3),
          clouds: buildCloudSprites(this.th),
        };
      }
      this.layers = this.cache[name];
    }

    alt(a) { return GROUND_Y - (a * (GROUND_Y - TOP_Y)) / this.cfg.Y; }
    get unit() { return (GROUND_Y - TOP_Y) / this.cfg.Y; }

    // ---------------- effects (positions in slot units / altitude units)
    flapPuff(xf, y, angle) {
      const wx = xf * SW, sy = this.alt(y);
      const tx = wx - Math.cos(angle) * 20, ty = sy - Math.sin(angle) * 20;
      for (let i = 0; i < 6; i++) {
        this.particles.push({ type: 'smoke', x: tx + (Math.random() - 0.5) * 4, y: ty + (Math.random() - 0.5) * 6,
          vx: -40 - Math.random() * 50, vy: 20 + Math.random() * 40, life: 0.6, max: 0.6, r: 2.5 + Math.random() * 2.5 });
      }
    }
    trail(xf, y, angle) {
      const wx = xf * SW, sy = this.alt(y);
      this.particles.push({ type: 'trail', x: wx - Math.cos(angle) * 21, y: sy - Math.sin(angle) * 21,
        vx: 0, vy: 0, life: 0.9, max: 0.9, r: 1.6 + Math.random() });
    }
    pickup(slot, fy) {
      const wx = slot * SW, sy = this.alt(fy);
      this.particles.push({ type: 'ring', x: wx, y: sy, vx: 0, vy: 0, life: 0.45, max: 0.45, r: 6 });
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        this.particles.push({ type: 'spark', x: wx, y: sy, vx: Math.cos(a) * 130, vy: Math.sin(a) * 130,
          life: 0.5, max: 0.5, r: 2.2, g: 200 });
      }
      this.floaters.push({ x: wx, y: sy - 12, text: '+1', life: 0.9, max: 0.9 });
    }
    explode(xf, y) {
      const wx = xf * SW, sy = this.alt(y);
      this.shake = 1;
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 200;
        this.particles.push({ type: 'fire', x: wx, y: sy, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40,
          life: 0.5 + Math.random() * 0.5, max: 1, r: 4 + Math.random() * 7, g: 120 });
      }
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 160;
        this.particles.push({ type: 'debris', x: wx, y: sy, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120,
          life: 1.4, max: 1.4, r: 2 + Math.random() * 3, g: 520, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 20,
          color: ['#e63946', '#fbf6ea', '#ffc533', '#1f2235'][i % 4] });
      }
      for (let i = 0; i < 10; i++) {
        this.particles.push({ type: 'smoke', x: wx + (Math.random() - 0.5) * 20, y: sy + (Math.random() - 0.5) * 20,
          vx: (Math.random() - 0.5) * 40, vy: -30 - Math.random() * 40, life: 1.6, max: 1.6, r: 8 + Math.random() * 8, dark: true });
      }
    }
    clearEffects() { this.particles = []; this.floaters = []; this.shake = 0; }

    update(dt) {
      this.time += dt;
      for (const p of this.particles) {
        p.life -= dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.g) p.vy += p.g * dt;
        if (p.type === 'smoke') { p.vx *= 0.96; p.vy *= 0.96; p.r += dt * 10; }
        if (p.rot !== undefined) p.rot += p.vr * dt;
        if (p.type === 'debris' && p.y > GROUND_Y - 2) { p.y = GROUND_Y - 2; p.vy *= -0.35; p.vx *= 0.7; }
      }
      this.particles = this.particles.filter((p) => p.life > 0);
      for (const f of this.floaters) { f.life -= dt; f.y -= 34 * dt; }
      this.floaters = this.floaters.filter((f) => f.life > 0);
      this.shake = Math.max(0, this.shake - dt * 2.2);
      this.flash = Math.max(0, this.flash - dt * 2.5);
      if (this.th.lightning) {
        this.nextLightning -= dt;
        if (this.nextLightning <= 0) { this.flash = 1; this.nextLightning = 4 + Math.random() * 7; }
      }
    }

    // ---------------- main draw
    /* view: {course, xf, y, v, angle, fuel, collected:Set, showPlane, sensors, reveal, g} */
    draw(view) {
      const ctx = this.ctx;
      const th = this.th;
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      const xf = view ? view.xf : this.time * 6;
      const camX = xf * SW - PLANE_SX;
      const course = view && view.course;
      const D = this.cfg.D;
      const horizonX = PLANE_SX + D * SW + SW / 2;

      ctx.save();
      if (this.shake > 0) {
        const m = 9 * this.shake * this.shake;
        ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
      }

      // sky + parallax
      ctx.drawImage(this.layers.sky, 0, 0, W, GROUND_Y + 4);
      this.drawStrip(this.layers.far, camX * 0.1);
      this.drawClouds(camX, 0.25);
      this.drawStrip(this.layers.mid, camX * 0.28);
      this.drawClouds(camX, 1);

      // terrain
      if (course) {
        ctx.save();
        if (!view.reveal) { ctx.beginPath(); ctx.rect(-20, -20, horizonX + 20, H + 40); ctx.clip(); }
        this.drawObstacles(course, camX);
        ctx.restore();
      }
      this.drawCeiling(camX);
      this.drawGround(camX);
      if (course) {
        ctx.save();
        if (!view.reveal) { ctx.beginPath(); ctx.rect(-20, -20, horizonX + 20, H + 40); ctx.clip(); }
        this.drawFinish(course, camX);
        this.drawFuel(course, camX, view.collected, xf);
        ctx.restore();
      }

      if (th.rain) this.drawRain(camX);

      // fog of war beyond the horizon
      if (course) this.drawFog(horizonX, view.reveal);
      if (course && view.sensors) this.drawSensors(view, camX, horizonX);

      this.drawParticles(camX, false);
      if (view && view.showPlane) {
        ctx.save();
        ctx.translate(PLANE_SX, this.alt(view.y));
        ctx.rotate(view.angle || 0);
        ctx.scale(1.12, 1.12);
        drawPlane(ctx, this.time, { navLight: this.themeName === 'night' || this.themeName === 'storm' });
        ctx.restore();
      }
      this.drawParticles(camX, true);
      this.drawFloaters(camX);

      if (this.flash > 0) {
        ctx.fillStyle = `rgba(230,235,255,${0.45 * this.flash * this.flash})`;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();

      // vignette
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 0.95);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    }

    drawStrip(strip, offset) {
      const ctx = this.ctx;
      const x0 = -(((offset % TW) + TW) % TW);
      const y = GROUND_Y + 2 - strip.h;
      ctx.drawImage(strip.canvas, x0, y, TW, strip.h);
      if (x0 + TW < W) ctx.drawImage(strip.canvas, x0 + TW, y, TW, strip.h);
    }

    drawClouds(camX, which) {
      const ctx = this.ctx;
      const sprites = this.layers.clouds;
      const CW = 2600;
      ctx.globalAlpha = this.th.cloudAlpha;
      for (const c of this.clouds) {
        if ((which < 1 && c.par > 0.2) || (which >= 1 && c.par < 0.2)) continue;
        const sp = sprites[c.k];
        const drift = this.time * 4 * c.par;
        let x = (((c.x - camX * c.par - drift) % CW) + CW) % CW - 250;
        if (x > W) continue;
        ctx.drawImage(sp.canvas, x, c.y, sp.w * c.s, sp.h * c.s);
      }
      ctx.globalAlpha = 1;
    }

    drawCeiling(camX) {
      const ctx = this.ctx;
      const g = ctx.createLinearGradient(0, 0, 0, TOP_Y + 6);
      g.addColorStop(0, this.th.ceiling.replace(/[\d.]+\)$/, '0.55)'));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, TOP_Y + 6);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 8]);
      ctx.lineDashOffset = camX % 18;
      ctx.beginPath(); ctx.moveTo(0, TOP_Y); ctx.lineTo(W, TOP_Y); ctx.stroke();
      ctx.restore();
    }

    drawGround(camX) {
      const ctx = this.ctx;
      const gr = this.th.ground;
      const gh = 16;
      ctx.fillStyle = gr.dirt;
      ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
      // pebbles (world anchored)
      ctx.fillStyle = gr.dirtDark;
      const c0 = Math.floor(camX / 34) - 1;
      for (let i = c0; i < c0 + W / 34 + 3; i++) {
        const x = i * 34 + hash(i) * 30 - camX;
        const y = GROUND_Y + gh + 10 + hash(i * 3 + 1) * (H - GROUND_Y - gh - 18);
        const r = 1.5 + hash(i * 7 + 2) * 3;
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.6, r, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = gr.grass;
      ctx.fillRect(0, GROUND_Y, W, gh);
      ctx.fillStyle = gr.stripe;
      const per = 26;
      const off = -(((camX % per) + per) % per);
      for (let x = off - per; x < W + per; x += per) {
        ctx.beginPath();
        ctx.moveTo(x, GROUND_Y + gh); ctx.lineTo(x + 12, GROUND_Y + gh);
        ctx.lineTo(x + 12 + gh * 0.7, GROUND_Y); ctx.lineTo(x + gh * 0.7, GROUND_Y);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(0, GROUND_Y + 1, W, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(0, GROUND_Y + gh, W, 4);
      ctx.fillStyle = gr.edge; ctx.fillRect(0, GROUND_Y - 1.5, W, 2.5);
    }

    drawObstacles(course, camX) {
      const p = this.th.pillar;
      for (let i = 0; i < course.obstacles.length; i++) {
        const [x0, x1, lo, hi] = course.obstacles[i];
        const left = x0 * SW - SW / 2 - camX;
        const width = (x1 - x0 + 1) * SW;
        if (left > W + 10 || left + width < -10) continue;
        if (lo > 0.01) this.drawPillar(left, width, this.alt(lo), GROUND_Y + 4, 'top', p, i * 2);
        if (hi < this.cfg.Y - 0.01) this.drawPillar(left, width, -6, this.alt(hi), 'bottom', p, i * 2 + 1);
      }
    }

    drawPillar(left, width, top, bottom, capEnd, p, seed) {
      const ctx = this.ctx;
      const h = bottom - top;
      if (h <= 0) return;
      const g = ctx.createLinearGradient(left, 0, left + width, 0);
      g.addColorStop(0, p.light); g.addColorStop(0.32, p.base); g.addColorStop(0.7, p.base); g.addColorStop(1, p.dark);
      ctx.fillStyle = g;
      ctx.fillRect(left, top, width, h);
      // body detail
      ctx.save();
      ctx.beginPath(); ctx.rect(left, top, width, h); ctx.clip();
      const edge = capEnd === 'top' ? top : bottom;
      const dir = capEnd === 'top' ? 1 : -1;
      if (p.detail === 'bands') {
        ctx.fillStyle = 'rgba(255,240,225,0.22)';
        for (let k = CAP_H + 14; k < h + 30; k += 28) ctx.fillRect(left, edge + dir * k - 2, width, 4);
      } else if (p.detail === 'gold') {
        ctx.fillStyle = 'rgba(255,205,130,0.35)';
        ctx.fillRect(left + width * 0.22, top, 2, h);
        for (let k = CAP_H + 22; k < h + 30; k += 44) ctx.fillRect(left, edge + dir * k - 1, width, 2);
      } else if (p.detail === 'windows') {
        const cols = Math.max(1, Math.floor((width - 6) / 10));
        const padX = (width - cols * 10 + 4) / 2;
        let row = 0;
        for (let k = CAP_H + 8; k < h; k += 13, row++) {
          for (let c = 0; c < cols; c++) {
            const lit = hash(seed * 977 + row * 31 + c) > 0.55;
            ctx.fillStyle = lit ? 'rgba(255,209,102,0.9)' : 'rgba(10,20,50,0.55)';
            ctx.fillRect(left + padX + c * 10, edge + dir * k - (dir < 0 ? 7 : 0), 6, 7);
          }
        }
      } else if (p.detail === 'hazard') {
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        for (let k = CAP_H + 16; k < h + 30; k += 32) ctx.fillRect(left, edge + dir * k - 3, width, 6);
      }
      ctx.restore();
      ctx.strokeStyle = p.outline;
      ctx.lineWidth = 2;
      ctx.strokeRect(left + 1, top, width - 2, h);
      if (p.neon) {
        ctx.save();
        ctx.strokeStyle = p.neon; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.4;
        ctx.shadowColor = p.neon; ctx.shadowBlur = 8;
        ctx.strokeRect(left + 2.5, top, width - 5, h);
        ctx.restore();
      }
      // cap facing the gap
      const capH = Math.min(CAP_H, h);
      const cy = capEnd === 'top' ? top : bottom - capH;
      const cl = left - 3, cw = width + 6;
      if (p.detail === 'hazard') {
        ctx.save();
        rr(ctx, cl, cy, cw, capH, 2); ctx.clip();
        ctx.fillStyle = p.cap; ctx.fillRect(cl, cy, cw, capH);
        ctx.fillStyle = p.capDark;
        for (let s = -capH; s < cw + capH; s += 12) {
          ctx.beginPath();
          ctx.moveTo(cl + s, cy + capH); ctx.lineTo(cl + s + 6, cy + capH);
          ctx.lineTo(cl + s + 6 + capH, cy); ctx.lineTo(cl + s + capH, cy); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      } else {
        const cg = ctx.createLinearGradient(cl, 0, cl + cw, 0);
        cg.addColorStop(0, p.light); cg.addColorStop(0.3, p.cap); cg.addColorStop(1, p.capDark);
        ctx.fillStyle = cg;
        rr(ctx, cl, cy, cw, capH, 3); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(cl + 3, cy + (capEnd === 'top' ? 2 : capH - 4), cw - 6, 2);
      }
      ctx.strokeStyle = p.outline; ctx.lineWidth = 2;
      rr(ctx, cl, cy, cw, capH, 3); ctx.stroke();
      if (p.neon) {
        ctx.strokeStyle = p.neon; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.85;
        const ey = capEnd === 'top' ? cy + 1 : cy + capH - 1;
        ctx.beginPath(); ctx.moveTo(cl + 2, ey); ctx.lineTo(cl + cw - 2, ey); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    drawFuel(course, camX, collected, xf) {
      const ctx = this.ctx;
      const sp = this.fuelSprite;
      const s0 = Math.floor((camX - 40) / SW), s1 = Math.ceil((camX + W + 40) / SW);
      for (const [x, y] of course.fuel) {
        if (x < s0 || x > s1) continue;
        if (collected && collected.has(x) && x <= xf + 0.001) continue;
        const sx = x * SW - camX, sy = this.alt(y);
        const pulse = 1 + 0.07 * Math.sin(this.time * 5 + x);
        const size = sp.S * 0.92 * pulse;
        ctx.drawImage(sp.canvas, sx - size / 2, sy - size / 2 - 1, size, size);
      }
    }

    drawFinish(course, camX) {
      const ctx = this.ctx;
      const x = course.L * SW - camX;
      if (x < -30 || x > W + 30) return;
      const w = 12, sq = 6;
      ctx.save();
      ctx.globalAlpha = 0.85;
      for (let y = TOP_Y, r = 0; y < GROUND_Y; y += sq, r++) {
        for (let c = 0; c < 2; c++) {
          ctx.fillStyle = (r + c) % 2 ? '#1f2235' : '#ffffff';
          ctx.fillRect(x - w / 2 + c * sq, y, sq, Math.min(sq, GROUND_Y - y));
        }
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffc533'; ctx.strokeStyle = '#1f2235'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + w / 2, TOP_Y + 4); ctx.lineTo(x + w / 2 + 28, TOP_Y + 13); ctx.lineTo(x + w / 2, TOP_Y + 22); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    drawRain(camX) {
      const ctx = this.ctx;
      ctx.strokeStyle = 'rgba(190,205,235,0.28)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const span = W + 200;
      for (let i = 0; i < 130; i++) {
        const x = ((((hash(i) * span - this.time * 260 - camX * 0.5) % span) + span) % span) - 100;
        const y = (((hash(i + 999) * H + this.time * (700 + hash(i + 5) * 300)) % H) + H) % H;
        ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 15);
      }
      ctx.stroke();
    }

    drawFog(horizonX, reveal) {
      const ctx = this.ctx;
      const [r, g, b] = this.th.fog;
      const a = reveal ? 0.58 : 0.42;
      const grad = ctx.createLinearGradient(horizonX, 0, horizonX + 70, 0);
      grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},${a})`);
      ctx.fillStyle = grad;
      ctx.fillRect(horizonX, 0, 70, H);
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.fillRect(horizonX + 70, 0, W - horizonX, H);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(horizonX, TOP_Y); ctx.lineTo(horizonX, GROUND_Y - 30); ctx.stroke();
      ctx.restore();
      ctx.font = '600 10px Inter, system-ui, sans-serif';
      const label = `HORIZON · D=${this.cfg.D}`;
      const tw = ctx.measureText(label).width + 14;
      const ly = GROUND_Y - 28;
      ctx.fillStyle = 'rgba(15,20,40,0.55)';
      rr(ctx, horizonX - tw / 2, ly, tw, 18, 9); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, horizonX, ly + 9.5);
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }

    drawSensors(view, camX, horizonX) {
      const ctx = this.ctx;
      const xf = view.xf;
      const course = view.course;
      ctx.save();
      // visible window band
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(PLANE_SX, TOP_Y, horizonX - PLANE_SX, GROUND_Y - TOP_Y);
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.3;
      // safe gaps inside the window
      ctx.strokeStyle = 'rgba(80,255,170,0.9)';
      const xmax = Math.floor(xf) + this.cfg.D;
      for (const [x0, x1, lo, hi] of course.obstacles) {
        if (x1 < xf - 1 || x0 > xmax) continue;
        const left = x0 * SW - SW / 2 - camX, width = (x1 - x0 + 1) * SW;
        ctx.strokeRect(left + 2, this.alt(hi) + 1, width - 4, this.alt(lo) - this.alt(hi) - 2);
      }
      // fuel pickup windows (|y - y_fuel| <= r at that slot)
      ctx.strokeStyle = 'rgba(255,200,60,0.95)';
      ctx.fillStyle = 'rgba(255,200,60,0.12)';
      for (const [x, y] of course.fuel) {
        if (x < xf || x > xmax) continue;
        if (view.collected && view.collected.has(x)) continue;
        const sx = x * SW - camX;
        const top = this.alt(y + this.cfg.r), bot = this.alt(y - this.cfg.r);
        rr(ctx, sx - SW / 2 + 1, top, SW - 2, bot - top, 3); ctx.fill(); ctx.stroke();
      }
      ctx.setLineDash([]);
      // predicted arcs: coast vs flap now
      const g = view.g, u = this.cfg.u;
      const arcs = [['rgba(255,255,255,0.9)', false], ['rgba(255,190,60,0.95)', true]];
      for (const [col, flap] of arcs) {
        if (flap && !(view.fuel >= 1)) continue;
        let y = view.y, v = view.v;
        ctx.fillStyle = col;
        for (let k = 1; k <= 34; k++) {
          v = (flap && k === 1) ? u : v - g;
          y += v;
          if (y <= 0 || y >= this.cfg.Y) break;
          if (k % 2 === 0) {
            ctx.beginPath(); ctx.arc(PLANE_SX + (k - (xf % 1)) * SW, this.alt(y), 1.8, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      // altitude ruler
      ctx.font = '600 9px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      for (let a = 0; a <= this.cfg.Y; a += 25) {
        const y = this.alt(a);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(8, y); ctx.stroke();
        ctx.fillText(String(a), 11, y + 3);
      }
      ctx.restore();
    }

    drawParticles(camX, front) {
      const ctx = this.ctx;
      for (const p of this.particles) {
        const isFront = p.type === 'fire' || p.type === 'spark' || p.type === 'debris' || p.type === 'ring';
        if (isFront !== front) continue;
        const x = p.x - camX, t = p.life / p.max;
        if (p.type === 'smoke' || p.type === 'trail') {
          const base = p.dark ? 'rgba(60,60,70,' : this.th.trail;
          ctx.fillStyle = base + (p.type === 'trail' ? 0.45 * t : 0.6 * t) + ')';
          ctx.beginPath(); ctx.arc(x, p.y, p.r * (p.type === 'trail' ? 1 + (1 - t) * 1.5 : 1), 0, Math.PI * 2); ctx.fill();
        } else if (p.type === 'fire') {
          const c = t > 0.6 ? '255,230,120' : t > 0.3 ? '255,140,40' : '200,60,40';
          ctx.fillStyle = `rgba(${c},${Math.min(1, t * 1.4)})`;
          ctx.beginPath(); ctx.arc(x, p.y, p.r * (0.5 + t * 0.7), 0, Math.PI * 2); ctx.fill();
        } else if (p.type === 'spark') {
          ctx.fillStyle = `rgba(255,214,90,${t})`;
          ctx.beginPath(); ctx.arc(x, p.y, p.r * t + 0.5, 0, Math.PI * 2); ctx.fill();
        } else if (p.type === 'ring') {
          ctx.strokeStyle = `rgba(255,220,120,${t})`; ctx.lineWidth = 2.5 * t + 0.5;
          ctx.beginPath(); ctx.arc(x, p.y, p.r + (1 - t) * 26, 0, Math.PI * 2); ctx.stroke();
        } else if (p.type === 'debris') {
          ctx.save(); ctx.translate(x, p.y); ctx.rotate(p.rot);
          ctx.globalAlpha = Math.min(1, t * 2);
          ctx.fillStyle = p.color; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
          ctx.restore(); ctx.globalAlpha = 1;
        }
      }
    }

    drawFloaters(camX) {
      const ctx = this.ctx;
      ctx.font = '700 16px Fredoka, Inter, sans-serif';
      ctx.textAlign = 'center';
      for (const f of this.floaters) {
        const t = f.life / f.max;
        ctx.globalAlpha = Math.min(1, t * 1.6);
        ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.strokeStyle = '#5a2a00';
        ctx.strokeText(f.text, f.x - camX, f.y);
        ctx.fillStyle = '#ffd34d';
        ctx.fillText(f.text, f.x - camX, f.y);
      }
      ctx.globalAlpha = 1; ctx.textAlign = 'start';
    }
  }

  window.FA = window.FA || {};
  Object.assign(window.FA, { Renderer, THEMES, SW, PLANE_SX, W, H, drawPlane });
})();
