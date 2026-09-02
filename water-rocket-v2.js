/* ============================================================
   물로켓 발사 실험실 (v2)
   수행평가 흐름: ① 실제 발사·측정·영상분석 → ② 이론 계산 → ③ 시뮬레이션 예측 → ④ 세 값 비교

   비교하는 세 값
     ① 실측값        운동장에서 줄자·스톱워치로 잰 값
     ② 영상 이론값   영상에서 얻은 "발사속력"으로 포물선 공식을 적용한 값 (공기 저항 무시)
     ③ 시뮬 예측값   물의 양·압력·각도로부터 추진 구간을 적분해 얻은 값

   "발사속력"이란 추력으로 커지던 속력이 자유비행에 들어가며 줄어들기 직전의 값,
   즉 연소 종료 시점의 속력이다. ②와 ③이 같은 물리량을 가리키므로 서로 맞대볼 수 있다.
   ============================================================ */

(() => {
  "use strict";

  const el = (id) => document.getElementById(id);

  // ---------- 상수 ----------
  const RHO_WATER = 1000, RHO_AIR = 1.225, PATM = 101325;
  const GAMMA = 1.4, G = 9.8, CD_NOZZLE = 0.85, CD_DRAG = 0.75;
  const ROD_LENGTH_M = 0.27;

  const COLOR_REAL = "#dd5b00";     // ② 영상 이론
  const COLOR_GROUND = "#0075de";   // ① 실측 / 2단계 구간
  const COLOR_SIM = "#391c57";      // ③ 시뮬레이션
  const COLOR_DRAG = "#9a3412";
  const COLOR_THRUST = "#222222";
  const COLOR_PREVIEW = "#f2b98d";

  // ---------- DOM ----------
  const theoryCanvas = el("theoryCanvas"), simCanvas = el("simCanvas");
  const compareChart = el("compareChart"), energyChart = el("energyChart");

  const waterInput = el("waterInput"), pressureInput = el("pressureInput"), angleInput = el("angleInput");
  const waterValue = el("waterValue"), pressureValue = el("pressureValue"), angleValue = el("angleValue");

  const realRange = el("realRange"), realTime = el("realTime"), realHeight = el("realHeight");
  const videoSpeed = el("videoSpeed"), videoHeight = el("videoHeight"), videoTime = el("videoTime");
  const recordStatus = el("recordStatus");

  const theoryEmpty = el("theoryEmpty"), theoryGrid = el("theoryGrid");
  const factSpeed = el("factSpeed"), factAngle = el("factAngle"),
        factHeight = el("factHeight"), factComp = el("factComp");
  const revealBtn = el("revealBtn"), answerBody = el("answerBody"), answerNote = el("answerNote");
  const ansPH = el("ansPH"), ansPR = el("ansPR"), ansPT = el("ansPT");
  const ansAH = el("ansAH"), ansAR = el("ansAR"), ansAT = el("ansAT");
  const ansBH = el("ansBH"), ansBR = el("ansBR"), ansBT = el("ansBT");
  const ansRH = el("ansRH"), ansRR = el("ansRR"), ansRT = el("ansRT");
  const enK1 = el("enK1"), enU1 = el("enU1"), enE1 = el("enE1");
  const enK2 = el("enK2"), enU2 = el("enU2"), enE2 = el("enE2");

  const simTag = el("simTag"), bigReadout = el("bigReadout"), bigRange = el("bigRange");
  const launchBtn = el("launchBtn"), resetBtn = el("resetBtn"), simWarn = el("simWarn");
  const simFacts = el("simFacts"), speedCheck = el("speedCheck");
  const simSpeedEl = el("simSpeed"), simHeightEl = el("simHeight"), simRangeEl = el("simRange"),
        simTimeEl = el("simTime"), simMaxHEl = el("simMaxH");
  const echoWater = el("echoWater"), echoPressure = el("echoPressure"), echoAngle = el("echoAngle");

  const compareEmpty = el("compareEmpty"), compareGrid = el("compareGrid");
  const errBody = el("errBody"), diagnosis = el("diagnosis"), questionList = el("questionList");
  const dragTestBtn = el("dragTestBtn"), dragResult = el("dragResult");
  const energyMsg = el("energyMsg");

  const bottleInput = el("bottleInput"), nozzleInput = el("nozzleInput"),
        dryMassInput = el("dryMassInput"), diameterInput = el("diameterInput");
  const bottleValue = el("bottleValue"), nozzleValue = el("nozzleValue"),
        dryMassValue = el("dryMassValue"), diameterValue = el("diameterValue");
  const speedSelect = el("speedSelect");

  const teacherToggle = el("teacherToggle"), settingsOverlay = el("settingsOverlay"),
        settingsBackdrop = el("settingsBackdrop"), settingsClose = el("settingsClose");

  const stepButtons = Array.from(document.querySelectorAll(".step"));
  const panels = { record: el("tabRecord"), theory: el("tabTheory"), sim: el("tabSim"), compare: el("tabCompare") };

  // ---------- 물리: 추진 구간 ----------

  function simulateThrust1D({ bottleML, waterML, gaugeAtm, nozzleMM, dryKg, angleDeg }) {
    const Vbottle = bottleML * 1e-6;
    const Vw0 = Math.min(waterML * 1e-6, Vbottle * 0.98);
    const Va0 = Vbottle - Vw0;
    const P0 = PATM + gaugeAtm * 101325;
    const An = Math.PI * Math.pow(nozzleMM / 2000, 2);
    const th = SimUtils.toRad(angleDeg), sT = Math.sin(th), cT = Math.cos(th);

    if (Vw0 <= 0) return { liftoff: false, reason: "no-water" };
    const mass0 = dryKg + RHO_WATER * Vw0;
    const vExit0 = CD_NOZZLE * Math.sqrt(Math.max(0, (2 * (P0 - PATM)) / RHO_WATER));
    if (RHO_WATER * An * vExit0 * vExit0 - mass0 * G * sT <= 0) return { liftoff: false, reason: "thrust-too-low" };

    const dt = 0.0001;
    let t = 0, s = 0, v = 0, Vw = Vw0, step = 0;
    const samples = [];
    const push = () => samples.push({
      t, x: s * cT, y: s * sT, vx: v * cT, vy: v * sT, s, v, vwFrac: Vw / Vw0, phase: "thrust",
    });
    push();

    while (Vw > 1e-9 && t < 3) {
      const P = P0 * Math.pow(Va0 / (Vbottle - Vw), GAMMA);
      if (P <= PATM) break;
      const vExit = CD_NOZZLE * Math.sqrt((2 * (P - PATM)) / RHO_WATER);
      const Q = An * vExit;
      v = Math.max(0, v + ((RHO_WATER * Q * vExit) / (dryKg + RHO_WATER * Vw) - G * sT) * dt);
      s += v * dt; Vw -= Q * dt; t += dt; step++;
      if (step % 5 === 0) push();
    }
    Vw = Math.max(0, Vw);
    push();
    if (v < 1.0) return { liftoff: false, reason: "weak-thrust" };

    return {
      liftoff: true, samples, tBurnout: t,
      leftoverWaterML: Vw * 1e6,
      x1: s * cT, y1: s * sT, vx1: v * cT, vy1: v * sT,
      rodExit: samples.find((smp) => smp.s >= ROD_LENGTH_M) || null,
    };
  }

  // ---------- 물리: 자유비행 ----------

  function freeFlightClosed(x1, y1, vx1, vy1, count = 220) {
    let tF = (vy1 + Math.sqrt(vy1 * vy1 + 2 * G * Math.max(0, y1))) / G;
    if (!isFinite(tF) || tF <= 0) tF = 0.001;
    const samples = [];
    for (let i = 0; i <= count; i++) {
      const t = (tF * i) / count;
      samples.push({
        t, x: x1 + vx1 * t, y: Math.max(0, y1 + vy1 * t - 0.5 * G * t * t),
        vx: vx1, vy: vy1 - G * t, phase: "free",
      });
    }
    return { samples, tFlight: tF, maxHeight: y1 + (vy1 > 0 ? (vy1 * vy1) / (2 * G) : 0), range: x1 + vx1 * tF };
  }

  function freeFlightDrag(x1, y1, vx1, vy1, mass, area) {
    const dt = 0.002;
    let t = 0, x = x1, y = y1, vx = vx1, vy = vy1, maxH = y1, n = 0;
    const samples = [{ t, x, y, vx, vy, phase: "free" }];
    while (y > 0 && t < 25) {
      const sp = Math.hypot(vx, vy);
      const d = 0.5 * RHO_AIR * CD_DRAG * area * sp * sp;
      vx += (sp > 1e-6 ? (-d * (vx / sp)) / mass : 0) * dt;
      vy += (-G + (sp > 1e-6 ? (-d * (vy / sp)) / mass : 0)) * dt;
      x += vx * dt; y += vy * dt; t += dt; n++;
      if (y > maxH) maxH = y;
      if (n % 2 === 0) samples.push({ t, x, y: Math.max(0, y), vx, vy, phase: "free" });
    }
    const last = samples[samples.length - 1];
    if (last.y <= 0 && samples.length >= 2) {
      const prev = samples[samples.length - 2];
      const f = prev.y / (prev.y - last.y || 1);
      samples[samples.length - 1] = {
        t: prev.t + (last.t - prev.t) * f, x: prev.x + (last.x - prev.x) * f,
        y: 0, vx: last.vx, vy: last.vy, phase: "free",
      };
    }
    const end = samples[samples.length - 1];
    return { samples, tFlight: end.t, maxHeight: maxH, range: end.x };
  }

  /* 두 단계로 나눈 포물선 계산
     [1단계] 발사속력을 얻은 지점을 기준면으로 보면 출발 높이 = 도착 높이가 되어
             교과서 공식이 보정 없이 그대로 성립한다.
     [2단계] 실제로는 그 높이에서 h만큼 더 떨어지므로 그만큼 보정한다.
     추진 구간의 수평 이동 x는 발사각 방향 직선 운동이므로 x = h / tanθ 로 구할 수 있다. */
  function twoStepSolution(speed, height, angleDeg, thrustTime) {
    const th = SimUtils.toRad(angleDeg);
    const vx = speed * Math.cos(th), vy = speed * Math.sin(th);

    const Hrel = (vy * vy) / (2 * G);
    const T1 = (2 * vy) / G;
    const R1 = vx * T1;

    const vyGround = Math.sqrt(vy * vy + 2 * G * Math.max(0, height));
    const dt = (vyGround - vy) / G;
    const dx = vx * dt;

    const xThrust = Math.tan(th) > 1e-6 ? height / Math.tan(th) : 0;

    return {
      vx, vy, Hrel, T1, R1, vyGround, dt, dx, xThrust,
      Habs: height + Hrel,
      Rtotal: xThrust + R1 + dx,
      Ttotal: (thrustTime || 0) + T1 + dt,
      Tfree: T1 + dt,
      samples: freeFlightClosed(xThrust, height, vx, vy).samples,
      backAtH: T1,
    };
  }

  // ---------- 시뮬레이션 궤적 ----------

  function buildSimTrajectory(inputs) {
    const thrust = simulateThrust1D(inputs);
    if (!thrust.liftoff) return { liftoff: false, reason: thrust.reason };

    const mass = inputs.dryKg + RHO_WATER * Math.max(0, thrust.leftoverWaterML * 1e-6);
    const area = Math.PI * Math.pow(inputs.diameterCM / 200, 2);
    const free = freeFlightClosed(thrust.x1, thrust.y1, thrust.vx1, thrust.vy1);
    const freeDrag = freeFlightDrag(thrust.x1, thrust.y1, thrust.vx1, thrust.vy1, mass, area);

    const shift = (s) => ({ ...s, t: s.t + thrust.tBurnout });
    return {
      liftoff: true, mass,
      samples: thrust.samples.concat(free.samples.map(shift)),
      tBurnout: thrust.tBurnout,
      burnout: { x: thrust.x1, y: thrust.y1, vx: thrust.vx1, vy: thrust.vy1, speed: Math.hypot(thrust.vx1, thrust.vy1) },
      totalFlightTime: thrust.tBurnout + free.tFlight,
      maxHeight: Math.max(thrust.y1, free.maxHeight),
      range: free.range,
      rodExit: thrust.rodExit,
      withDrag: {
        samples: thrust.samples.concat(freeDrag.samples.map(shift)),
        totalFlightTime: thrust.tBurnout + freeDrag.tFlight,
        maxHeight: Math.max(thrust.y1, freeDrag.maxHeight),
        range: freeDrag.range,
      },
    };
  }

  // ---------- 상태 ----------

  const sim = {
    tab: "record",
    traj: null, preview: null,
    running: false, landed: false, simTime: 0, lastFrame: null, timeScale: 2,
    theory: null,
    dragRevealed: false,
  };

  function num(input) {
    const v = Number(input.value);
    return input.value !== "" && isFinite(v) && v > 0 ? v : null;
  }

  function readInputs() {
    return {
      bottleML: Number(bottleInput.value), waterML: Number(waterInput.value),
      gaugeAtm: Number(pressureInput.value), nozzleMM: Number(nozzleInput.value),
      dryKg: Number(dryMassInput.value), angleDeg: Number(angleInput.value),
      diameterCM: Number(diameterInput.value),
    };
  }

  function hasVideoData() { return num(videoSpeed) != null && num(videoHeight) != null; }
  function hasMeasured() { return num(realRange) != null && num(realTime) != null; }

  const REASONS = {
    "thrust-too-low": "이 조건에서는 추진력이 로켓 무게를 이기지 못해 날아가지 않아요.",
    "weak-thrust": "추진력이 약해서 거의 날아가지 않아요. 압력을 높여 보세요.",
    "no-water": "물이 없으면 날아가지 않아요.",
  };

  // ---------- 보간 · 에너지 ----------

  function interpAt(samples, t) {
    if (!samples.length) return null;
    if (t <= samples[0].t) return samples[0];
    const last = samples[samples.length - 1];
    if (t >= last.t) return last;
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (samples[m].t <= t) lo = m; else hi = m; }
    const a = samples[lo], b = samples[hi], f = (t - a.t) / (b.t - a.t || 1);
    return {
      t, x: a.x + (b.x - a.x) * f, y: Math.max(0, a.y + (b.y - a.y) * f),
      vx: a.vx + (b.vx - a.vx) * f, vy: a.vy + (b.vy - a.vy) * f, phase: a.phase,
    };
  }

  function peakOf(samples) {
    let best = samples[0];
    for (const s of samples) if (s.y > best.y) best = s;
    return best;
  }

  function energyAt(s, mass, datum) {
    const KE = 0.5 * mass * (s.vx * s.vx + s.vy * s.vy);
    const PE = mass * G * (s.y - (datum || 0));
    return { KE, PE, E: KE + PE };
  }

  // ---------- 그리기 도우미 ----------

  function makeGrid(ctx, w, h, worldW, worldH) {
    const padL = 46, padR = 20, padT = 20, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const sx = plotW / worldW, sy = plotH / worldH;
    const originY = padT + plotH;
    const toPx = (x, y) => ({ px: padL + x * sx, py: originY - y * sy });

    ctx.strokeStyle = "#eef0f3"; ctx.lineWidth = 1;
    ctx.font = "11px JetBrains Mono, monospace"; ctx.fillStyle = "#8e8e93";
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";

    const stepX = SimUtils.niceStep(worldW), stepY = SimUtils.niceStep(worldH);
    for (let gx = 0; gx <= worldW; gx += stepX) {
      const { px } = toPx(gx, 0);
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, originY); ctx.stroke();
      ctx.fillText(String(Math.round(gx)), px + 2, originY + 14);
    }
    for (let gy = 0; gy <= worldH; gy += stepY) {
      const { py } = toPx(0, gy);
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(w - padR, py); ctx.stroke();
      ctx.fillText(String(Math.round(gy)), 4, py - 3);
    }
    ctx.strokeStyle = "#a8aab2"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(padL, originY); ctx.lineTo(w - padR, originY); ctx.stroke();
    ctx.fillStyle = "#8e8e93"; ctx.font = "10.5px JetBrains Mono, monospace";
    ctx.fillText("거리(m)", w - padR - 46, originY + 28);
    ctx.fillText("높이(m)", 6, padT - 6);
    return { toPx, originY };
  }

  function drawPath(ctx, pts, toPx, color, width, dashed) {
    if (!pts || !pts.length) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width;
    if (dashed) ctx.setLineDash([5, 5]);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const { px, py } = toPx(p.x, p.y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke(); ctx.restore();
  }

  // ---------- 2단계 : 이론 궤적 ----------

  function drawTheory() {
    const { w, h, ctx } = SimUtils.fitCanvas(theoryCanvas);
    ctx.clearRect(0, 0, w, h);
    const th = sim.theory;
    if (!th) return;

    const bw = Math.max(th.Rtotal, 5) * 1.12 + 1;
    const bh = Math.max(th.Habs, 3) * 1.25 + 1;
    const { toPx, originY } = makeGrid(ctx, w, h, bw, bh);
    const hh = num(videoHeight);

    // 기준선 (발사속력을 얻은 높이)
    const lineY = toPx(0, hh).py;
    ctx.save();
    ctx.strokeStyle = COLOR_GROUND; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(40, lineY); ctx.lineTo(w - 20, lineY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLOR_GROUND; ctx.font = "10.5px JetBrains Mono, monospace";
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText(`h = ${hh.toFixed(2)}m`, w - 22, lineY - 3);
    ctx.restore();

    // 추진 구간 (발사대 → 발사속력 지점) 은 직선으로 근사해 표시
    ctx.save();
    ctx.strokeStyle = COLOR_THRUST; ctx.lineWidth = 3;
    const p0 = toPx(0, 0), p1 = toPx(th.xThrust, hh);
    ctx.beginPath(); ctx.moveTo(p0.px, p0.py); ctx.lineTo(p1.px, p1.py); ctx.stroke();
    ctx.restore();

    const legA = th.samples.filter((s) => s.t <= th.backAtH);
    const legB = th.samples.filter((s) => s.t >= th.backAtH - 1e-9);
    drawPath(ctx, legA, toPx, COLOR_REAL, 3, false);
    drawPath(ctx, legB, toPx, COLOR_GROUND, 3, false);

    // 발사속력 지점
    ctx.save();
    ctx.fillStyle = "rgba(221,91,0,0.15)";
    ctx.beginPath(); ctx.arc(p1.px, p1.py, 14, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = COLOR_REAL; ctx.fillStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p1.px, p1.py, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = COLOR_REAL; ctx.font = "600 11.5px DM Sans, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText("발사속력 지점", p1.px + 18, p1.py - 5);
    ctx.restore();

    if (legA.length) {
      const back = legA[legA.length - 1];
      const bk = toPx(back.x, back.y);
      ctx.save();
      ctx.strokeStyle = COLOR_GROUND; ctx.fillStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(bk.px, bk.py, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = COLOR_GROUND; ctx.font = "600 11px DM Sans, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText("같은 높이로 돌아온 지점", bk.px, bk.py + 9);
      ctx.restore();
    }

    const land = toPx(th.Rtotal, 0);
    ctx.fillStyle = COLOR_GROUND;
    ctx.beginPath(); ctx.arc(land.px, originY, 4.5, 0, Math.PI * 2); ctx.fill();
  }

  function fillTheory() {
    const ok = hasVideoData();
    theoryEmpty.classList.toggle("hidden", ok);
    theoryGrid.classList.toggle("hidden", !ok);
    if (!ok) { sim.theory = null; return; }

    const v = num(videoSpeed), hh = num(videoHeight), ang = Number(angleInput.value);
    const th = twoStepSolution(v, hh, ang, num(videoTime) || 0);
    sim.theory = th;

    factSpeed.textContent = `${v.toFixed(1)} m/s`;
    factAngle.textContent = `${ang}°`;
    factHeight.textContent = `${hh.toFixed(2)} m`;
    factComp.textContent = `${th.vx.toFixed(2)} / ${th.vy.toFixed(2)}`;

    /* 세 열이 눈으로 더해져야 한다. 예전에는 추진 구간이 합계에만 들어가고 행이 없어서
       수평 거리와 시간 열이 "1단계 + 2단계 ≠ 합계"가 됐다. 검산하는 학생이 틀린 줄 안다. */
    ansPH.textContent = `${hh.toFixed(2)} m`;
    ansPR.textContent = `${th.xThrust.toFixed(2)} m`;
    const tThrust = num(videoTime);   // num()은 요소를 받아 value를 읽는다
    ansPT.textContent = tThrust ? `${tThrust.toFixed(2)} s` : "–";
    ansAH.textContent = `+ ${th.Hrel.toFixed(1)} m`;
    ansAR.textContent = `+ ${th.R1.toFixed(1)} m`;
    ansAT.textContent = `+ ${th.T1.toFixed(2)} s`;
    ansBH.textContent = `+ 0 m`;
    ansBR.textContent = `+ ${th.dx.toFixed(2)} m`;
    ansBT.textContent = `+ ${th.dt.toFixed(2)} s`;
    ansRH.textContent = `${th.Habs.toFixed(1)} m`;
    ansRR.textContent = `${th.Rtotal.toFixed(1)} m`;
    ansRT.textContent = num(videoTime) ? `${th.Ttotal.toFixed(2)} s` : `${th.Tfree.toFixed(2)} s`;

    answerNote.innerHTML = num(videoTime)
      ? `수평 거리는 <b>세 조각의 합</b>입니다 — 추진 구간 ${th.xThrust.toFixed(2)} m + 1단계 ${th.R1.toFixed(1)} m + 2단계 ${th.dx.toFixed(2)} m.`
      : `영상에서 <b>추진에 걸린 시간</b>도 재면 전체 비행 시간까지 구할 수 있습니다. 지금은 자유비행 시간만 표시했습니다.`;

    // 역학적 에너지 — 기준면은 발사속력을 얻은 지점
    const m = Number(dryMassInput.value);
    const K1 = 0.5 * m * v * v;
    const K2 = 0.5 * m * th.vx * th.vx;
    const U2 = m * G * th.Hrel;
    enK1.textContent = `${K1.toFixed(1)} J`; enU1.textContent = `0 J`; enE1.textContent = `${K1.toFixed(1)} J`;
    enK2.textContent = `${K2.toFixed(1)} J`; enU2.textContent = `${U2.toFixed(1)} J`; enE2.textContent = `${(K2 + U2).toFixed(1)} J`;
  }

  // ---------- 3단계 : 시뮬레이션 ----------

  function activeSim() { return sim.traj || sim.preview; }

  function refreshPreview() {
    sim.preview = buildSimTrajectory(readInputs());
    const ok = sim.preview.liftoff;
    launchBtn.disabled = !ok;
    simWarn.classList.toggle("hidden", ok);
    if (!ok) simWarn.textContent = REASONS[sim.preview.reason] || "이 조건에서는 발사할 수 없어요.";
    if (sim.tab === "sim") drawSim();
    updateSimReadout();
  }

  function drawSim() {
    const { w, h, ctx } = SimUtils.fitCanvas(simCanvas);
    ctx.clearRect(0, 0, w, h);
    const traj = activeSim();
    if (!traj || !traj.liftoff) {
      ctx.fillStyle = "#8e8e93"; ctx.font = "13px DM Sans, sans-serif";
      ctx.fillText("조건을 조정하면 예상 경로가 나타납니다.", 24, 34);
      return;
    }
    const bw = Math.max(traj.range, 5) * 1.12 + 1;
    const bh = Math.max(traj.maxHeight, 3) * 1.25 + 1;
    const { toPx, originY } = makeGrid(ctx, w, h, bw, bh);

    const mount = toPx(0, 0);
    ctx.fillStyle = "#a8aab2";
    ctx.beginPath();
    ctx.moveTo(mount.px - 9, originY); ctx.lineTo(mount.px + 9, originY);
    ctx.lineTo(mount.px, originY - 12); ctx.closePath(); ctx.fill();

    if (!sim.running && !sim.landed) {
      drawPath(ctx, traj.samples, toPx, COLOR_PREVIEW, 2, true);
      ctx.fillStyle = "#8e8e93"; ctx.font = "12px DM Sans, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText("예상 경로 — [발사]를 누르세요", mount.px + 16, 34);
      return;
    }

    const cutoff = sim.landed ? traj.totalFlightTime : sim.simTime;
    const vis = traj.samples.filter((s) => s.t <= cutoff);
    const tp = vis.filter((s) => s.phase === "thrust");
    const fp = vis.filter((s) => s.phase === "free");
    if (tp.length && fp.length) fp.unshift(tp[tp.length - 1]);
    drawPath(ctx, tp, toPx, COLOR_THRUST, 3, false);
    drawPath(ctx, fp, toPx, COLOR_SIM, 2.5, false);

    const cur = interpAt(traj.samples, cutoff);
    const p = toPx(cur.x, cur.y);
    ctx.save();
    ctx.shadowColor = COLOR_SIM; ctx.shadowBlur = sim.landed ? 0 : 10;
    ctx.fillStyle = COLOR_SIM;
    ctx.beginPath(); ctx.arc(p.px, p.py, 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    if (cutoff >= traj.tBurnout) {
      const bp = toPx(traj.burnout.x, traj.burnout.y);
      ctx.save();
      ctx.strokeStyle = COLOR_SIM; ctx.fillStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(bp.px, bp.py, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = COLOR_SIM; ctx.font = "600 10.5px JetBrains Mono, monospace";
      ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText(`발사속력 ${traj.burnout.speed.toFixed(1)} m/s`, bp.px + 10, bp.py - 6);
      ctx.restore();
    }
  }

  function updateSimReadout() {
    const traj = activeSim();
    if (!traj || !traj.liftoff) { simTag.textContent = "발사 불가"; bigReadout.classList.add("hidden"); return; }
    if (sim.landed) {
      simTag.textContent = "착지 완료";
      bigRange.textContent = `${traj.range.toFixed(1)} m`;
      bigReadout.classList.remove("hidden");
    } else if (sim.running) {
      simTag.textContent = "날아가는 중"; bigReadout.classList.add("hidden");
    } else {
      simTag.textContent = "발사를 눌러 보세요"; bigReadout.classList.add("hidden");
    }
  }

  function fillSimFacts() {
    const traj = sim.traj;
    const ok = !!(traj && traj.liftoff && sim.landed);
    simFacts.classList.toggle("hidden", !ok);
    speedCheck.classList.toggle("hidden", !(ok && hasVideoData()));
    if (!ok) return;

    simSpeedEl.textContent = `${traj.burnout.speed.toFixed(1)} m/s`;
    simHeightEl.textContent = `${traj.burnout.y.toFixed(2)} m`;
    simRangeEl.textContent = `${traj.range.toFixed(1)} m`;
    simTimeEl.textContent = `${traj.totalFlightTime.toFixed(2)} s`;
    simMaxHEl.textContent = `${traj.maxHeight.toFixed(1)} m`;

    if (hasVideoData()) {
      const vv = num(videoSpeed), sv = traj.burnout.speed;
      const diff = ((vv - sv) / sv) * 100;
      const close = Math.abs(diff) < 15;
      speedCheck.className = "speed-check" + (close ? " ok" : " warn-tone");
      speedCheck.innerHTML =
        `<b>영상 ${vv.toFixed(1)} m/s</b> vs <b>시뮬 ${sv.toFixed(1)} m/s</b> ` +
        `(차이 ${diff >= 0 ? "+" : ""}${diff.toFixed(0)}%)<br>` +
        (close
          ? "두 값이 꽤 가깝습니다. 영상 분석과 시뮬레이터의 추진 모형이 서로를 뒷받침해 줍니다."
          : "차이가 큽니다. 영상 분석의 기준 길이·프레임 수를 다시 확인하거나, 실험 조건이 시뮬레이터 설정과 같은지 살펴보세요.");
    }
  }

  // ---------- 4단계 : 비교 ----------

  function metricRows() {
    const traj = sim.traj, th = sim.theory;
    return [
      { key: "range", label: "도달 거리", unit: "m",
        real: num(realRange), theory: th ? th.Rtotal : null, simv: traj ? traj.range : null,
        drag: traj ? traj.withDrag.range : null },
      { key: "time", label: "비행 시간", unit: "s",
        real: num(realTime), theory: th ? (num(videoTime) ? th.Ttotal : th.Tfree) : null,
        simv: traj ? traj.totalFlightTime : null, drag: traj ? traj.withDrag.totalFlightTime : null },
      { key: "height", label: "최고 높이", unit: "m",
        real: num(realHeight), theory: th ? th.Habs : null, simv: traj ? traj.maxHeight : null,
        drag: traj ? traj.withDrag.maxHeight : null },
    ];
  }

  function drawBars(canvas, rows) {
    const { w, h, ctx } = SimUtils.fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!rows.length) return;
    const padL = 76, padR = 54, padT = 8;
    const rowH = (h - padT - 6) / rows.length;
    const n = rows[0].bars.length;
    const barH = Math.min(14, (rowH - 16) / n);
    const plotW = w - padL - padR;

    rows.forEach((row, i) => {
      const top = padT + i * rowH;
      const max = Math.max(...row.bars.map((b) => b.value || 0), 1e-6);
      const blockH = n * (barH + 3) - 3;
      const startY = top + (rowH - blockH) / 2;

      ctx.fillStyle = "#5f5f5f"; ctx.font = "600 11.5px DM Sans, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText(row.label, 4, startY - 3);

      row.bars.forEach((bar, k) => {
        const y = startY + k * (barH + 3);
        ctx.fillStyle = "#f2f3f5"; ctx.fillRect(padL, y, plotW, barH);
        if (bar.value != null && isFinite(bar.value)) {
          ctx.fillStyle = bar.color;
          ctx.fillRect(padL, y, Math.max(2, (bar.value / max) * plotW), barH);
          ctx.fillStyle = "#5f5f5f"; ctx.font = "10.5px JetBrains Mono, monospace";
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(`${bar.value.toFixed(1)}${row.unit}`, padL + plotW + 5, y + barH / 2);
        } else {
          ctx.fillStyle = "#c7c7cc"; ctx.font = "10px DM Sans, sans-serif";
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText("미입력", padL + plotW + 5, y + barH / 2);
        }
        ctx.fillStyle = bar.color; ctx.font = "9.5px DM Sans, sans-serif";
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        ctx.fillText(bar.name, padL - 5, y + barH / 2);
      });
    });
  }

  function drawCompare() {
    const rows = metricRows().map((m) => {
      const bars = [
        { name: "① 실측", value: m.real, color: COLOR_GROUND },
        { name: "② 영상이론", value: m.theory, color: COLOR_REAL },
      ];
      if (sim.dragRevealed) bars.push({ name: "저항포함", value: m.drag, color: COLOR_DRAG });
      bars.push({ name: "③ 시뮬", value: m.simv, color: COLOR_SIM });
      return { label: m.label, unit: m.unit, bars };
    });
    drawBars(compareChart, rows);
    updateErrorTable();
  }

  function fmt(v, u) { return v == null ? '<span class="none">–</span>' : `${v.toFixed(1)}${u}`; }

  function updateErrorTable() {
    const rows = metricRows();
    errBody.innerHTML = rows.map((m) => {
      let errCell = '<span class="none">–</span>';
      if (m.real != null && m.theory != null) {
        const pct = ((m.real - m.theory) / m.theory) * 100;
        errCell = `<span class="${pct < 0 ? "neg" : "pos"}">${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%</span>`;
      }
      return `<tr><td>${m.label}</td><td>${fmt(m.real, m.unit)}</td>` +
             `<td>${fmt(m.theory, m.unit)}</td><td>${fmt(m.simv, m.unit)}</td><td>${errCell}</td></tr>`;
    }).join("");

    const pairs = rows.filter((m) => m.real != null && m.theory != null);
    if (!pairs.length) {
      diagnosis.className = "diagnosis";
      diagnosis.textContent = "실측값과 영상 분석값을 모두 입력하면 진단이 나타납니다.";
    } else {
      const shorter = pairs.filter((m) => (m.real - m.theory) / m.theory < -0.1);
      if (shorter.length === pairs.length && pairs.length >= 2) {
        diagnosis.className = "diagnosis alert";
        diagnosis.innerHTML = `측정한 <b>${pairs.length}개 값이 모두</b> 이론값보다 작습니다. ` +
          `한두 개라면 측정 실수일 수 있지만 <b>전부 같은 방향으로 치우쳤다면 우연이 아닙니다.</b> ` +
          `이론 계산에 넣지 않은 무언가가 로켓을 방해했다는 뜻이에요.`;
      } else if (shorter.length) {
        diagnosis.className = "diagnosis alert";
        diagnosis.innerHTML = `일부 값만 이론과 크게 다릅니다. 그 항목의 <b>측정 방법</b>을 다시 확인해 보세요.`;
      } else {
        diagnosis.className = "diagnosis";
        diagnosis.textContent = "실측과 이론이 비교적 잘 맞습니다.";
      }
    }
    updateQuestions();
  }

  function updateQuestions() {
    const rows = metricRows();
    const r = rows[0];
    const items = [];
    if (r.real == null || r.theory == null) {
      questionList.innerHTML = "<li>값을 모두 입력하면 질문이 나타납니다.</li>";
      return;
    }

    items.push(`영상에서 잰 발사속력으로 계산한 도달 거리는 <b>${r.theory.toFixed(1)} m</b>인데 ` +
      `실제로는 <b>${r.real.toFixed(1)} m</b>를 날아갔습니다. 이론이 실제보다 큰 이유를 <b>힘의 관점</b>에서 설명해 보세요.`);

    if (r.simv != null) {
      const gap = Math.abs(r.theory - r.simv);
      items.push(`같은 발사를 두 가지 방법으로 예측했더니 ② 영상 이론 <b>${r.theory.toFixed(1)} m</b>, ` +
        `③ 시뮬레이션 <b>${r.simv.toFixed(1)} m</b>로 <b>${gap.toFixed(1)} m</b> 차이가 났습니다. ` +
        `두 방법은 무엇이 다르기에 값이 갈렸을까요?`);
    }

    if (sim.dragRevealed && r.drag != null) {
      const g0 = Math.abs(r.real - r.simv), g1 = Math.abs(r.real - r.drag);
      items.push(`공기 저항을 넣으니 예측이 <b>${r.simv.toFixed(1)} m → ${r.drag.toFixed(1)} m</b>로 바뀌어 ` +
        `실측과의 차이가 ${g0.toFixed(1)} m에서 <b>${g1.toFixed(1)} m</b>로 줄었습니다. 아직 남은 차이는 무엇 때문일까요?`);
    } else {
      items.push(`오른쪽 <b>[공기 저항을 넣고 다시 계산]</b>을 눌러, 내가 고른 원인이 맞는지 확인해 보세요.`);
    }

    if (sim.traj && sim.traj.rodExit) {
      items.push(`이 로켓은 발사 후 <b>${sim.traj.rodExit.t.toFixed(2)}초</b>에 가이드막대(27 cm)를 벗어났는데 ` +
        `그때 물이 아직 <b>${Math.round(sim.traj.rodExit.vwFrac * 100)}%</b> 남아 있었습니다. ` +
        `이것이 <b>발사 각도</b>에 어떤 영향을 줄까요?`);
    }

    items.push(`역학적 에너지 그래프에서 공기 저항이 없을 때와 있을 때가 <b>어떻게 다른가요?</b> 줄어든 에너지는 어디로 갔을까요?`);
    questionList.innerHTML = items.map((s) => `<li>${s}</li>`).join("");
  }

  function drawEnergy() {
    const { w, h, ctx } = SimUtils.fitCanvas(energyChart);
    ctx.clearRect(0, 0, w, h);
    const traj = sim.traj;
    if (!traj || !traj.liftoff || !sim.landed) return;

    const src = sim.dragRevealed ? traj.withDrag.samples : traj.samples;
    const pts = [
      { name: "발사속력 지점", s: traj.burnout },
      { name: "최고점", s: peakOf(src) },
      { name: "땅에 닿을 때", s: src[src.length - 1] },
    ].map((p) => Object.assign({ name: p.name }, energyAt(p.s, traj.mass, 0)));

    const maxE = Math.max(...pts.map((p) => p.E), 1e-6);
    const padB = 32, padT = 22, plotH = h - padB - padT;
    const bw = Math.min(64, (w - 40) / pts.length - 18);
    const gap = (w - pts.length * bw) / (pts.length + 1);

    pts.forEach((p, i) => {
      const x = gap + i * (bw + gap);
      const keH = (p.KE / maxE) * plotH, peH = (p.PE / maxE) * plotH;
      const base = padT + plotH;
      ctx.fillStyle = COLOR_GROUND; ctx.fillRect(x, base - peH, bw, peH);
      ctx.fillStyle = COLOR_REAL; ctx.fillRect(x, base - peH - keH, bw, keH);
      ctx.fillStyle = "#5f5f5f"; ctx.font = "600 11px JetBrains Mono, monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(`${p.E.toFixed(1)}J`, x + bw / 2, base - peH - keH - 5);
      ctx.font = "10.5px DM Sans, sans-serif"; ctx.textBaseline = "top";
      ctx.fillText(p.name, x + bw / 2, base + 7);
    });

    ctx.strokeStyle = "#a8aab2"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(10, padT + plotH); ctx.lineTo(w - 10, padT + plotH); ctx.stroke();

    const first = pts[0].E, last = pts[pts.length - 1].E;
    energyMsg.textContent = Math.abs(last - first) / first < 0.02
      ? "공기 저항이 없을 때 — 세 지점의 역학적 에너지가 모두 같습니다. 운동 에너지와 위치 에너지가 서로 바뀔 뿐 합은 변하지 않아요."
      : `공기 저항이 있을 때 — 역학적 에너지가 ${first.toFixed(1)}J → ${last.toFixed(1)}J로 줄었습니다. 사라진 것이 아니라 공기와의 마찰로 열·소리로 바뀐 것입니다.`;
  }

  function fillCompare() {
    const ok = hasMeasured() && hasVideoData() && sim.landed;
    compareEmpty.classList.toggle("hidden", ok);
    compareGrid.classList.toggle("hidden", !ok);
    if (ok && sim.tab === "compare") { drawCompare(); drawEnergy(); }
  }

  // ---------- 렌더 ----------

  function render() {
    if (sim.tab === "theory") drawTheory();
    else if (sim.tab === "sim") { drawSim(); updateSimReadout(); }
    else if (sim.tab === "compare") { drawCompare(); drawEnergy(); }
  }

  function refreshAll() {
    fillTheory();
    fillSimFacts();
    fillCompare();
    updateRecordStatus();
    render();
  }

  function updateRecordStatus() {
    const need = [];
    if (!hasMeasured()) need.push("실측 도달 거리·비행 시간");
    if (!hasVideoData()) need.push("영상 분석 발사속력·높이");
    if (need.length) {
      recordStatus.className = "record-status";
      recordStatus.textContent = `아직 입력이 필요합니다 — ${need.join(", ")}`;
    } else {
      recordStatus.className = "record-status ok";
      recordStatus.textContent = "입력 완료! 2단계에서 이론값을 계산하고, 3단계에서 시뮬레이션과 비교해 보세요.";
    }
  }

  // ---------- 애니메이션 ----------

  function frame(ts) {
    if (!sim.running) return;
    if (sim.lastFrame == null) sim.lastFrame = ts;
    const dt = (ts - sim.lastFrame) / 1000;
    sim.lastFrame = ts;
    sim.simTime += dt * sim.timeScale;
    if (sim.simTime >= sim.traj.totalFlightTime) {
      sim.simTime = sim.traj.totalFlightTime;
      sim.running = false; sim.landed = true;
      launchBtn.disabled = false;
      fillSimFacts(); fillCompare();
    }
    drawSim(); updateSimReadout();
    if (sim.running) requestAnimationFrame(frame);
  }

  function launch() {
    const traj = buildSimTrajectory(readInputs());
    if (!traj.liftoff) { refreshPreview(); return; }
    sim.traj = traj; sim.preview = null;
    sim.simTime = 0; sim.lastFrame = null;
    sim.running = true; sim.landed = false;
    sim.timeScale = Number(speedSelect.value);
    launchBtn.disabled = true;
    resetDragTest();
    requestAnimationFrame(frame);
  }

  function resetDragTest() {
    sim.dragRevealed = false;
    dragTestBtn.classList.remove("hidden");
    dragResult.classList.add("hidden");
  }

  function reset() {
    sim.traj = null; sim.running = false; sim.landed = false; sim.simTime = 0;
    launchBtn.disabled = false;
    document.querySelectorAll(".cause input").forEach((c) => { c.checked = false; });
    resetDragTest();
    refreshPreview();
    refreshAll();
  }

  // ---------- 탭 ----------

  function switchTab(name) {
    sim.tab = name;
    stepButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    Object.entries(panels).forEach(([k, p]) => p.classList.toggle("active", k === name));
    render();
  }
  stepButtons.forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // ---------- 라벨 ----------

  function syncLabels() {
    waterValue.textContent = `${waterInput.value} mL`;
    pressureValue.textContent = `${Number(pressureInput.value).toFixed(1)} atm`;
    angleValue.textContent = `${angleInput.value}°`;
    bottleValue.textContent = `${bottleInput.value} mL`;
    nozzleValue.textContent = `${nozzleInput.value} mm`;
    dryMassValue.textContent = `${Number(dryMassInput.value).toFixed(3)} kg`;
    diameterValue.textContent = `${diameterInput.value} cm`;
    echoWater.textContent = `${waterInput.value} mL`;
    echoPressure.textContent = `${Number(pressureInput.value).toFixed(1)} atm`;
    echoAngle.textContent = `${angleInput.value}°`;
  }

  // ---------- 이벤트 ----------

  function onConditionChange() {
    syncLabels();
    sim.traj = null; sim.landed = false;
    resetDragTest();
    refreshPreview();
    refreshAll();
  }

  [waterInput, pressureInput, angleInput, nozzleInput, dryMassInput, diameterInput]
    .forEach((i) => i.addEventListener("input", onConditionChange));

  bottleInput.addEventListener("input", () => {
    const cap = Math.round(Number(bottleInput.value) * 0.95);
    waterInput.max = cap;
    if (Number(waterInput.value) > cap) waterInput.value = cap;
    onConditionChange();
  });

  [realRange, realTime, realHeight, videoSpeed, videoHeight, videoTime]
    .forEach((i) => i.addEventListener("input", refreshAll));

  speedSelect.addEventListener("change", () => { sim.timeScale = Number(speedSelect.value); });

  revealBtn.addEventListener("click", () => {
    answerBody.classList.remove("hidden");
    revealBtn.classList.add("hidden");
  });

  dragTestBtn.addEventListener("click", () => {
    if (!sim.traj || !sim.traj.liftoff) return;
    sim.dragRevealed = true;
    dragTestBtn.classList.add("hidden");
    const t = sim.traj, r = num(realRange);
    let msg = `공기 저항을 넣으니 시뮬레이션 도달 거리가 <b>${t.range.toFixed(1)} m → ${t.withDrag.range.toFixed(1)} m</b>로 줄었습니다.`;
    if (r != null) {
      const g0 = Math.abs(r - t.range), g1 = Math.abs(r - t.withDrag.range);
      msg += g1 < g0
        ? ` 실측 ${r.toFixed(1)} m와의 차이가 <b>${g0.toFixed(1)} m → ${g1.toFixed(1)} m</b>로 줄었으니, 차이의 상당 부분은 공기 저항 때문이었습니다.`
        : ` 그런데 실측 ${r.toFixed(1)} m와 더 가까워지지는 않았습니다. 다른 원인을 더 찾아보세요.`;
    }
    dragResult.innerHTML = msg;
    dragResult.classList.remove("hidden");
    drawCompare(); drawEnergy();
  });

  launchBtn.addEventListener("click", launch);
  resetBtn.addEventListener("click", reset);

  teacherToggle.addEventListener("click", () => settingsOverlay.classList.remove("hidden"));
  settingsClose.addEventListener("click", () => settingsOverlay.classList.add("hidden"));
  settingsBackdrop.addEventListener("click", () => settingsOverlay.classList.add("hidden"));

  window.addEventListener("resize", render);

  // ---------- 시작 ----------

  syncLabels();
  refreshPreview();
  refreshAll();
})();
