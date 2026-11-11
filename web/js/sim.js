/* JS mirror of flappy/env.py — used for "Play it yourself" and the attract-mode demo.
   Policy evaluation always happens in Python; this only has to match the physics. */
(function () {
  const COAST = 0, FLAP = 1;

  function expandCourse(course) {
    const L = course.L;
    const gaps = new Array(L + 1).fill(null);
    const fuel = new Array(L + 1).fill(null);
    for (const [x0, x1, lo, hi] of course.obstacles) {
      for (let x = x0; x <= x1 && x <= L; x++) gaps[x] = [lo, hi];
    }
    for (const [x, y] of course.fuel) if (x <= L) fuel[x] = y;
    return { gaps, fuel };
  }

  class Sim {
    constructor(course, cfg) {
      this.course = course;
      this.cfg = cfg;
      this.L = course.L;
      this.g = course.g;
      const e = expandCourse(course);
      this.gaps = e.gaps;
      this.fuelAt = e.fuel;
      this.reset();
    }

    reset() {
      const c = this.cfg;
      this.x = 0; this.y = c.y0; this.v = c.v0; this.fuel = c.F0;
      this.done = false; this.crash = null; this.flaps = 0;
      this.collected = [];
      this.traj = { y: [this.y], v: [this.v], f: [this.fuel], a: [] };
    }

    get steps() { return this.traj.a.length; }
    get distance() { return this.crash ? this.x - 1 : this.x; }

    step(action) {
      if (this.done) return;
      const c = this.cfg;
      let a = action === FLAP ? FLAP : COAST;
      if (a === FLAP && this.fuel < 1) a = COAST;
      let v2, fuel = this.fuel;
      if (a === FLAP) { v2 = c.u; fuel -= 1; this.flaps++; } else { v2 = this.v - this.g; }
      let y2 = this.y + v2;
      const x2 = this.x + 1;
      let crash = null;
      if (y2 <= 0) { crash = 'ground'; y2 = 0; }
      else if (y2 >= c.Y) { crash = 'ceiling'; y2 = c.Y; }
      const gap = this.gaps[x2];
      if (!crash && gap && !(gap[0] < y2 && y2 < gap[1])) crash = 'obstacle';
      const fy = this.fuelAt[x2];
      if (!crash && fy !== null && Math.abs(y2 - fy) <= c.r) {
        fuel = Math.min(c.F_max, fuel + 1);
        this.collected.push(x2);
      }
      this.x = x2; this.y = y2; this.v = v2; this.fuel = fuel;
      this.crash = crash;
      this.done = crash !== null || x2 >= this.L;
      this.traj.y.push(y2); this.traj.v.push(v2); this.traj.f.push(fuel); this.traj.a.push(a);
    }
  }

  /* Simple autopilot used only for the idle demo (has unlimited fuel there). */
  function autopilot(sim) {
    const { y, v, g } = sim;
    const u = sim.cfg.u;
    const hop = (u * u) / (2 * g);
    let target = 45;
    for (let s = sim.x + 1; s <= Math.min(sim.L, sim.x + 40); s++) {
      const gap = sim.gaps[s];
      if (gap) { target = Math.max(gap[0] + 2, Math.min((gap[0] + gap[1]) / 2 - hop / 2, gap[1] - hop - 2)); break; }
    }
    const nextGap = sim.gaps[sim.x + 1];
    if (nextGap && y + u >= nextGap[1] - 0.5) return COAST;
    return y + v - g < target ? FLAP : COAST;
  }

  window.FA = window.FA || {};
  Object.assign(window.FA, { Sim, expandCourse, autopilot, COAST, FLAP });
})();
