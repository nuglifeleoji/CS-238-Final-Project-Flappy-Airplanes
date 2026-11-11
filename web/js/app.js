/* App controller: submission, polling, level-by-level replay, manual play, report. */
(function () {
  const FA = window.FA;
  const $ = (id) => document.getElementById(id);
  const STEPS_PER_SEC = 20;
  const SPEEDS = [1, 2, 4, 8, 16];
  const CRASH_TEXT = {
    obstacle: 'Hit an obstacle', ground: 'Hit the ground', ceiling: 'Hit the ceiling',
    error: 'Policy raised an exception', timeout: 'Time limit exceeded',
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('fa.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('fa.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const pct = (x) => (100 * x).toFixed(1) + '%';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    levels: [], cfg: null,
    mode: 'demo',               // demo | replay | manual
    run: null,                  // {id, status, meta, results[], summary, fatal, log}
    idx: 0,                     // replay position in run.results
    revealed: new Set(),        // replay indices whose outcome has been shown
    pb: null,                   // current playback
    speed: SPEEDS.includes(store.get('speed', 2)) ? store.get('speed', 2) : 2,
    paused: false,
    sensors: store.get('sensors', false),
    reveal: store.get('reveal', true),
    manual: null, demo: null, pollTimer: null, reportShown: false,
  };

  const renderer = new FA.Renderer($('game'));

  // ------------------------------------------------------------------ playback core
  function makePb(course, traj, collected, extra) {
    const fuelMap = new Map(course.fuel.map(([x, y]) => [x, y]));
    return Object.assign({
      course, traj, collected: new Set(collected || []), fuelMap,
      n: traj.a.length, tau: 0, phase: 'intro', phaseT: 0, angle: 0, crashed: false, started: false,
    }, extra || {});
  }

  function advanceTo(pb, target) {
    target = Math.min(target, pb.n);
    if (target <= pb.tau && pb.started) return;
    const tr = pb.traj;
    const k0 = pb.started ? Math.floor(pb.tau) + 1 : 0;
    pb.started = true;
    const k1 = Math.floor(target);
    let trails = 0;
    for (let s = k0; s <= k1; s++) {
      if (s > 0 && pb.collected.has(s) && pb.fuelMap.has(s)) renderer.pickup(s, pb.fuelMap.get(s));
      if (tr.a[s] === 1) renderer.flapPuff(s, tr.y[s], pb.angle);
      if (trails++ < 3 && s > 0) renderer.trail(s, tr.y[s], pb.angle);
    }
    pb.tau = target;
  }

  function buildView(pb, dt) {
    const tr = pb.traj, n = pb.n;
    const tau = Math.max(0, Math.min(pb.tau, n));
    const k = Math.min(Math.floor(tau), n), fr = tau - k;
    let y = k >= n ? tr.y[n] : lerp(tr.y[k], tr.y[k + 1], fr);
    const vseg = k >= n ? tr.v[n] : tr.v[k + 1];
    let target = -Math.atan2(vseg * renderer.unit, FA.SW);
    if (pb.phase === 'intro' && tau === 0) {
      y += Math.sin(renderer.time * 3) * 0.7;
      target = -Math.cos(renderer.time * 3) * 0.08;
    }
    target = clamp(target, -0.8, 1.05);
    pb.angle += (target - pb.angle) * Math.min(1, dt * 14);
    return {
      course: pb.course, xf: tau, y, v: tr.v[k], g: pb.course.g, angle: pb.angle,
      fuel: tr.f[k], collected: pb.collected,
      showPlane: !(pb.crashed && tau >= n),
      sensors: S.sensors, reveal: S.reveal,
    };
  }

  // ------------------------------------------------------------------ HUD
  const hudCache = {};
  function setText(id, val) {
    if (hudCache[id] === val) return;
    hudCache[id] = val;
    $(id).textContent = val;
  }
  function buildFuelCells() {
    const box = $('hudFuel');
    box.innerHTML = '';
    for (let i = 0; i < S.cfg.F_max; i++) box.appendChild(document.createElement('i'));
    hudCache.fuel = -1;
  }
  function updateHudStatic(course, who) {
    setText('hudLevel', String(course.level).padStart(2, '0'));
    setText('hudName', course.name);
    setText('hudG', 'g ' + course.g.toFixed(3));
    setText('hudWho', who);
    setText('hudL', String(course.L));
  }
  function updateHud(view, pb) {
    const L = view.course.L;
    let dist = Math.floor(view.xf);
    if (pb.crashed && view.xf >= pb.n) dist = Math.max(0, pb.n - 1);
    const frac = clamp(view.xf / L, 0, 1);
    setText('hudDist', String(dist));
    setText('hudPct', pct(dist / L));
    $('hudProg').style.width = (frac * 100).toFixed(2) + '%';
    $('hudProgDot').style.left = (frac * 100).toFixed(2) + '%';
    const high = view.y > 0.8 * S.cfg.Y;
    if (hudCache.high !== high) { hudCache.high = high; $('hud').classList.toggle('dim', high); }
    setText('hudAlt', view.y.toFixed(1));
    setText('hudVs', (view.v >= 0 ? '+' : '') + view.v.toFixed(2));
    setText('hudT', String(dist));
    if (hudCache.fuel !== view.fuel) {
      hudCache.fuel = view.fuel;
      const cells = $('hudFuel').children;
      const f = Math.min(view.fuel, cells.length);
      for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('on', i < f);
      $('hudFuelN').textContent = view.fuel > 1e6 ? '∞' : String(view.fuel);
      $('hudFuelBox').classList.toggle('low', view.fuel <= 2);
    }
  }

  let bannerTimer = null;
  function showBanner(kicker, title, sub, kind, ms) {
    const b = $('banner');
    b.dataset.kind = kind || 'intro';
    $('bannerKicker').textContent = kicker || '';
    $('bannerKicker').style.display = kicker ? '' : 'none';
    $('bannerTitle').textContent = title || '';
    $('bannerSub').textContent = sub || '';
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(bannerTimer);
    if (ms) bannerTimer = setTimeout(hideBanner, ms);
  }
  function hideBanner() { $('banner').classList.remove('show'); }

  function setStatus(state, text) {
    const c = $('statusChip');
    c.dataset.state = state;
    c.querySelector('span').textContent = text;
  }

  let toastTimer = null;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function setMode(mode) {
    S.mode = mode;
    $('splash').hidden = mode !== 'demo';
    $('hud').hidden = mode === 'demo';
    $('stage').classList.toggle('paused', false);
    S.paused = false;
    $('hudSpeed').textContent = mode === 'manual' ? 'LIVE' : S.speed + '×';
    updatePlayPause();
  }

  // ------------------------------------------------------------------ demo (attract mode)
  const DEMO_LEVELS = [0, 5, 10, 15];
  function startDemo() {
    setMode('demo');
    hideBanner();
    setStatus('idle', 'Idle');
    S.demoCount = (S.demoCount || 0);
    nextDemo();
  }
  function nextDemo() {
    const li = DEMO_LEVELS[S.demoCount++ % DEMO_LEVELS.length];
    const course = S.levels[li];
    const cfg = Object.assign({}, S.cfg, { F0: 1e9, F_max: 1e9 });
    const sim = new FA.Sim(course, cfg);
    renderer.setTheme(course.theme);
    renderer.clearEffects();
    S.demo = { sim, acc: 0, endT: 0 };
    S.pb = makePb(course, sim.traj, [], { phase: 'fly' });
  }
  function updateDemo(dt) {
    const d = S.demo, pb = S.pb, sim = d.sim;
    if (!sim.done) {
      d.acc += dt * STEPS_PER_SEC * 1.5;
      while (d.acc >= 1 && !sim.done) { sim.step(FA.autopilot(sim)); d.acc -= 1; }
      pb.n = sim.steps;
      pb.collected = new Set(sim.collected);
      advanceTo(pb, sim.done ? pb.n : Math.max(0, pb.n - 1 + d.acc));
    } else {
      advanceTo(pb, pb.tau + dt * STEPS_PER_SEC * 1.5);
      if (pb.tau >= pb.n) {
        if (!d.endT) { d.endT = 1.4; if (sim.crash) { pb.crashed = true; renderer.explode(pb.n, sim.y); } }
        d.endT -= dt;
        if (d.endT <= 0) nextDemo();
      }
      // a completed demo flight (distance = L) loops into the next theme quickly
      if (!sim.crash && pb.tau >= pb.n) d.endT = Math.min(d.endT, 0.3);
    }
  }

  // ------------------------------------------------------------------ replay
  function expectedCount() {
    const run = S.run;
    if (run && run.meta && run.meta.levels) return run.meta.levels.length;
    return run ? Math.max(run.results.length, 20) : 20;
  }

  function startReplay() {
    stopManual();
    setMode('replay');
    S.idx = 0;
    S.pb = null;
    S.reportShown = false;
    renderer.clearEffects();
    hideBanner();
    renderStrip();
    renderRunCard();
  }

  function beginReplayLevel(i) {
    const res = S.run.results[i];
    const course = S.levels[res.level - 1];
    renderer.setTheme(course.theme);
    renderer.clearEffects();
    S.pb = makePb(course, res.traj, res.collected, { result: res, idx: i, phase: 'intro', phaseT: 1.5 });
    updateHudStatic(course, (S.run.meta && S.run.meta.policy) || 'policy');
    setText('hudOf', '/' + expectedCount());
    showBanner(`LEVEL ${res.level}`, course.name, `gravity ${course.g.toFixed(3)} · ${course.L} slots`, 'intro');
    renderStrip();
    renderRunCard();
    updateStatusChip();
  }

  function endReplayLevel(pb) {
    const res = pb.result;
    pb.phase = 'outro';
    pb.phaseT = 2.2;
    const tr = pb.traj;
    if (res.completed) {
      showBanner('LEVEL CLEARED', '100%', `${res.fuel_collected} fuel collected · ${res.flaps} flaps`, 'good');
      for (let i = 0; i < 3; i++) renderer.pickup(pb.n + 6 + i * 4, tr.y[pb.n] + (i - 1) * 8);
    } else if (res.crash === 'error' || res.crash === 'timeout') {
      const first = (res.error || '').split('\n')[0].slice(0, 120);
      showBanner(res.crash === 'error' ? 'POLICY ERROR' : 'TIMEOUT', pct(res.completion), first, 'warn');
    } else {
      pb.crashed = true;
      renderer.explode(pb.n, tr.y[pb.n]);
      let why = CRASH_TEXT[res.crash] || res.crash;
      if (res.crash === 'ground' && tr.f[pb.n] === 0) why = 'Out of fuel — hit the ground';
      showBanner('CRASHED', pct(res.completion), `${why} at slot ${res.distance + 1}`, 'bad');
    }
    S.revealed.add(pb.idx);
    renderStrip();
    renderRunCard();
  }

  function updateReplay(dt) {
    const run = S.run;
    if (!run) return;
    if (!S.pb) {
      if (S.startLevel) {                       // ?level=N deep link
        const ri = run.results.findIndex((r) => r.level === S.startLevel);
        if (ri >= 0) { S.startLevel = null; jumpTo(ri); }
        else if (run.status !== 'running') S.startLevel = null;
      }
      if (run.results[S.idx]) {
        beginReplayLevel(S.idx);
      } else if (run.status !== 'running' && S.idx >= run.results.length) {
        finishRun();
      } else if (run.status === 'running' && !S.waitingShown) {
        S.waitingShown = true;
        showBanner('EVALUATING', `Level ${S.idx + 1}`, 'your policy is flying it in Python…', 'wait');
      }
      return;
    }
    S.waitingShown = false;
    if (S.paused) return;
    const pb = S.pb;
    const sp = S.speed;
    if (pb.phase === 'intro') {
      pb.phaseT -= dt * Math.sqrt(sp);
      if (pb.phaseT <= 0) { pb.phase = 'fly'; hideBanner(); advanceTo(pb, 0); }
    } else if (pb.phase === 'fly') {
      advanceTo(pb, pb.tau + dt * STEPS_PER_SEC * sp);
      if (pb.tau >= pb.n) endReplayLevel(pb);
    } else if (pb.phase === 'outro') {
      pb.phaseT -= dt * Math.sqrt(sp);
      if (pb.phaseT <= 0) {
        const last = S.idx + 1 >= expectedCount();
        if (last && run.status !== 'running') { pb.phase = 'done'; finishRun(); }
        else { S.idx++; S.pb = null; }
      }
    }
  }

  function finishRun() {
    if (S.reportShown) return;
    S.reportShown = true;
    const run = S.run;
    run.results.forEach((_, i) => S.revealed.add(i));
    renderStrip();
    renderRunCard();
    updateStatusChip();
    if (run.status === 'failed' && run.results.length === 0) return;
    if (run.results.length) setTimeout(() => { if (S.run === run) openReport(); }, S.pb ? 300 : 0);
  }

  function jumpTo(i) {
    if (!S.run || !S.run.results[i]) return;
    if (S.mode !== 'replay') { stopManual(); setMode('replay'); }
    closeReport();
    for (let k = 0; k < i; k++) S.revealed.add(k);
    S.idx = i; S.pb = null; S.paused = false; S.reportShown = false;
    updatePlayPause();
    renderer.clearEffects();
  }

  function skipLevel(delta) {
    if (S.mode !== 'replay' || !S.run) return;
    if (delta > 0) {
      if (S.pb) S.revealed.add(S.idx);
      if (S.idx + 1 < S.run.results.length) jumpTo(S.idx + 1);
      else if (S.run.status !== 'running') { S.idx = S.run.results.length; S.pb = null; finishRun(); }
    } else {
      const restart = S.pb && S.pb.tau > 40;
      jumpTo(restart ? S.idx : Math.max(0, S.idx - 1));
    }
  }

  // ------------------------------------------------------------------ manual play
  function startManual(levelIdx) {
    stopManual();
    setMode('manual');
    closeReport();
    const course = S.levels[levelIdx];
    const sim = new FA.Sim(course, S.cfg);
    renderer.setTheme(course.theme);
    renderer.clearEffects();
    S.manual = { sim, levelIdx, acc: 0, flapQ: false };
    S.pb = makePb(course, sim.traj, [], { phase: 'intro' });
    updateHudStatic(course, 'you · SPACE to flap');
    setText('hudOf', '/20');
    showBanner(`LEVEL ${course.level}`, course.name, 'Press SPACE, ↑ or click to flap', 'intro');
    setStatus('manual', 'Manual play');
  }
  function stopManual() { S.manual = null; }

  function updateManual(dt) {
    const m = S.manual, pb = S.pb;
    if (!m || !pb) return;
    if (S.paused) return;
    const sim = m.sim;
    if (pb.phase === 'intro') {
      if (!m.flapQ) return;
      pb.phase = 'fly';
      hideBanner();
    }
    if (pb.phase === 'fly') {
      const rate = STEPS_PER_SEC;
      if (!sim.done) {
        m.acc += dt * rate;
        while (m.acc >= 1 && !sim.done) { sim.step(m.flapQ ? 1 : 0); m.flapQ = false; m.acc -= 1; }
        pb.n = sim.steps;
        pb.collected = new Set(sim.collected);
        advanceTo(pb, sim.done ? pb.n : Math.max(0, pb.n - 1 + m.acc));
      } else {
        advanceTo(pb, pb.tau + dt * rate);
      }
      if (sim.done && pb.tau >= pb.n) {
        pb.phase = 'outro';
        const L = pb.course.L, d = sim.distance;
        if (!sim.crash) {
          showBanner('LEVEL CLEARED', '100%', 'N = next level · R = retry · Esc = quit', 'good');
        } else {
          pb.crashed = true;
          renderer.explode(pb.n, sim.y);
          let why = CRASH_TEXT[sim.crash];
          if (sim.crash === 'ground' && sim.fuel === 0) why = 'Out of fuel';
          showBanner('CRASHED', pct(d / L), `${why} · R = retry · N = next · Esc = quit`, 'bad');
        }
      }
    }
  }

  // ------------------------------------------------------------------ submission + polling
  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
    return j;
  }

  async function submit(body) {
    try {
      const j = await getJSON('/api/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      toast(`Submitted — evaluating ${body.policy || body.filename}`);
      loadRun(j.id);
    } catch (e) {
      toast('Submit failed: ' + e.message, true);
    }
  }

  function submitFile(file) {
    if (!file) return;
    if (!/\.py$/i.test(file.name)) { toast('Please choose a .py file', true); return; }
    const reader = new FileReader();
    reader.onload = () => submit({ filename: file.name, code: String(reader.result) });
    reader.readAsText(file);
  }

  function loadRun(id) {
    clearTimeout(S.pollTimer);
    closeReport();
    S.run = { id, status: 'running', meta: null, results: [], summary: null, fatal: null, log: '' };
    S.revealed = new Set();
    S.waitingShown = false;
    try { history.replaceState(null, '', '?run=' + encodeURIComponent(id)); } catch (e) { /* file:// */ }
    $('runErr').hidden = true;
    startReplay();
    poll();
  }

  async function poll() {
    const run = S.run;
    if (!run) return;
    let j;
    try {
      j = await getJSON(`/api/runs/${encodeURIComponent(run.id)}?since=${run.results.length}`);
    } catch (e) {
      if (S.run !== run) return;
      run.misses = (run.misses || 0) + 1;
      if (/not found/i.test(e.message) && run.misses > 8) {
        run.status = 'failed';
        run.fatal = 'Run not found: ' + run.id;
        afterRunFailed();
        return;
      }
      S.pollTimer = setTimeout(poll, run.misses > 3 ? 1000 : 300);
      return;
    }
    if (S.run !== run) return;
    run.status = j.status;
    run.meta = j.meta || run.meta;
    run.summary = j.summary;
    run.fatal = j.fatal;
    run.log = j.log;
    if (j.since === run.results.length && j.levels.length) run.results.push(...j.levels);
    renderStrip();
    renderRunCard();
    updateStatusChip();
    if (run.status === 'running') {
      S.pollTimer = setTimeout(poll, run.results.length ? 500 : 300);
    } else {
      if (run.status === 'failed' || run.status === 'incomplete') afterRunFailed();
      if (S.reportOnLoad && run.results.length) {     // ?report=1 deep link
        S.reportOnLoad = false;
        run.results.forEach((_, i) => S.revealed.add(i));
        renderStrip(); renderRunCard();
        openReport();
      }
      refreshBoard();
    }
  }

  function afterRunFailed() {
    const run = S.run;
    const msg = run.fatal || run.log || 'evaluation stopped';
    $('runErr').textContent = msg.trim();
    $('runErr').hidden = false;
    renderRunCard();
    updateStatusChip();
    if (run.results.length === 0) {
      const lines = msg.trim().split('\n');
      showBanner('SUBMISSION FAILED', 'Could not load policy', lines[lines.length - 1].slice(0, 140), 'bad');
    }
  }

  function updateStatusChip() {
    if (S.mode === 'manual') return setStatus('manual', 'Manual play');
    const run = S.run;
    if (!run) return setStatus('idle', 'Idle');
    const n = expectedCount();
    if (run.status === 'running') return setStatus('running', `Evaluating ${run.results.length}/${n}`);
    if (run.status === 'failed') return setStatus('failed', run.results.length ? 'Stopped' : 'Failed');
    if (S.mode === 'replay' && S.pb && !S.reportShown) return setStatus('replay', `Replaying ${S.idx + 1}/${run.results.length}`);
    setStatus('done', run.summary ? `Done · ${pct(run.summary.mean_completion)}` : 'Done');
  }

  // ------------------------------------------------------------------ side panel rendering
  function classify(r) {
    if (r.completed) return 'cleared';
    return r.completion >= 0.5 ? 'partial' : 'failed';
  }

  function renderStrip() {
    const box = $('levelStrip');
    const n = 20;
    if (box.children.length !== n) {
      box.innerHTML = '';
      for (let i = 0; i < n; i++) {
        const t = document.createElement('div');
        t.className = 'tile';
        t.dataset.theme = S.levels[i] ? S.levels[i].theme : 'day';
        t.innerHTML = `<span>${i + 1}</span><span class="tt"></span><i class="tb"></i>`;
        t.title = S.levels[i] ? `${i + 1}. ${S.levels[i].name}` : '';
        t.addEventListener('click', () => {
          const run = S.run;
          if (S.mode === 'replay' && run) {
            const ri = run.results.findIndex((r) => r.level === i + 1);
            if (ri >= 0) jumpTo(ri);
          } else if (S.mode !== 'replay') {
            $('playLevel').value = String(i);
          }
        });
        box.appendChild(t);
      }
    }
    const run = S.run;
    const byLevel = {};
    if (run) run.results.forEach((r, i) => { byLevel[r.level] = { r, i }; });
    for (let i = 0; i < n; i++) {
      const t = box.children[i];
      const e = byLevel[i + 1];
      let cls = 'tile';
      let label = '';
      let w = 0;
      if (e) {
        const playing = S.mode === 'replay' && S.pb && S.pb.idx === e.i && !S.reportShown;
        if (playing) { cls += ' playing'; label = '▶'; w = 0; }
        else if (S.revealed.has(e.i)) { cls += ' ' + classify(e.r); label = Math.round(e.r.completion * 100) + '%'; w = e.r.completion * 100; }
        else cls += ' ready';
      }
      if (t.className !== cls) t.className = cls;
      t.querySelector('.tt').textContent = label;
      t.querySelector('.tb').style.width = w + '%';
    }
  }

  function renderRunCard() {
    const run = S.run;
    const table = $('levelTable');
    if (!run) return;
    $('runName').textContent = (run.meta && run.meta.policy) || run.id;
    $('stopBtn').disabled = run.status !== 'running';
    $('reportBtn').disabled = run.results.length === 0;
    const dl = $('dlBtn');
    dl.href = `/api/runs/${encodeURIComponent(run.id)}/raw`;
    dl.setAttribute('aria-disabled', run.results.length ? 'false' : 'true');

    const shown = run.results.filter((_, i) => S.revealed.has(i));
    const n = expectedCount();
    const cleared = shown.filter((r) => r.completed).length;
    const meanAll = shown.length ? shown.reduce((a, r) => a + r.completion, 0) / n : 0;
    $('statCleared').textContent = shown.length ? `${cleared}/${n}` : '–';
    $('statComp').textContent = shown.length ? pct(meanAll) : '–';
    $('statDist').textContent = shown.length ? shown.reduce((a, r) => a + r.distance, 0).toLocaleString() : '–';

    const ids = (run.meta && run.meta.levels) || Array.from({ length: 20 }, (_, i) => i + 1);
    let html = '';
    ids.forEach((lv, i) => {
      const course = S.levels[lv - 1];
      const r = run.results[i];
      const playing = r && S.mode === 'replay' && S.pb && S.pb.idx === i && !S.reportShown;
      const rev = r && S.revealed.has(i);
      let cls = 'lrow', pc = '', st = '', w = 0;
      if (playing) { cls += ' playing'; pc = 'flying'; st = '▶'; }
      else if (rev) { cls += ' revealed ' + classify(r); pc = pct(r.completion); w = r.completion * 100; st = r.completed ? '✓' : (r.crash === 'error' || r.crash === 'timeout') ? '!' : '✕'; }
      else if (r) { pc = 'ready'; }
      else if (run.status === 'running') { pc = '<span class="dots"></span>'; }
      else { pc = '—'; }
      html += `<div class="${cls}" data-i="${i}"><span class="n">${String(lv).padStart(2, '0')}</span>` +
        `<span class="nm">${esc(course ? course.name : 'Level ' + lv)}</span>` +
        `<span class="bar"><i style="width:${w}%"></i></span><span class="pc">${pc}</span><span class="st">${st}</span></div>`;
    });
    table.innerHTML = html;
  }

  async function refreshBoard() {
    let runs;
    try { runs = await getJSON('/api/runs'); } catch (e) { return; }
    const done = runs.filter((r) => r.summary && r.summary.n > 0);
    done.sort((a, b) => (b.summary.mean_completion - a.summary.mean_completion) || (b.summary.cleared - a.summary.cleared));
    const box = $('board');
    if (!done.length) { box.innerHTML = '<li class="empty">No finished runs yet.</li>'; return; }
    box.innerHTML = done.slice(0, 15).map((r, i) => {
      const date = r.started ? r.started.replace('T', ' ').slice(5, 16) : '';
      const cur = S.run && S.run.id === r.id ? ' current' : '';
      return `<li class="entry${cur}" data-id="${esc(r.id)}"><span class="rk">${i + 1}</span>` +
        `<span class="who"><b>${esc(r.policy)}</b><span>${esc(date)} · ${r.summary.n} levels</span></span>` +
        `<span class="sc"><b>${pct(r.summary.mean_completion)}</b><span>${r.summary.cleared}/${r.summary.n} cleared</span></span></li>`;
    }).join('');
  }

  // ------------------------------------------------------------------ report modal
  function openReport() {
    const run = S.run;
    if (!run || !run.results.length) return;
    const res = run.results;
    const n = expectedCount();
    const sum = run.summary || {
      n: res.length, cleared: res.filter((r) => r.completed).length,
      mean_completion: res.reduce((a, r) => a + r.completion, 0) / n,
      total_distance: res.reduce((a, r) => a + r.distance, 0), total_length: res.reduce((a, r) => a + r.L, 0),
      fuel_collected: res.reduce((a, r) => a + r.fuel_collected, 0), time_s: null,
    };
    $('mKicker').textContent = run.status === 'running' ? 'Partial report — still evaluating' : run.status === 'done' ? 'Run complete' : 'Run stopped';
    $('mTitle').textContent = (run.meta && run.meta.policy) || run.id;
    $('mComp').textContent = pct(sum.mean_completion);
    $('mCleared').textContent = `${sum.cleared} / ${n}`;
    $('mDist').textContent = `${sum.total_distance.toLocaleString()} / ${sum.total_length.toLocaleString()}`;
    $('mFuel').textContent = String(sum.fuel_collected);
    $('mTime').textContent = sum.time_s != null ? sum.time_s.toFixed(1) + ' s' : '—';
    const fg = $('mRingFg');
    fg.style.stroke = sum.mean_completion >= 0.8 ? 'var(--good)' : sum.mean_completion >= 0.5 ? 'var(--warn)' : 'var(--bad)';
    fg.style.strokeDashoffset = '314.16';
    requestAnimationFrame(() => requestAnimationFrame(() => { fg.style.strokeDashoffset = String(314.16 * (1 - sum.mean_completion)); }));

    $('mBars').innerHTML = res.map((r, i) =>
      `<div class="b ${classify(r)}" data-i="${i}" title="Level ${r.level} · ${esc(r.name)} · ${pct(r.completion)}"><i style="height:0%"></i><span>${r.level}</span></div>`).join('');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $('mBars').querySelectorAll('.b').forEach((el, i) => { el.querySelector('i').style.height = Math.max(2, res[i].completion * 100) + '%'; });
    }));

    const rows = res.map((r) => {
      const result = r.completed ? 'cleared' : (CRASH_TEXT[r.crash] || r.crash || '').toLowerCase();
      return `<tr class="${classify(r)}"><td class="num">${r.level}</td><td>${esc(r.name)}</td>` +
        `<td class="num">${r.g.toFixed(3)}</td><td class="num">${r.p.toFixed(3)}</td><td class="num">${r.distance} / ${r.L}</td>` +
        `<td class="num">${pct(r.completion)}</td><td class="num">${r.fuel_collected} / ${r.fuel_passed}</td>` +
        `<td class="num">${r.flaps}</td><td class="num">${r.ms_per_step.toFixed(2)}</td><td class="res">${esc(result)}</td></tr>`;
    }).join('');
    $('mTable').innerHTML = `<thead><tr><th class="num">#</th><th>Level</th><th class="num">g</th><th class="num" title="hidden fuel abundance, revealed after the run">p</th>` +
      `<th class="num">Distance</th><th class="num">Compl.</th><th class="num">Fuel got/seen</th><th class="num">Flaps</th><th class="num">ms/step</th><th>Result</th></tr></thead><tbody>${rows}</tbody>`;
    $('mDl').href = `/api/runs/${encodeURIComponent(run.id)}/raw`;
    $('modal').hidden = false;
  }
  function closeReport() { $('modal').hidden = true; }

  // ------------------------------------------------------------------ controls
  function updatePlayPause() {
    $('playPauseBtn').querySelector('use').setAttribute('href', S.paused ? '#i-play' : '#i-pause');
    $('stage').classList.toggle('paused', S.paused);
  }
  function togglePause() {
    if (S.mode === 'demo') return;
    if (S.mode === 'replay' && S.reportShown && S.run) { jumpTo(0); return; }
    S.paused = !S.paused;
    updatePlayPause();
  }
  function setSpeed(s) {
    S.speed = s;
    store.set('speed', s);
    document.querySelectorAll('#speedSeg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === s));
    if (S.mode !== 'manual') $('hudSpeed').textContent = s + '×';
  }

  function flap() {
    if (S.mode !== 'manual' || !S.manual) return;
    const pb = S.pb;
    if (pb.phase === 'outro') return;
    S.manual.flapQ = true;
  }

  function bindUI() {
    $('fileInput').addEventListener('change', (e) => { submitFile(e.target.files[0]); e.target.value = ''; });
    const drop = $('drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) submitFile(f);
    });

    $('fmtToggle').addEventListener('click', () => { $('fmt').hidden = !$('fmt').hidden; });
    $('runPolicyBtn').addEventListener('click', () => { const p = $('policySelect').value; if (p) submit({ policy: p }); });
    $('splashRun').addEventListener('click', () => { const p = $('policySelect').value; if (p) submit({ policy: p }); });
    $('playBtn').addEventListener('click', () => startManual(Number($('playLevel').value) || 0));
    $('splashPlay').addEventListener('click', () => startManual(0));
    $('prevBtn').addEventListener('click', () => skipLevel(-1));
    $('nextBtn').addEventListener('click', () => skipLevel(1));
    $('playPauseBtn').addEventListener('click', togglePause);
    $('skipBtn').addEventListener('click', () => {
      if (!S.run || !S.run.results.length) { toast('Nothing to report yet — submit a policy first'); return; }
      S.run.results.forEach((_, i) => S.revealed.add(i));
      renderStrip(); renderRunCard();
      openReport();
    });
    document.querySelectorAll('#speedSeg button').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.s))));
    $('sensorsTog').checked = S.sensors;
    $('revealTog').checked = S.reveal;
    $('sensorsTog').addEventListener('change', (e) => { S.sensors = e.target.checked; store.set('sensors', S.sensors); });
    $('revealTog').addEventListener('change', (e) => { S.reveal = e.target.checked; store.set('reveal', S.reveal); });
    $('stopBtn').addEventListener('click', async () => {
      if (!S.run) return;
      try { await getJSON(`/api/runs/${encodeURIComponent(S.run.id)}/stop`, { method: 'POST' }); toast('Evaluation stopped'); } catch (e) { toast(e.message, true); }
    });
    $('reportBtn').addEventListener('click', openReport);
    $('boardRefresh').addEventListener('click', refreshBoard);
    $('board').addEventListener('click', (e) => { const li = e.target.closest('li.entry'); if (li) loadRun(li.dataset.id); });
    $('levelTable').addEventListener('click', (e) => { const row = e.target.closest('.lrow'); if (row) jumpTo(Number(row.dataset.i)); });
    $('mBars').addEventListener('click', (e) => { const b = e.target.closest('.b'); if (b) jumpTo(Number(b.dataset.i)); });
    $('modalClose').addEventListener('click', closeReport);
    $('mClose2').addEventListener('click', closeReport);
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeReport(); });
    $('mReplay').addEventListener('click', () => { S.revealed = new Set(); jumpTo(0); renderStrip(); renderRunCard(); });

    $('stage').addEventListener('pointerdown', (e) => {
      if (S.mode === 'manual') { e.preventDefault(); flap(); }
    });

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
      const k = e.key;
      if (!$('modal').hidden) { if (k === 'Escape') closeReport(); return; }
      if (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W') {
        e.preventDefault();
        if (S.mode === 'manual') flap(); else if (k === ' ') togglePause();
      } else if (k === 'ArrowRight') { skipLevel(1); }
      else if (k === 'ArrowLeft') { skipLevel(-1); }
      else if (k === 's' || k === 'S') { $('sensorsTog').click(); }
      else if (k === 'h' || k === 'H') { $('revealTog').click(); }
      else if (S.mode === 'manual' && (k === 'r' || k === 'R')) startManual(S.manual ? S.manual.levelIdx : 0);
      else if (S.mode === 'manual' && (k === 'n' || k === 'N' || k === 'Enter')) {
        const nxt = ((S.manual ? S.manual.levelIdx : 0) + 1) % S.levels.length;
        $('playLevel').value = String(nxt);
        startManual(nxt);
      } else if (k === 'Escape' && S.mode === 'manual') {
        stopManual();
        if (S.run && S.run.results.length) { setMode('replay'); jumpTo(S.idx); } else startDemo();
      } else if (k >= '1' && k <= '5' && !e.metaKey && !e.ctrlKey) setSpeed(SPEEDS[Number(k) - 1]);
    });
  }

  // ------------------------------------------------------------------ main loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      if (S.mode === 'replay') updateReplay(dt);
      else if (S.mode === 'manual') updateManual(dt);
      else if (S.demo) updateDemo(dt);
      renderer.update(dt);
      const view = S.pb ? buildView(S.pb, dt) : null;
      renderer.draw(view);
      if (view && S.mode !== 'demo') updateHud(view, S.pb);
      if (S.mode === 'replay' && S.pb && S.pb.phase === 'fly' && Math.random() < 0.05) updateStatusChip();
    } catch (err) {
      console.error(err);
    }
    requestAnimationFrame(frame);
  }

  async function init() {
    bindUI();
    setSpeed(S.speed);
    try {
      const [levels, cfg, policies] = await Promise.all([getJSON('/api/levels'), getJSON('/api/config'), getJSON('/api/policies')]);
      S.levels = levels;
      S.cfg = cfg;
      renderer.setConfig(cfg);
      buildFuelCells();
      const sel = $('policySelect');
      sel.innerHTML = policies.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
      if (policies.includes('rollout_policy.py')) sel.value = 'rollout_policy.py';
      $('playLevel').innerHTML = levels.map((c, i) => `<option value="${i}">Level ${c.level} · ${esc(c.name)}</option>`).join('');
      renderStrip();
      refreshBoard();
      const params = new URLSearchParams(location.search);
      if (params.get('sensors') === '1') { S.sensors = true; $('sensorsTog').checked = true; }
      if (params.get('speed') && SPEEDS.includes(Number(params.get('speed')))) setSpeed(Number(params.get('speed')));
      const runId = params.get('run');
      S.startLevel = Number(params.get('level')) || null;
      S.reportOnLoad = params.get('report') === '1';
      if (runId) loadRun(runId); else startDemo();
    } catch (e) {
      console.error(e);
      setStatus('failed', 'Server offline');
      $('splash').hidden = false;
      document.querySelector('.splash-card').innerHTML =
        '<div class="kicker">Server not reachable</div><h2>Start the testbed server</h2>' +
        '<p>Run <code>python server.py</code> in the project folder, then open the printed URL (default <code>http://localhost:8000</code>).</p>';
    }
    requestAnimationFrame(frame);
  }

  init();
})();
