/* ============================================================
   물로켓 영상 분석 — 색 테이프 추적으로 발사속력 구하기

   흐름: ① 영상 → ② 기준 길이·지면 → ③ 테이프 색 → ④ 추적 → ⑤ 결과

   좌표계가 셋이라 헷갈리기 쉬우니 이름을 구분해서 쓴다.
     · natural : 영상 원본 픽셀 (video.videoWidth × videoHeight)
     · display : 화면에 보이는 오버레이 캔버스 CSS 픽셀 (object-fit: contain)
     · work    : 픽셀 분석용 축소 캔버스 (최대 720px 폭)
   저장하는 점 좌표는 전부 natural 기준이다.

   영상은 URL.createObjectURL로만 읽고 어디로도 전송하지 않는다.
   ============================================================ */

(() => {
  "use strict";

  const WORK_MAX_W = 720;   // 픽셀 분석 해상도 상한 (프레임당 연산량 제한)
  const MIN_BLOB_PX = 3;    // 이보다 작은 색 덩어리는 노이즈로 본다

  /* 추적 범위(ROI) — 범위 밖 픽셀은 아예 읽지 않는다.
     놓친 프레임마다 반지름을 키워 잠깐의 모션 블러/가림을 넘긴다. */
  const ROI_GROW = 1.5;         // 놓칠 때마다 반지름 배율
  const ROI_MAX_MULT = 4;       // 처음 반지름의 몇 배까지 넓힐지
  const ROI_FRAME_FRAC = 1 / 3; // 화면 폭의 이 비율은 절대 넘지 않는다
  const V_TYPICAL = 25;         // 권장 반지름 계산용 물로켓 기준 속력 (m/s)

  const COLOR_ACCENT = "#0066cc";   /* CSS --accent와 반드시 같이 바꿀 것 */
  const COLOR_TRACK = "#ff3b30";    /* 궤적 점 */
  const COLOR_TRACK_MANUAL = "#af52de";   /* 손으로 찍은 점 — 자동(빨강)과 확실히 구분 */
  const COLOR_SCALE = "#30d158";
  const COLOR_GROUND = "#64d2ff";
  const COLOR_ROI = "#ffffff";      /* 추적 범위 원 */
  const COLOR_PEAK = "#ffd60a";     /* 발사속력(연소종료) 지점 */

  const MAG_SRC = 19;               // 돋보기가 읽어 오는 원본 픽셀 한 변 (홀수여야 가운데가 생긴다)
  const MAG_VIEW = 136;             // 화면에 그리는 돋보기 한 변

  /* ---------- DOM ---------- */

  const $ = (id) => document.getElementById(id);

  const video = $("video");
  const overlay = $("overlay");
  const stage = $("stage");
  const stageDrop = $("stageDrop");
  const stageMode = $("stageMode");
  const stageBusy = $("stageBusy");

  const fileInput = $("fileInput");
  const pickBtn = $("pickBtn");
  const fpsInput = $("fpsInput");
  const fpsDetected = $("fpsDetected");
  const slowSelect = $("slowSelect");
  const shotFps = $("shotFps");
  const fallbackBox = $("fallbackBox");
  const effBox = $("effBox");
  const manualBtn = $("manualBtn");

  const playBtn = $("playBtn");
  const prevFrameBtn = $("prevFrameBtn");
  const nextFrameBtn = $("nextFrameBtn");
  const scrubber = $("scrubber");
  const timeReadout = $("timeReadout");
  const frameReadout = $("frameReadout");

  const setStartBtn = $("setStartBtn");
  const setEndBtn = $("setEndBtn");
  const clearRangeBtn = $("clearRangeBtn");
  const gotoStartBtn = $("gotoStartBtn");
  const gotoEndBtn = $("gotoEndBtn");
  const rangeReadout = $("rangeReadout");

  const scaleBtn = $("scaleBtn");
  const scaleLength = $("scaleLength");
  const scaleReadout = $("scaleReadout");
  const groundBtn = $("groundBtn");
  const groundReadout = $("groundReadout");

  const swatchRow = $("swatchRow");
  const pickColorBtn = $("pickColorBtn");
  const resampleBtn = $("resampleBtn");
  const colorReadout = $("colorReadout");
  const roiReadout = $("roiReadout");
  const roiAdvice = $("roiAdvice");
  const roiRadius = $("roiRadius");
  const roiRadiusVal = $("roiRadiusVal");
  const hueTol = $("hueTol");
  const hueTolVal = $("hueTolVal");
  const satMin = $("satMin");
  const satMinVal = $("satMinVal");
  const maskToggle = $("maskToggle");
  const maskReadout = $("maskReadout");

  const trackBtn = $("trackBtn");
  const progressWrap = $("progressWrap");
  const progressFill = $("progressFill");
  const trackReadout = $("trackReadout");
  const retrackBtn = $("retrackBtn");
  const delFromHereBtn = $("delFromHereBtn");
  const delPointBtn = $("delPointBtn");
  const clearPointsBtn = $("clearPointsBtn");

  const rateSelect = $("rateSelect");
  const loopRange = $("loopRange");
  const probeEmpty = $("probeEmpty");
  const probeBox = $("probeBox");
  const probeSpeed = $("probeSpeed");
  const probeHeight = $("probeHeight");
  const probeTime = $("probeTime");
  const setPeakBtn = $("setPeakBtn");
  const peakTag = $("peakTag");
  const autoPeakBtn = $("autoPeakBtn");

  const gCheck = $("gCheck");
  const graph = $("graph");
  const resSpeed = $("resSpeed");
  const resHeight = $("resHeight");
  const resTime = $("resTime");
  const resAngle = $("resAngle");
  const copyAllBtn = $("copyAllBtn");

  /* ---------- 상태 ---------- */

  const state = {
    loaded: false,
    objectUrl: null,
    file: null,
    frameTimes: null,   // 파일에서 읽은 프레임별 표시 시각(초). 못 읽으면 null
    shotFps: 240,       // 촬영 프레임레이트 — 실제 경과 시간 환산의 유일한 기준
    fps: 30,            // (폴백) 파일 프레임레이트
    slow: 1,            // (폴백) 슬로모 배속
    manual: false,      // 손으로 찍기 모드
    duration: 0,
    frameCount: 0,

    scale: null,        // { x1, y1, x2, y2 } natural
    pxPerM: null,
    groundY: null,      // natural y
    groundManual: false,

    target: null,       // { h, s, v, hex }
    roi: null,          // 사용자가 그린 기준 범위 { x, y, r } (natural px)
    mode: null,         // 'scale' | 'color' | 'recolor' | 'ground' | null
    dragging: null,
    hover: null,        // 돋보기가 들여다보는 지점 (natural 좌표)

    points: new Map(),  // frameIndex -> { x, y, manual }
    rois: new Map(),    // frameIndex -> { x, y, r, grown } — 되감아 볼 때 범위를 그리려고 보관
    rangeStart: null,
    rangeEnd: null,

    tracking: false,
    abort: false,

    series: null,        // 계산된 결과 배열
    /* 지점은 배열 순번이 아니라 **프레임 번호**로 들고 있어야 한다.
       점을 하나 추가하면 순번이 통째로 밀려 엉뚱한 점을 가리키기 때문. */
    peakFrame: null,     // 발사속력 지점의 프레임 번호
    peakPinned: false,   // 사용자가 직접 지정했는가 (아니면 매번 자동으로 다시 찾는다)
    selectedFrame: null, // 살펴보기로 클릭한 지점의 프레임 번호
    openStep: 1,
  };

  /* 픽셀 분석용 오프스크린 캔버스 */
  const work = document.createElement("canvas");
  const workCtx = work.getContext("2d", { willReadFrequently: true });
  const maskCanvas = document.createElement("canvas");
  const maskCtx = maskCanvas.getContext("2d");

  /* 돋보기 전용 — 커서 주변 원본 픽셀만 1:1로 떠 온다 (work 캔버스는 축소본이라 색이 뭉갠다) */
  const mag = document.createElement("canvas");
  mag.width = MAG_SRC;
  mag.height = MAG_SRC;
  const magCtx = mag.getContext("2d", { willReadFrequently: true });

  /* ============================================================
     MP4/MOV 프레임 시각표 직접 읽기

     브라우저의 fps 자동 감지는 못 믿는다. 화면 주사율에 걸려 240fps 영상을
     30fps로 재는 일이 있고, 휴대폰 영상은 프레임 간격이 제각각인 가변
     프레임레이트(VFR)라 "1/fps 간격"이라는 가정 자체가 틀린다.
     그래서 컨테이너 안의 시각표(stts/ctts)를 직접 읽어 프레임마다 정확한
     표시 시각을 얻는다. 이러면 fps를 물어볼 필요가 없다.
     ============================================================ */

  /** 파일 앞에서부터 최상위 atom 머리말만 훑어 moov 위치를 찾는다 (97MB를 통째로 읽지 않으려고). */
  async function findMoov(file) {
    let pos = 0;
    while (pos + 8 <= file.size) {
      const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
      if (head.byteLength < 8) break;
      let size = head.getUint32(0);
      let hdr = 8;
      const type = String.fromCharCode(
        head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
      if (size === 1) {
        if (head.byteLength < 16) break;
        size = Number(head.getBigUint64(8));
        hdr = 16;
      }
      if (size === 0) size = file.size - pos;
      if (size < hdr) break;
      if (type === "moov") return { start: pos + hdr, end: pos + size };
      pos += size;
    }
    return null;
  }

  /** moov 안을 재귀로 훑어 원하는 atom들을 모은다. */
  function walkAtoms(dv, base, start, end, want, out) {
    let p = start;
    const CONTAINERS = ["trak", "mdia", "minf", "stbl", "edts"];
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      let hdr = 8;
      const type = String.fromCharCode(
        dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
      if (size === 0) size = end - p;
      if (size < hdr) break;
      if (want.indexOf(type) >= 0) out.push({ type, start: p + hdr, end: p + size });
      if (CONTAINERS.indexOf(type) >= 0) walkAtoms(dv, base, p + hdr, p + size, want, out);
      p += size;
    }
  }

  /**
   * 영상 트랙의 프레임 표시 시각을 초 단위 배열로 돌려준다.
   * 실패하면 null (MP4/MOV가 아니거나 구조가 예상과 다름).
   */
  async function readFrameTimes(file) {
    try {
      const moov = await findMoov(file);
      if (!moov) return null;
      const buf = await file.slice(moov.start - 8, moov.end).arrayBuffer();
      const dv = new DataView(buf);
      const found = [];
      // moov 내용은 위에서 8바이트 머리말을 포함해 잘랐으므로 8부터 시작
      walkAtoms(dv, 0, 8, buf.byteLength, ["trak", "hdlr", "mdhd", "stts", "ctts", "stsz"], found);

      const traks = found.filter((a) => a.type === "trak");
      for (const t of traks) {
        const inside = (a) => a.start >= t.start && a.end <= t.end;
        const hdlr = found.find((a) => a.type === "hdlr" && inside(a));
        if (!hdlr) continue;
        const kind = String.fromCharCode(
          dv.getUint8(hdlr.start + 8), dv.getUint8(hdlr.start + 9),
          dv.getUint8(hdlr.start + 10), dv.getUint8(hdlr.start + 11));
        if (kind !== "vide") continue;

        const mdhd = found.find((a) => a.type === "mdhd" && inside(a));
        const stts = found.find((a) => a.type === "stts" && inside(a));
        const ctts = found.find((a) => a.type === "ctts" && inside(a));
        if (!mdhd || !stts) return null;

        const ver = dv.getUint8(mdhd.start);
        const timescale = ver === 1 ? dv.getUint32(mdhd.start + 20) : dv.getUint32(mdhd.start + 12);
        if (!timescale) return null;

        // stts: 디코딩 순서의 시각
        const nEnt = dv.getUint32(stts.start + 4);
        const decode = [];
        let acc = 0;
        for (let i = 0; i < nEnt; i++) {
          const cnt = dv.getUint32(stts.start + 8 + i * 8);
          const dlt = dv.getUint32(stts.start + 12 + i * 8);
          for (let k = 0; k < cnt; k++) { decode.push(acc); acc += dlt; }
        }
        if (!decode.length) return null;

        // ctts: B프레임이 있으면 표시 순서가 디코딩 순서와 다르다
        let times = decode;
        if (ctts) {
          const cEnt = dv.getUint32(ctts.start + 4);
          const offs = [];
          for (let i = 0; i < cEnt; i++) {
            const cnt = dv.getUint32(ctts.start + 8 + i * 8);
            const off = dv.getInt32(ctts.start + 12 + i * 8);
            for (let k = 0; k < cnt; k++) offs.push(off);
          }
          if (offs.length === decode.length) {
            times = decode.map((d, i) => d + offs[i]);
            times.sort((a, b) => a - b);
          }
        }
        return {
          times: times.map((v) => v / timescale),
          timescale,
          duration: acc / timescale,
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /* ============================================================
     좌표 변환
     ============================================================ */

  /** 오버레이 캔버스 안에서 영상이 실제로 그려지는 사각형 (object-fit: contain). */
  function videoRect() {
    const bw = overlay.clientWidth;
    const bh = overlay.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !bw || !bh) return null;
    const s = Math.min(bw / vw, bh / vh);
    const w = vw * s;
    const h = vh * s;
    return { x: (bw - w) / 2, y: (bh - h) / 2, w, h, s };
  }

  function toDisplay(nx, ny) {
    const r = videoRect();
    if (!r) return null;
    return { x: r.x + nx * r.s, y: r.y + ny * r.s };
  }

  function toNatural(dx, dy) {
    const r = videoRect();
    if (!r) return null;
    return { x: (dx - r.x) / r.s, y: (dy - r.y) / r.s };
  }

  /** 마우스 이벤트 → 오버레이 CSS 픽셀 좌표. */
  function eventPos(ev) {
    const rect = overlay.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  /* ============================================================
     색 공간
     ============================================================ */

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function hueDist(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* ============================================================
     프레임 접근
     ============================================================ */

  /** 프레임 i의 파일 재생 시각. 프레임 경계 대신 한가운데를 찍어야 디코더가 안 헷갈린다. */
  function frameTime(i) {
    const ft = state.frameTimes;
    if (ft && ft.length) {
      const j = Math.max(0, Math.min(ft.length - 1, i));
      const a = ft[j];
      let b;
      if (j + 1 < ft.length) b = ft[j + 1];
      else if (j > 0) b = a + (a - ft[j - 1]);   // 마지막 프레임은 직전 간격을 그대로 씀
      else b = a + 0.01;
      return (a + b) / 2;
    }
    return (i + 0.5) / state.fps;
  }

  /** roundRect는 비교적 최신 API라 없으면 각진 사각형으로 대체한다 (그리기 전체가 죽지 않게). */
  function roundRectPath(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") { ctx.roundRect(x, y, w, h, r); return; }
    ctx.rect(x, y, w, h);
  }

  /**
   * 프레임 i의 실제 경과 시각.
   * 파일에서 시각표를 읽었으면 프레임 간격이 곧 촬영 간격이므로 i/촬영fps가 정확하다.
   * (슬로모 영상은 촬영한 프레임을 전부 담은 채 느리게 재생될 뿐이다.)
   */
  function realTime(i) {
    if (state.frameTimes) return i / state.shotFps;
    return i / (state.fps * state.slow);
  }

  function currentFrame() {
    const ft = state.frameTimes;
    if (ft) {
      // 표시 시각표에서 현재 재생 위치가 속한 구간을 이분 탐색
      const t = video.currentTime;
      let lo = 0, hi = ft.length - 1;
      if (t <= ft[0]) return 0;
      if (t >= ft[hi]) return hi;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ft[mid] <= t) lo = mid; else hi = mid - 1;
      }
      return lo;
    }
    return Math.max(0, Math.min(state.frameCount - 1, Math.floor(video.currentTime * state.fps)));
  }

  function seekTo(t) {
    return new Promise((resolve) => {
      const clamped = Math.max(0, Math.min(state.duration - 1e-4, t));
      if (Math.abs(video.currentTime - clamped) < 1e-4) { resolve(); return; }
      const onSeeked = () => { video.removeEventListener("seeked", onSeeked); resolve(); };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = clamped;
    });
  }

  function gotoFrame(i) {
    return seekTo(frameTime(Math.max(0, Math.min(state.frameCount - 1, i))));
  }

  /* ============================================================
     ① 영상 불러오기
     ============================================================ */

  function loadFile(file) {
    if (!file || !file.type.startsWith("video/")) {
      alert("영상 파일이 아닙니다. mp4 / mov / webm 파일을 넣어 주세요.");
      return;
    }
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);

    resetAnalysis();
    state.frameTimes = null;
    state.file = file;
    video.src = state.objectUrl;

    video.addEventListener("loadedmetadata", onMetadata, { once: true });
  }

  async function onMetadata() {
    state.loaded = true;
    state.duration = video.duration || 0;
    stageDrop.hidden = true;

    const w = Math.min(WORK_MAX_W, video.videoWidth);
    work.width = w;
    work.height = Math.round((video.videoHeight / video.videoWidth) * w);
    maskCanvas.width = work.width;
    maskCanvas.height = work.height;

    setStepState(1, "읽는 중…");
    const parsed = await readFrameTimes(state.file);

    if (parsed && parsed.times.length > 1) {
      state.frameTimes = parsed.times;
      state.frameCount = parsed.times.length;
      fallbackBox.hidden = true;
      fpsDetected.innerHTML = "파일에서 프레임 시각표를 직접 읽었습니다 &mdash; 프레임레이트를 맞출 필요가 없습니다.";
    } else {
      // MP4/MOV가 아니거나 구조가 달라 못 읽은 경우에만 수동 입력으로 돌아간다
      state.frameTimes = null;
      fallbackBox.hidden = false;
      fpsDetected.textContent = "파일에서 프레임 정보를 읽지 못했습니다. 아래에서 직접 맞춰 주세요.";
      const fps = await detectFps();
      if (fps) fpsInput.value = String(Math.round(fps));
    }

    recalcFrames();
    setStepState(1, "완료");
    markDone(1);
    enableAfterLoad();
    applyRate();          // src를 바꾸면 playbackRate가 1로 초기화된다
    gotoFrame(0).then(redraw);
  }

  /**
   * requestVideoFrameCallback으로 프레임 표시 간격을 재서 fps를 추정한다.
   * 지원하지 않는 브라우저면 null을 돌려주고 사용자 입력에 맡긴다.
   */
  function detectFps() {
    return new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback !== "function") { resolve(null); return; }
      const times = [];
      let last = null;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        video.pause();
        video.currentTime = 0;
        if (times.length < 4) { resolve(null); return; }
        times.sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)];
        if (!median || median <= 0) { resolve(null); return; }
        const raw = 1 / median;
        // 흔한 촬영 규격으로 스냅 (24 / 25 / 30 / 50 / 60 / 120 / 240)
        const common = [24, 25, 30, 50, 60, 100, 120, 240];
        const snapped = common.find((c) => Math.abs(raw - c) / c < 0.06);
        resolve(snapped || Math.round(raw * 10) / 10);
      };

      const step = (now, meta) => {
        if (done) return;
        if (last !== null) {
          const dt = meta.mediaTime - last;
          if (dt > 0.0005 && dt < 0.5) times.push(dt);
        }
        last = meta.mediaTime;
        if (times.length >= 24) { finish(); return; }
        video.requestVideoFrameCallback(step);
      };

      video.muted = true;
      video.currentTime = 0;
      const p = video.play();
      if (p && p.catch) p.catch(() => resolve(null));
      video.requestVideoFrameCallback(step);
      setTimeout(finish, 2500);
    });
  }

  function recalcFrames() {
    const prevCount = state.frameCount;
    state.shotFps = Math.max(1, Number(shotFps.value) || 240);

    if (state.frameTimes) {
      state.frameCount = state.frameTimes.length;
      const play = state.duration || state.frameTimes[state.frameTimes.length - 1];
      const real = state.frameCount / state.shotFps;
      const slowMult = real > 0 ? play / real : 1;
      effBox.innerHTML =
        "파일에서 읽음 &middot; <b class='mono'>" + state.frameCount.toLocaleString() + "</b> 프레임"
        + " &middot; 재생 <b class='mono'>" + play.toFixed(2) + "</b> s<br>"
        + "촬영 " + state.shotFps + " fps &rarr; 실제 동작 <b class='mono'>" + real.toFixed(2) + "</b> s"
        + " &middot; 슬로우 <b class='mono'>&times;" + slowMult.toFixed(2) + "</b><br>"
        + "한 프레임 = <b class='mono'>" + (1 / state.shotFps).toFixed(5) + "</b> s (실제)";
    } else {
      state.fps = Math.max(1, Number(fpsInput.value) || 30);
      state.slow = Math.max(1, Number(slowSelect.value) || 1);
      state.frameCount = Math.max(1, Math.floor(state.duration * state.fps));
      const eff = state.fps * state.slow;
      effBox.innerHTML = "실효 프레임레이트 <b class='mono'>" + eff.toFixed(0) + "</b> fps"
        + " &middot; 한 프레임 <b class='mono'>" + (1 / eff).toFixed(4) + "</b> s"
        + " &middot; 총 <b class='mono'>" + state.frameCount.toLocaleString() + "</b> 프레임(추정)";
    }

    /* 프레임 개수가 바뀌면 이미 찍어 둔 점들의 프레임 번호가 의미를 잃는다.
       (촬영 fps만 바꾸는 것은 시간 축만 다시 재는 것이라 점을 살려도 된다.)
       그대로 두면 엉뚱한 시각에 매달린 값이 조용히 나오므로 지우고 알린다. */
    if (prevCount && state.frameCount !== prevCount && state.points.size) {
      state.points.clear();
      state.rois.clear();
      state.selectedFrame = null;
      state.peakFrame = null;
      state.peakPinned = false;
      trackReadout.textContent = "프레임 기준이 바뀌어 점을 지웠습니다 — 다시 추적하세요.";
      delPointBtn.disabled = true;
      clearPointsBtn.disabled = true;
      retrackBtn.disabled = true;
    }

    scrubber.max = String(Math.max(0, state.frameCount - 1));
    updateTransport();
    updateRoiReadout();   // 권장 반지름은 프레임 간격에 의존한다
    computeResults();
  }

  /* ============================================================
     ② 기준 길이 · 지면
     ============================================================ */

  function updateScaleReadout() {
    if (!state.scale) {
      scaleReadout.textContent = "기준선이 아직 없습니다.";
      state.pxPerM = null;
      return;
    }
    const len = Math.hypot(state.scale.x2 - state.scale.x1, state.scale.y2 - state.scale.y1);
    const meters = Math.max(0.01, Number(scaleLength.value) || 1);
    state.pxPerM = len / meters;
    scaleReadout.textContent = len.toFixed(1) + " px = " + meters.toFixed(2) + " m  ·  "
      + state.pxPerM.toFixed(1) + " px/m";

    if (!state.groundManual) {
      state.groundY = Math.max(state.scale.y1, state.scale.y2);
      groundReadout.innerHTML = "기준선의 <b>아래쪽 끝</b>을 지면으로 봅니다.";
    }
    markDone(2);
    setStepState(2, "완료");
    updateRoiReadout();   // 권장 반지름은 px/m에 의존한다
    computeResults();
  }

  /* ============================================================
     ③ 테이프 색
     ============================================================ */

  function setTarget(hex) {
    const { r, g, b } = hexToRgb(hex);
    const hsv = rgbToHsv(r, g, b);
    state.target = { h: hsv.h, s: hsv.s, v: hsv.v, hex };
    [...swatchRow.children].forEach((sw) => {
      sw.classList.toggle("is-active", sw.dataset.color.toLowerCase() === hex.toLowerCase());
    });
    hueTol.disabled = false;
    satMin.disabled = false;
    maskToggle.disabled = false;
    resampleBtn.disabled = !state.roi;
    colorReadout.textContent = "찾는 색 " + hex
      + "  ·  색상 " + Math.round(hsv.h) + "°"
      + "  ·  선명도 " + hsv.s.toFixed(2)
      + "  ·  밝기 " + hsv.v.toFixed(2)
      + (hsv.s < 0.25 ? "   ← 너무 흐릿합니다. 테이프의 밝은 부분을 다시 고르세요." : "");
    // 색만으로는 부족하다 — 범위까지 지정해야 추적할 수 있다.
    trackBtn.disabled = !state.roi;
    if (state.roi) { markDone(3); setStepState(3, "완료"); }
    else setStepState(3, "범위 필요");
    redraw();
  }

  /**
   * 현재 프레임에서 **추적 범위 안쪽만** 읽어 색 마스크를 만든다.
   * 원의 바깥은 아예 getImageData 대상에서 빠지므로, 범위 밖의 같은 색은
   * 존재 자체가 보이지 않는다 — 이게 오검출을 막는 핵심이다.
   * 반환 좌표는 잘라낸 사각형 기준이고, ox/oy/ws로 natural로 되돌린다.
   */
  function buildMask(roi) {
    if (!state.target || !state.loaded || !roi) return null;
    workCtx.drawImage(video, 0, 0, work.width, work.height);

    const ws = work.width / video.videoWidth;
    const cx = roi.x * ws, cy = roi.y * ws, cr = Math.max(2, roi.r * ws);
    const x0 = Math.max(0, Math.floor(cx - cr));
    const y0 = Math.max(0, Math.floor(cy - cr));
    const x1 = Math.min(work.width - 1, Math.ceil(cx + cr));
    const y1 = Math.min(work.height - 1, Math.ceil(cy + cr));
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < 1 || bh < 1) return null;

    let img;
    try {
      img = workCtx.getImageData(x0, y0, bw, bh);
    } catch (e) {
      // 다른 출처 영상이면 캔버스가 오염돼 픽셀을 못 읽는다 (로컬 파일에서는 발생하지 않음)
      return null;
    }
    const data = img.data;
    const mask = new Uint8Array(bw * bh);
    const tolH = Number(hueTol.value);
    const sMin = Number(satMin.value);
    const vMin = 0.18;
    const cr2 = cr * cr;
    let count = 0;

    for (let ly = 0; ly < bh; ly++) {
      const dy = y0 + ly - cy;
      for (let lx = 0; lx < bw; lx++) {
        const dx = x0 + lx - cx;
        if (dx * dx + dy * dy > cr2) continue;   // 원 밖은 건너뛴다
        const i = ly * bw + lx;
        const o = i * 4;
        const hsv = rgbToHsv(data[o], data[o + 1], data[o + 2]);
        if (hsv.s >= sMin && hsv.v >= vMin && hueDist(hsv.h, state.target.h) <= tolH) {
          mask[i] = 1;
          count++;
        }
      }
    }
    return { mask, count, w: bw, h: bh, ox: x0, oy: y0, ws };
  }

  /**
   * 마스크에서 이어진 덩어리를 찾아 **가장 큰 것**을 고른다.
   * 위치 판정은 이미 범위(원)가 했으므로 여기서는 크기만 본다.
   * 범위 안에 아무것도 없으면 null — 화면 다른 곳을 뒤지는 예비 경로는 없다.
   */
  function findBlob(maskInfo) {
    const { mask, w, h, ox, oy, ws } = maskInfo;
    const n = w * h;
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    let best = null;

    for (let start = 0; start < n; start++) {
      if (!mask[start] || seen[start]) continue;
      let sp = 0;
      stack[sp++] = start;
      seen[start] = 1;
      let size = 0, sx = 0, sy = 0;
      while (sp > 0) {
        const p = stack[--sp];
        const px = p % w;
        const py = (p - px) / w;
        size++; sx += px; sy += py;
        if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (px < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (py > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (py < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (size >= MIN_BLOB_PX && (!best || size > best.size)) {
        best = { size, x: sx / size, y: sy / size };
      }
    }
    if (!best) return null;
    return { x: (ox + best.x) / ws, y: (oy + best.y) / ws, size: best.size };
  }

  /**
   * 재생 속도 선택값을 "한 프레임에 몇 ms"로 바꾼다. 자동 추적을 그 속도로 진행시켜
   * 어디서 틀어지는지 눈으로 볼 수 있게 한다. 0이면 늦추지 않는다(최대 속도).
   */
  function trackPaceMs() {
    const val = String(rateSelect.value);
    if (val.startsWith("step")) {
      const fps = Number(val.replace("step", "")) || 4;
      return 1000 / fps;
    }
    const rate = Number(val) || 1;
    if (rate >= 1) return 0;
    // 파일의 실제 재생 프레임레이트를 기준으로 삼는다
    const playFps = state.duration > 0 ? state.frameCount / state.duration : 30;
    return 1000 / (playFps * rate);
  }

  /** 범위 반지름의 상한 — 처음 크기의 배수와 화면 폭 중 작은 쪽. */
  function roiMaxRadius() {
    const base = state.roi ? state.roi.r : 40;
    return Math.min(base * ROI_MAX_MULT, video.videoWidth * ROI_FRAME_FRAC);
  }

  /** 직전 두 점으로 다음 위치를 외삽한다. 범위는 여기를 중심으로 미끄러진다. */
  function predictNext(prev, prev2) {
    if (prev && prev2) return { x: 2 * prev.x - prev2.x, y: 2 * prev.y - prev2.y };
    return prev || null;
  }

  /* ============================================================
     ④ 추적
     ============================================================ */

  /**
   * @param {number|null} startAt 이 프레임부터 다시 추적한다. null이면 구간 처음부터.
   *   이어서 추적할 때는 앞선 점 두 개로 속도를 되살려야 범위가 곧바로 제 위치를 잡는다.
   */
  async function runTracking(startAt) {
    if (state.tracking) { state.abort = true; return; }
    if (!state.target || !state.roi) return;

    state.tracking = true;
    state.abort = false;
    stopSlowPlay();
    trackBtn.textContent = "중지";
    stageBusy.hidden = false;
    progressWrap.hidden = false;
    video.pause();

    const rangeFrom = state.rangeStart != null ? state.rangeStart : 0;
    const to = state.rangeEnd != null ? state.rangeEnd : state.frameCount - 1;
    const from = startAt != null ? Math.max(rangeFrom, startAt) : rangeFrom;

    // 수동으로 고친 점은 살리고, 자동으로 찍은 점만 다시 계산한다.
    for (const [f, p] of [...state.points]) {
      if (!p.manual && f >= from && f <= to) state.points.delete(f);
    }
    for (const f of [...state.rois.keys()]) if (f >= from && f <= to) state.rois.delete(f);

    // 이어서 시작하는 경우, 직전 두 점을 되살려 속도(=범위 이동 방향)를 물려받는다.
    let prev = null, prev2 = null;
    if (startAt != null) {
      const before = [...state.points.keys()].filter((f) => f < from).sort((a, b) => a - b);
      if (before.length >= 1) prev = state.points.get(before[before.length - 1]);
      if (before.length >= 2) prev2 = state.points.get(before[before.length - 2]);
    }

    const baseR = state.roi.r;
    const maxR = roiMaxRadius();
    let radius = baseR;
    // 이어서 시작할 때는 직전 점에서, 처음이면 사용자가 그린 원에서 출발한다.
    let center = prev ? { x: prev.x, y: prev.y } : { x: state.roi.x, y: state.roi.y };
    let found = 0, missed = 0;

    const paceMs = trackPaceMs();

    for (let f = from; f <= to; f++) {
      if (state.abort) break;
      const frameStarted = Date.now();
      await gotoFrame(f);

      // 범위는 "다음에 여기 있을 것"을 중심으로 미끄러진다.
      const guess = predictNext(prev, prev2);
      if (guess) center = guess;

      const roi = { x: center.x, y: center.y, r: radius };

      const manual = state.points.get(f);
      if (manual && manual.manual) {
        state.rois.set(f, { x: manual.x, y: manual.y, r: baseR, grown: false });
        prev2 = prev;
        prev = manual;
        center = { x: manual.x, y: manual.y };
        radius = baseR;
        found++;
        continue;
      }

      const maskInfo = buildMask(roi);
      const blob = maskInfo ? findBlob(maskInfo) : null;

      if (blob) {
        state.points.set(f, { x: blob.x, y: blob.y, manual: false });
        state.rois.set(f, { x: roi.x, y: roi.y, r: radius, grown: radius > baseR + 0.5 });
        prev2 = prev;
        prev = blob;
        radius = baseR;              // 찾았으니 원래 크기로 복귀
        found++;
      } else {
        // 범위 밖은 보지 않는다. 대신 잠시 넓히며 예측 위치로 계속 전진한다.
        state.rois.set(f, { x: roi.x, y: roi.y, r: radius, grown: true });
        radius = Math.min(maxR, radius * ROI_GROW);
        if (prev) { prev2 = prev; prev = { x: center.x, y: center.y }; }
        missed++;
      }

      const pct = ((f - from + 1) / (to - from + 1)) * 100;
      progressFill.style.width = pct.toFixed(1) + "%";

      /* 재생 속도 선택값에 맞춰 추적 진행을 늦춘다.
         눈으로 따라가며 어디서 틀어지는지 보려면 이게 필요하다. ×1이면 사실상 최대 속도. */
      if (paceMs > 0) {
        redraw();
        const wait = paceMs - (Date.now() - frameStarted);
        await new Promise((r) => setTimeout(r, wait > 0 ? wait : 0));
      } else if ((f - from) % 4 === 0) {
        redraw();
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    state.tracking = false;
    trackBtn.textContent = "자동 추적 시작";
    stageBusy.hidden = true;
    progressWrap.hidden = true;

    trackReadout.textContent = "찾음 " + found + "프레임 · 놓침 " + missed + "프레임"
      + (missed > found * 0.3 ? "  ← 범위를 키우거나 허용 오차를 넓혀 보세요" : "");
    delPointBtn.disabled = false;
    clearPointsBtn.disabled = false;
    retrackBtn.disabled = false;
    delFromHereBtn.disabled = false;
    if (found >= 3) {
      markDone(4);
      setStepState(4, "완료");
    } else {
      setStepState(4, "재시도");
    }
    computeResults();
    redraw();
  }

  /* ============================================================
     ⑤ 결과 계산
     ============================================================ */

  function computeResults() {
    state.series = null;
    if (!state.pxPerM || state.groundY == null || state.points.size < 3) {
      renderResults();
      return;
    }

    const frames = [...state.points.keys()].sort((a, b) => a - b);
    const pts = frames.map((f) => {
      const p = state.points.get(f);
      return {
        f,
        t: realTime(f),
        X: p.x / state.pxPerM,
        Y: (state.groundY - p.y) / state.pxPerM,
        manual: p.manual,
      };
    });

    // 중앙차분 — 앞뒤 한 점씩 쓰므로 양 끝은 속력을 못 구한다.
    const v = new Array(pts.length).fill(null);
    for (let i = 1; i < pts.length - 1; i++) {
      const dt = pts[i + 1].t - pts[i - 1].t;
      if (dt <= 0) continue;
      const dx = pts[i + 1].X - pts[i - 1].X;
      const dy = pts[i + 1].Y - pts[i - 1].Y;
      v[i] = Math.hypot(dx, dy) / dt;
    }

    // 3점 이동평균 — 한 프레임 튄 값이 최대 속력으로 뽑히는 걸 막는다.
    const vs = v.slice();
    for (let i = 1; i < v.length - 1; i++) {
      const a = v[i - 1], b = v[i], c = v[i + 1];
      const arr = [a, b, c].filter((x) => x != null);
      if (b != null && arr.length) vs[i] = arr.reduce((s, x) => s + x, 0) / arr.length;
    }

    const idxOfFrame = (f) => pts.findIndex((p) => p.f === f);

    /* 발사속력 지점은 점이 하나라도 바뀌면 **매번 다시** 찾는다.
       예전에는 한 번 정하면 유효한 동안 그대로 뒀는데, 자동 추적이 두어 프레임만
       잡은 상태에서 정해진 지점이 그대로 굳어, 그 뒤로 손으로 아무리 점을 찍어도
       최댓값이 갱신되지 않았다. */
    let autoIdx = null;
    for (let i = 0; i < vs.length; i++) {
      if (vs[i] == null) continue;
      if (autoIdx === null || vs[i] > vs[autoIdx]) autoIdx = i;
    }

    let peakIdx = null;
    if (state.peakPinned && state.peakFrame != null) {
      const j = idxOfFrame(state.peakFrame);
      if (j >= 0 && vs[j] != null) peakIdx = j;
    }
    if (peakIdx == null) { peakIdx = autoIdx; state.peakPinned = false; }
    state.peakFrame = peakIdx != null ? pts[peakIdx].f : null;

    let selIdx = null;
    if (state.selectedFrame != null) {
      const j = idxOfFrame(state.selectedFrame);
      if (j >= 0 && vs[j] != null) selIdx = j;
      else state.selectedFrame = null;
    }

    state.series = { pts, v, vs, peakIdx, selIdx };
    renderResults();
  }

  /**
   * 자유비행 구간의 연직 가속도를 측정해 9.8과 비교한다.
   * 이건 자기 검산 장치다 — 기준 길이(px/m)나 촬영 fps가 틀리면 측정값이 어긋나는데,
   * 어긋나는 방식이 달라서 원인을 좁힐 수 있다.
   *   · 기준 길이를 c배로 잘못 넣으면  a는 c배   (Y ∝ 입력한 기준 길이, buildSeries 참고)
   *   · fps를 τ배로 잘못 넣으면        a는 τ² 배 (시간은 제곱으로 들어간다)
   * ⚠️ 방향에 주의 — 속력도 a도 기준 길이에 **정비례**한다. 그래서 영상 속력이 부풀려져
   * 있으면 a도 9.8보다 크게 나온다(작게가 아니다). 시간 오류는 제곱이라 훨씬 크게
   * 어긋나므로, 두 원인은 값의 크기로 구분된다.
   * 최고점 이후 점들에 y = y0 + v·t − ½a·t² 를 최소제곱으로 맞춘다.
   */
  function measuredGravity() {
    const s = state.series;
    if (!s || s.peakIdx == null) return null;
    const from = s.peakIdx;
    const pts = s.pts.slice(from);
    if (pts.length < 5) return null;

    // t는 구간 시작 기준. [1, t, t²] 최소제곱 → t² 계수가 −a/2
    const t0 = pts[0].t;
    let n = 0, St = 0, St2 = 0, St3 = 0, St4 = 0, Sy = 0, Sty = 0, St2y = 0;
    for (const p of pts) {
      const t = p.t - t0, y = p.Y;
      const t2 = t * t;
      n++; St += t; St2 += t2; St3 += t2 * t; St4 += t2 * t2;
      Sy += y; Sty += t * y; St2y += t2 * y;
    }
    // 3×3 정규방정식을 크라메르 공식으로 푼다
    const m = [[n, St, St2], [St, St2, St3], [St2, St3, St4]];
    const rhs = [Sy, Sty, St2y];
    const det = (a) =>
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
      - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
      + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const D = det(m);
    if (!isFinite(D) || Math.abs(D) < 1e-12) return null;
    const m2 = m.map((row, i) => [row[0], row[1], rhs[i]]);
    const c2 = det(m2) / D;          // t² 계수
    const g = -2 * c2;
    if (!isFinite(g)) return null;
    return { g, n };
  }

  /** 한 지점의 속력·높이·경과시간. 속력은 이동평균이 아니라 원래 값을 쓴다. */
  function pointValues(i) {
    const s = state.series;
    if (!s || i == null || s.vs[i] == null) return null;
    return {
      speed: s.v[i] != null ? s.v[i] : s.vs[i],
      height: s.pts[i].Y,
      elapsed: s.pts[i].t - s.pts[0].t,
      frame: s.pts[i].f,
    };
  }

  function renderResults() {
    const s = state.series;
    const peak = s ? pointValues(s.peakIdx) : null;

    if (!peak) {
      resSpeed.innerHTML = "&ndash;";
      resHeight.innerHTML = "&ndash;";
      resTime.innerHTML = "&ndash;";
      resAngle.innerHTML = "&ndash;";
      copyAllBtn.disabled = true;
      document.querySelectorAll(".btn-copy").forEach((b) => (b.disabled = true));
      probeBox.hidden = true;
      probeEmpty.hidden = false;
      gCheck.hidden = true;
      setStepState(5, "대기");
      drawGraph();
      return;
    }

    resSpeed.textContent = peak.speed.toFixed(1) + " m/s";
    resHeight.textContent = peak.height.toFixed(2) + " m";
    resTime.textContent = peak.elapsed.toFixed(3) + " s";

    const i = s.peakIdx;
    peakTag.textContent = state.peakPinned ? "직접 지정" : "자동 판정";
    let angleTxt = "프레임 " + peak.frame;
    if (i > 0 && i < s.pts.length - 1) {
      const dx = s.pts[i + 1].X - s.pts[i - 1].X;
      const dy = s.pts[i + 1].Y - s.pts[i - 1].Y;
      const deg = (Math.atan2(dy, Math.abs(dx)) * 180) / Math.PI;
      angleTxt = "진행 방향 " + deg.toFixed(0) + "° · 프레임 " + peak.frame;
    }
    resAngle.textContent = angleTxt;

    // 중력 검산 — 측정이 옳다면 자유비행 구간의 연직 가속도가 9.8이어야 한다
    const gm = measuredGravity();
    if (!gm) {
      gCheck.hidden = true;
    } else {
      gCheck.hidden = false;
      const ratio = gm.g / 9.8;
      const off = Math.abs(ratio - 1) * 100;
      let verdict, tone;
      if (off <= 15) { verdict = "측정이 물리와 잘 맞습니다."; tone = ""; }
      else {
        // 입력값에 "곱해서" 고칠 수를 알려준다 — 「몇 배 틀렸다」는 방향이 헷갈린다.
        const cScale = (1 / ratio).toFixed(2);          // 2단계 기준 길이에 곱할 수
        const tScale = Math.sqrt(1 / ratio).toFixed(2); // 1단계 촬영 fps에 곱할 수
        const dir = ratio > 1 ? "크게" : "작게";
        // 시간 오류는 제곱으로 들어가므로 2배 넘게 어긋나면 fps 쪽을 먼저 의심한다.
        const fpsFirst = ratio >= 2 || ratio <= 0.5;
        verdict = "<b>어긋납니다.</b> 속력도 같은 비율로 틀어져 있습니다. "
          + (fpsFirst
              ? "이만큼 크게 어긋나는 건 대개 <b>1단계 촬영 fps</b>입니다 (시간은 제곱으로 들어갑니다). "
                + "fps에 <b>×" + tScale + "</b>을 하면 9.8이 됩니다. "
                + "fps가 맞다면 2단계 기준 길이에 <b>×" + cScale + "</b>."
              : "기준 길이를 실제보다 <b>" + dir + "</b> 잡았을 때 나오는 값입니다. "
                + "2단계 기준 길이에 <b>×" + cScale + "</b>을 하면 9.8이 됩니다. "
                + "기준선이 맞다면 1단계 fps에 <b>×" + tScale + "</b>.");
        tone = "warn";
      }
      gCheck.className = "callout " + tone;
      gCheck.innerHTML = "<b>중력 검산</b> 자유비행 구간(" + gm.n + "점)에서 잰 연직 가속도 = <b>"
        + gm.g.toFixed(1) + " m/s&sup2;</b> · 참값 9.8 m/s&sup2; &rarr; " + verdict;
    }

    // 살펴보기 — 클릭한 지점이 있을 때만
    const probe = pointValues(s.selIdx);
    if (probe) {
      probeSpeed.textContent = probe.speed.toFixed(1) + " m/s";
      probeHeight.textContent = probe.height.toFixed(2) + " m";
      probeTime.textContent = probe.elapsed.toFixed(3) + " s";
      probeBox.hidden = false;
      probeEmpty.hidden = true;
      const same = s.selIdx === s.peakIdx;
      setPeakBtn.disabled = same;
      setPeakBtn.textContent = same ? "이 지점이 현재 발사속력입니다" : "이 지점을 발사속력으로";
    } else {
      probeBox.hidden = true;
      probeEmpty.hidden = false;
    }
    // 직접 지정을 풀고 자동 판정으로 되돌릴 수 있게
    autoPeakBtn.hidden = !state.peakPinned;

    copyAllBtn.disabled = false;
    document.querySelectorAll(".btn-copy").forEach((b) => (b.disabled = false));
    markDone(5);
    setStepState(5, "완료");
    drawGraph();
  }

  function drawGraph() {
    const { w, h, ctx } = SimUtils.fitCanvas(graph);
    ctx.clearRect(0, 0, w, h);
    const s = state.series;

    const padL = 34, padR = 10, padT = 12, padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    ctx.strokeStyle = "#e0e0e0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    if (!s) {
      ctx.fillStyle = "#a8aab2";
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("추적하면 속력 그래프가 나타납니다", w / 2, h / 2);
      return;
    }

    const valid = s.vs.map((x, i) => ({ x, i })).filter((d) => d.x != null);
    if (valid.length < 2) return;

    const t0 = s.pts[0].t;
    const tMax = Math.max(...valid.map((d) => s.pts[d.i].t - t0)) || 1;
    const vMax = Math.max(...valid.map((d) => Math.max(d.x, s.v[d.i] || 0))) * 1.15 || 1;

    const gx = (t) => padL + (t / tMax) * plotW;
    const gy = (val) => padT + plotH - (val / vMax) * plotH;

    const step = SimUtils.niceStep(vMax, 3);
    ctx.fillStyle = "#a8aab2";
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textAlign = "right";
    for (let val = 0; val <= vMax; val += step) {
      const y = gy(val);
      ctx.strokeStyle = "#f0f0f0";
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillText(String(Math.round(val)), padL - 6, y + 3);
    }

    // 원래 값은 흐리게 — 학생이 얼마나 흔들리는지 눈으로 보게 한다
    ctx.strokeStyle = "rgba(0,102,204,0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    valid.forEach((d, k) => {
      const x = gx(s.pts[d.i].t - t0);
      const y = gy(s.v[d.i]);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.strokeStyle = COLOR_ACCENT;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    valid.forEach((d, k) => {
      const x = gx(s.pts[d.i].t - t0);
      const y = gy(d.x);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 살펴보기 지점 — 파란 얇은 선
    if (s.selIdx != null && s.vs[s.selIdx] != null) {
      const x = gx(s.pts[s.selIdx].t - t0);
      const y = gy(s.v[s.selIdx] != null ? s.v[s.selIdx] : s.vs[s.selIdx]);
      ctx.strokeStyle = COLOR_ACCENT;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLOR_ACCENT;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    }

    // 발사속력 지점 — 금색 마커 + 값 라벨
    if (s.peakIdx != null && s.vs[s.peakIdx] != null) {
      const pv = pointValues(s.peakIdx);
      const x = gx(s.pts[s.peakIdx].t - t0);
      const y = gy(pv.speed);
      ctx.strokeStyle = COLOR_PEAK;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLOR_PEAK;
      ctx.strokeStyle = "#8a6d00";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

      const label = pv.speed.toFixed(1) + " m/s";
      ctx.font = "600 11px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(label).width;
      // 오른쪽 끝에 붙으면 라벨이 잘리므로 왼쪽으로 뒤집는다
      let lx = x + 9;
      if (lx + tw + 8 > padL + plotW) lx = x - tw - 17;
      const ly = Math.max(padT + 11, y - 9);
      ctx.fillStyle = COLOR_PEAK;
      ctx.beginPath();
      roundRectPath(ctx, lx - 4, ly - 11, tw + 9, 15, 4);
      ctx.fill();
      ctx.fillStyle = "#3d3100";
      ctx.fillText(label, lx, ly);
    }

    ctx.fillStyle = "#a8aab2";
    ctx.textAlign = "left";
    ctx.fillText("t (s)", padL, h - 5);
    ctx.textAlign = "right";
    ctx.fillText(tMax.toFixed(2), padL + plotW, h - 5);
  }

  graph.addEventListener("click", (ev) => {
    const s = state.series;
    if (!s) return;
    const rect = graph.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const padL = 34, padR = 10;
    const plotW = rect.width - padL - padR;
    const t0 = s.pts[0].t;
    const valid = s.vs.map((x, i) => ({ x, i })).filter((d) => d.x != null);
    if (!valid.length) return;
    const tMax = Math.max(...valid.map((d) => s.pts[d.i].t - t0)) || 1;
    const tClick = ((px - padL) / plotW) * tMax;
    let best = valid[0];
    for (const d of valid) {
      if (Math.abs(s.pts[d.i].t - t0 - tClick) < Math.abs(s.pts[best.i].t - t0 - tClick)) best = d;
    }
    // 클릭은 "살펴보기"만 바꾼다. 발사속력은 [이 지점을 발사속력으로]로만 바뀐다.
    state.selectedFrame = s.pts[best.i].f;
    computeResults();
    gotoFrame(s.pts[best.i].f).then(() => { updateTransport(); redraw(); });
  });

  /* ============================================================
     오버레이 그리기
     ============================================================ */

  function redraw() {
    const { w, h, ctx } = SimUtils.fitCanvas(overlay);
    ctx.clearRect(0, 0, w, h);
    if (!state.loaded) return;
    const r = videoRect();
    if (!r) return;

    // 이 프레임에 실제로 쓰인 추적 범위 (없으면 사용자가 그린 기준 범위)
    const liveRoi = state.dragging && state.dragging.kind === "roi"
      ? state.dragging.roi
      : (state.rois.get(currentFrame()) || state.roi);

    // 검출 마스크 겹쳐 보기 — 범위 안쪽만 칠해진다
    if (maskToggle.checked && state.target && liveRoi) {
      const info = buildMask(liveRoi);
      if (info) {
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        const img = maskCtx.createImageData(info.w, info.h);
        const rgb = hexToRgb(COLOR_ACCENT);
        for (let i = 0; i < info.mask.length; i++) {
          if (!info.mask[i]) continue;
          const o = i * 4;
          img.data[o] = rgb.r; img.data[o + 1] = rgb.g; img.data[o + 2] = rgb.b; img.data[o + 3] = 150;
        }
        maskCtx.putImageData(img, info.ox, info.oy);
        ctx.drawImage(maskCanvas, r.x, r.y, r.w, r.h);
        maskReadout.textContent = "범위 안에서 " + info.count + "px 검출";
      }
    }

    // 추적 범위 — 로켓을 따라 미끄러지는 원. 넓어진 상태는 점선.
    if (liveRoi && liveRoi.r > 0) {
      const c = toDisplay(liveRoi.x, liveRoi.y);
      const rr = liveRoi.r * r.s;
      ctx.strokeStyle = liveRoi.grown ? "rgba(255,204,0,0.95)" : COLOR_ROI;
      ctx.lineWidth = 1.8;
      ctx.setLineDash(liveRoi.grown ? [5, 4] : []);
      ctx.beginPath(); ctx.arc(c.x, c.y, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      // 범위 밖을 살짝 어둡게 눌러 "여기만 본다"를 눈으로 보여 준다
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.arc(c.x, c.y, rr, 0, Math.PI * 2, true);
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fill("evenodd");
      ctx.restore();
    }

    // 지면선
    if (state.groundY != null) {
      const p = toDisplay(0, state.groundY);
      ctx.strokeStyle = COLOR_GROUND;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(r.x, p.y); ctx.lineTo(r.x + r.w, p.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLOR_GROUND;
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText("지면", r.x + 6, p.y - 6);
    }

    // 기준선
    const sc = state.dragging && state.dragging.kind === "scale" ? state.dragging.line : state.scale;
    if (sc) {
      const a = toDisplay(sc.x1, sc.y1);
      const b = toDisplay(sc.x2, sc.y2);
      ctx.strokeStyle = COLOR_SCALE;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      [a, b].forEach((p) => {
        ctx.fillStyle = COLOR_SCALE;
        ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2); ctx.fill();
      });
      ctx.fillStyle = COLOR_SCALE;
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText((Number(scaleLength.value) || 1).toFixed(2) + " m", (a.x + b.x) / 2 + 8, (a.y + b.y) / 2);
    }

    // 궤적
    if (state.points.size) {
      const frames = [...state.points.keys()].sort((a, b) => a - b);
      ctx.strokeStyle = "rgba(255,59,48,0.5)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      frames.forEach((f, k) => {
        const p = state.points.get(f);
        const d = toDisplay(p.x, p.y);
        if (k === 0) ctx.moveTo(d.x, d.y); else ctx.lineTo(d.x, d.y);
      });
      ctx.stroke();

      const cur = currentFrame();
      frames.forEach((f) => {
        const p = state.points.get(f);
        const d = toDisplay(p.x, p.y);
        const isCur = f === cur;
        ctx.fillStyle = p.manual ? COLOR_TRACK_MANUAL : COLOR_TRACK;
        ctx.beginPath(); ctx.arc(d.x, d.y, isCur ? 6 : 2.6, 0, Math.PI * 2); ctx.fill();
        if (isCur) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(d.x, d.y, 9, 0, Math.PI * 2); ctx.stroke();
        }
      });

      // 궤적 위에 연소종료 지점과 살펴보기 지점을 표시한다
      const s = state.series;
      const markPoint = (idx, color, label) => {
        if (idx == null || !s || !s.pts[idx]) return;
        const p = state.points.get(s.pts[idx].f);
        if (!p) return;
        const d = toDisplay(p.x, p.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(d.x, d.y, 13, 0, Math.PI * 2); ctx.stroke();
        ctx.font = "600 11px 'JetBrains Mono', monospace";
        const tw = ctx.measureText(label).width;
        const lx = Math.min(d.x + 18, r.x + r.w - tw - 10);
        ctx.fillStyle = "rgba(0,0,0,0.62)";
        ctx.beginPath(); roundRectPath(ctx, lx - 5, d.y - 9, tw + 10, 17, 5); ctx.fill();
        ctx.fillStyle = color;
        ctx.fillText(label, lx, d.y + 3.5);
      };
      markPoint(s ? s.selIdx : null, COLOR_ACCENT, "선택");
      markPoint(s ? s.peakIdx : null, COLOR_PEAK, "발사속력");
    }

    // 지금 찾고 있는 색 — 무엇을 뜻하는 표시인지 라벨로 밝혀 둔다
    if (state.target) {
      const label = "이 색을 찾는 중";
      ctx.font = "11px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(label).width;
      const cx = r.x + r.w - 20;
      const cy = r.y + 20;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      roundRectPath(ctx, cx - tw - 34, cy - 12, tw + 44, 25, 12);
      ctx.fill();
      ctx.fillStyle = state.target.hex;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx - 9, cy, 8, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "right";
      ctx.fillText(label, cx - 22, cy + 4);
      ctx.textAlign = "left";
    }

    // 돋보기는 맨 위에 — 색을 고르는 동안에만
    if (state.mode === "color" || state.mode === "recolor") drawMagnifier(ctx, r);
  }

  /**
   * 돋보기 — 색을 고르기 **전에** 어떤 픽셀을 집게 되는지 보여 준다.
   * 커서 주변 MAG_SRC×MAG_SRC 원본 픽셀을 확대해 그리고, 한가운데 픽셀을
   * 네모로 표시한 뒤 그 색의 hex와 선명도를 함께 띄운다.
   * 범위를 드래그하는 중에는 커서가 아니라 **드래그를 시작한 점**(= 실제로 색을 읽는 자리)을 본다.
   */
  function drawMagnifier(ctx, r) {
    const h = state.hover;
    if (!h || !video.videoWidth) return;

    const half = (MAG_SRC - 1) / 2;
    const sx = Math.max(0, Math.min(video.videoWidth - MAG_SRC, Math.round(h.x) - half));
    const sy = Math.max(0, Math.min(video.videoHeight - MAG_SRC, Math.round(h.y) - half));

    // 라벨 값은 실제 샘플링과 **같은 함수**로 구한다 (원본 3×3 평균)
    const picked = readColorAt(h.x, h.y);
    if (!picked) return;
    const hex = picked.hex, hsv = picked.hsv;

    // readColorAt이 mag 캔버스를 쓰므로, 확대 이미지는 그 뒤에 다시 그린다
    magCtx.clearRect(0, 0, MAG_SRC, MAG_SRC);
    magCtx.drawImage(video, sx, sy, MAG_SRC, MAG_SRC, 0, 0, MAG_SRC, MAG_SRC);

    const c = toDisplay(h.x, h.y);
    const pad = 18;
    const labelH = 30;
    let bx = c.x + pad;
    let by = c.y - MAG_VIEW - pad;
    if (bx + MAG_VIEW > r.x + r.w) bx = c.x - MAG_VIEW - pad;
    if (by < r.y) by = c.y + pad;
    bx = Math.max(r.x + 4, Math.min(r.x + r.w - MAG_VIEW - 4, bx));
    by = Math.max(r.y + 4, Math.min(r.y + r.h - MAG_VIEW - labelH - 4, by));

    // 확대 이미지 — 픽셀이 뭉개지지 않게 보간을 끈다
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mag, 0, 0, MAG_SRC, MAG_SRC, bx, by, MAG_VIEW, MAG_VIEW);
    ctx.restore();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(bx - 1, by - 1, MAG_VIEW + 2, MAG_VIEW + 2);

    // 실제로 읽는 3×3 영역을 네모로 표시 — 이 안의 평균이 곧 잡히는 색이다
    const cell = MAG_VIEW / MAG_SRC;
    const cx = bx + (Math.round(h.x) - sx - 1) * cell;
    const cy = by + (Math.round(h.y) - sy - 1) * cell;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3;
    ctx.strokeRect(cx, cy, cell * 3, cell * 3);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx, cy, cell * 3, cell * 3);

    // 색값 라벨
    const sat = hsv ? hsv.s : 0;
    const txt = hex + "   선명도 " + sat.toFixed(2);
    ctx.font = "600 12px 'JetBrains Mono', monospace";
    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.beginPath();
    roundRectPath(ctx, bx - 1, by + MAG_VIEW + 3, MAG_VIEW + 2, labelH - 6, 6);
    ctx.fill();
    ctx.fillStyle = hex;
    ctx.fillRect(bx + 5, by + MAG_VIEW + 8, 14, 14);
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 5, by + MAG_VIEW + 8, 14, 14);
    ctx.fillStyle = sat < 0.25 ? "#ff9f0a" : "#ffffff";
    ctx.textAlign = "left";
    ctx.fillText(txt, bx + 25, by + MAG_VIEW + 19);
  }

  /* ============================================================
     스테이지 상호작용
     ============================================================ */

  function setMode(mode, label) {
    state.mode = mode;
    // 색 고르기를 벗어나면 돋보기도 치운다
    if (mode !== "color" && mode !== "recolor") state.hover = null;
    stage.classList.toggle("is-scaling", mode === "scale");
    stage.classList.toggle("is-picking", mode === "color" || mode === "ground" || mode === "recolor");
    stage.classList.toggle("is-editing", mode === null && state.openStep === 4 && !!state.target);
    scaleBtn.classList.toggle("is-armed", mode === "scale");
    pickColorBtn.classList.toggle("is-armed", mode === "color");
    resampleBtn.classList.toggle("is-armed", mode === "recolor");
    groundBtn.classList.toggle("is-armed", mode === "ground");
    if (label) { stageMode.textContent = label; stageMode.hidden = false; }
    else if (mode === null && state.openStep === 4 && state.target) {
      stageMode.textContent = "클릭해서 이 프레임의 점을 옮깁니다";
      stageMode.hidden = false;
    } else {
      stageMode.hidden = true;
    }
  }

  overlay.addEventListener("mousedown", (ev) => {
    if (!state.loaded) return;
    const pos = eventPos(ev);
    const nat = toNatural(pos.x, pos.y);
    if (!nat) return;

    if (state.mode === "scale") {
      state.dragging = { kind: "scale", line: { x1: nat.x, y1: nat.y, x2: nat.x, y2: nat.y } };
      redraw();
    } else if (state.mode === "color") {
      // 시작점 = 테이프 중심(색을 읽을 곳), 드래그 길이 = 추적 범위 반지름
      state.dragging = { kind: "roi", roi: { x: nat.x, y: nat.y, r: 0 } };
      redraw();
    }
  });

  /* 마우스가 움직일 때마다 통째로 다시 그리면 무거우니 최소 간격을 둔다.
     requestAnimationFrame은 창이 화면에 안 떠 있으면 아예 안 도는 환경이 있어 타이머로 묶는다. */
  let hoverLast = 0;
  let hoverTimer = null;
  function requestHoverRedraw() {
    const now = Date.now();
    if (now - hoverLast >= 16) { hoverLast = now; redraw(); return; }
    if (hoverTimer) return;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      hoverLast = Date.now();
      redraw();
    }, 16);
  }

  overlay.addEventListener("mousemove", (ev) => {
    const pos = eventPos(ev);
    const nat = toNatural(pos.x, pos.y);
    if (!nat) return;

    if (state.dragging) {
      if (state.dragging.kind === "scale") {
        state.dragging.line.x2 = nat.x;
        state.dragging.line.y2 = nat.y;
        state.hover = null;
      } else {
        const roi = state.dragging.roi;
        roi.r = Math.hypot(nat.x - roi.x, nat.y - roi.y);
        // 드래그 중에는 실제로 색을 읽는 자리(원의 중심)를 확대해서 보여 준다
        state.hover = { x: roi.x, y: roi.y };
      }
      redraw();
      return;
    }

    if (state.mode === "color" || state.mode === "recolor") {
      state.hover = nat;
      requestHoverRedraw();
    }
  });

  overlay.addEventListener("mouseleave", () => {
    if (state.hover) { state.hover = null; redraw(); }
  });

  window.addEventListener("mouseup", () => {
    if (!state.dragging) return;
    const drag = state.dragging;
    state.dragging = null;

    if (drag.kind === "scale") {
      const line = drag.line;
      const len = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
      if (len > 6) {
        state.scale = line;
        updateScaleReadout();
        setMode(null);
        groundBtn.disabled = false;
        pickColorBtn.disabled = false;
      }
    } else if (drag.kind === "roi") {
      const roi = drag.roi;
      if (roi.r >= 6) {
        sampleColorAt(roi.x, roi.y);
        setRoi(roi.x, roi.y, roi.r);
        // 원을 그린 프레임이 곧 추적 시작 지점이 된다.
        state.rangeStart = currentFrame();
        updateRangeReadout();
        setMode(null);
      }
    }
    redraw();
  });

  /**
   * 영상의 한 점에서 색을 읽는다. **원본 해상도**에서 3×3 평균 —
   * 한 픽셀만 보면 압축 노이즈에 흔들리고, 축소본에서 읽으면 주변 색이 섞인다.
   * 돋보기와 실제 샘플링이 **같은 함수**를 써야 "보이는 색 = 쓰이는 색"이 된다.
   */
  function readColorAt(nx, ny) {
    if (!video.videoWidth) return null;
    const x = Math.max(1, Math.min(video.videoWidth - 2, Math.round(nx)));
    const y = Math.max(1, Math.min(video.videoHeight - 2, Math.round(ny)));
    magCtx.clearRect(0, 0, MAG_SRC, MAG_SRC);
    magCtx.drawImage(video, x - 1, y - 1, 3, 3, 0, 0, 3, 3);
    let d;
    try { d = magCtx.getImageData(0, 0, 3, 3).data; } catch (e) { return null; }
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    return {
      hex: "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join(""),
      hsv: rgbToHsv(r, g, b),
    };
  }

  function sampleColorAt(nx, ny) {
    const c = readColorAt(nx, ny);
    if (c) setTarget(c.hex);
  }

  function setRoi(x, y, r) {
    state.roi = { x, y, r };
    roiRadius.disabled = false;
    roiRadius.max = String(Math.round(video.videoWidth * ROI_FRAME_FRAC));
    roiRadius.value = String(Math.round(r));
    updateRoiReadout();
    trackBtn.disabled = !state.target;
    resampleBtn.disabled = false;
    // setTarget이 먼저 실행될 때는 아직 범위가 없어 3단계를 완료로 못 찍는다. 여기서 마무리.
    if (state.target) { markDone(3); setStepState(3, "완료"); }
  }

  /** 권장 반지름 — 한 프레임에 움직이는 거리의 3배. 기준 길이를 입력해야 계산된다. */
  function suggestedRadius() {
    if (!state.pxPerM) return null;
    const eff = state.frameTimes ? state.shotFps : state.fps * state.slow;
    return (3 * V_TYPICAL / eff) * state.pxPerM;
  }

  function updateRoiReadout() {
    if (!state.roi) {
      roiReadout.textContent = "아직 범위가 없습니다.";
      roiRadiusVal.innerHTML = "&ndash;";
      roiAdvice.textContent = "";
      return;
    }
    const r = state.roi.r;
    roiRadiusVal.textContent = Math.round(r) + " px";
    const meters = state.pxPerM ? " (" + (r / state.pxPerM).toFixed(2) + " m)" : "";
    roiReadout.textContent = "반지름 " + Math.round(r) + " px" + meters
      + " · 최대 " + Math.round(roiMaxRadius()) + " px까지 자동 확대";

    const sug = suggestedRadius();
    if (sug == null) {
      roiAdvice.textContent = "";
    } else if (r < sug * 0.8) {
      roiAdvice.innerHTML = "⚠ 범위가 좁습니다. 이 조건에서는 <b>" + Math.round(sug)
        + " px</b> 이상을 권합니다. (한 프레임 이동거리의 3배)";
      roiAdvice.style.color = "#b25000";
    } else {
      roiAdvice.innerHTML = "권장 반지름 <b>" + Math.round(sug) + " px</b> 이상 — 지금 값이면 충분합니다.";
      roiAdvice.style.color = "";
    }
  }

  overlay.addEventListener("click", (ev) => {
    if (!state.loaded) return;
    const pos = eventPos(ev);
    const nat = toNatural(pos.x, pos.y);
    if (!nat) return;

    if (state.mode === "color") return;   // 색·범위는 드래그로 처리한다 (mouseup 참고)

    // 범위는 그대로 두고 색만 다시 고르기 — 반드시 원 안쪽을 찍어야 한다
    if (state.mode === "recolor") {
      if (!state.roi) return;
      const dist = Math.hypot(nat.x - state.roi.x, nat.y - state.roi.y);
      if (dist > state.roi.r) {
        colorReadout.textContent = "원 바깥을 찍었습니다 — 원 안쪽에서 다시 골라 주세요.";
        return;
      }
      sampleColorAt(nat.x, nat.y);
      setMode(null);
      return;
    }

    if (state.mode === "ground") {
      state.groundY = nat.y;
      state.groundManual = true;
      groundReadout.innerHTML = "직접 지정한 지면 (원본 y = <b>" + nat.y.toFixed(0) + "</b> px)";
      setMode(null);
      computeResults();
      redraw();
      return;
    }

    // 손으로 점 찍기 — 어느 단계가 열려 있든 동작한다.
    // (예전에는 4단계가 펼쳐진 동안에만 먹어서, 추적이 끝나 5단계가 열리면 클릭이 무시됐다.)
    if (state.manual && !state.tracking) {
      placeManualPoint(nat.x, nat.y);
      return;
    }
    if (state.openStep === 4 && !state.tracking) {
      // 이미 찍힌 점을 클릭하면 점을 옮기는 게 아니라 **그 프레임으로 이동**한다.
      // 궤적이 튄 자리를 눌러 그 지점부터 손보려는 동작이 훨씬 잦다.
      const hit = pointAt(pos.x, pos.y);
      if (hit != null) {
        video.pause();
        stopSlowPlay();
        gotoFrame(hit).then(() => { updateTransport(); redraw(); });
        return;
      }
      if (state.target) placeManualPoint(nat.x, nat.y);
    }
  });

  /** 화면 좌표 근처에 찍힌 점이 있으면 그 프레임 번호를 돌려준다. */
  function pointAt(dx, dy) {
    const r = videoRect();
    if (!r || !state.points.size) return null;
    let best = null, bestD = 14;   // 화면상 14px 안쪽이면 그 점을 누른 것으로 본다
    for (const [f, p] of state.points) {
      const d = toDisplay(p.x, p.y);
      const dist = Math.hypot(d.x - dx, d.y - dy);
      if (dist < bestD) { bestD = dist; best = f; }
    }
    return best;
  }

  /** 현재 프레임에 손으로 점을 찍는다. 손찍기 모드면 곧바로 다음 프레임으로 넘어간다. */
  function placeManualPoint(nx, ny) {
    const f = currentFrame();
    state.points.set(f, { x: nx, y: ny, manual: true });
    // 찍은 자리로 범위도 옮겨 둔다 — 여기서 자동 추적을 이어갈 수 있게
    state.rois.set(f, { x: nx, y: ny, r: state.roi ? state.roi.r : 40, grown: false });
    delPointBtn.disabled = false;
    clearPointsBtn.disabled = false;
    delFromHereBtn.disabled = false;
    retrackBtn.disabled = !state.roi;
    trackReadout.textContent = "점 " + state.points.size + "개 · 마지막 f" + f + " (손으로 찍음)";
    // 자동 추적을 안 쓰고 손으로만 찍어도 4단계를 마칠 수 있어야 한다
    if (state.points.size >= 3) { markDone(4); setStepState(4, "완료"); }
    computeResults();

    if (state.manual && f < state.frameCount - 1) {
      gotoFrame(f + 1).then(() => { updateTransport(); redraw(); });
    } else {
      redraw();
    }
  }

  function toggleManual(on) {
    state.manual = on;
    if (on) stopSlowPlay();
    manualBtn.textContent = on ? "손으로 찍기 끄기" : "손으로 찍기 시작";
    manualBtn.classList.toggle("is-armed", on);
    if (on) {
      video.pause();
      setMode(null);
      stageMode.textContent = "클릭 → 점을 찍고 다음 프레임으로 (Esc로 종료)";
      stageMode.hidden = false;
    } else {
      setMode(null);
    }
    stage.classList.toggle("is-editing", on);
    redraw();
  }

  /* 드래그&드롭 */
  ["dragenter", "dragover"].forEach((t) =>
    stage.addEventListener(t, (e) => { e.preventDefault(); stageDrop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((t) =>
    stage.addEventListener(t, (e) => { e.preventDefault(); stageDrop.classList.remove("is-over"); }));
  stage.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  /* ============================================================
     트랜스포트
     ============================================================ */

  // 사용자가 재생바 손잡이를 쥐고 있는 동안은 참 (updateTransport보다 먼저 선언해야 안전)
  let scrubbing = false;

  function updateTransport() {
    if (!state.loaded) return;
    const f = currentFrame();
    timeReadout.textContent = video.currentTime.toFixed(3) + " / " + state.duration.toFixed(3) + " s";
    frameReadout.textContent = "f " + f + " / " + (state.frameCount - 1);
    // 드래그 중에는 손잡이를 건드리지 않는다.
    // seek이 드래그 속도를 못 따라가는데 매번 현재 프레임으로 되돌려 쓰면 손잡이가 튕겨 나간다.
    if (!scrubbing) scrubber.value = String(f);
    const playing = slowTimer ? true : !video.paused;
    playBtn.innerHTML = playing ? "&#10073;&#10073;" : "&#9654;";
  }

  playBtn.addEventListener("click", () => {
    if (isStepMode()) {
      if (slowTimer) stopSlowPlay(); else startSlowPlay();
      return;
    }
    if (video.paused) video.play(); else video.pause();
    updateTransport();
  });
  prevFrameBtn.addEventListener("click", () => {
    stopSlowPlay(); video.pause(); gotoFrame(currentFrame() - 1).then(afterSeek);
  });
  nextFrameBtn.addEventListener("click", () => {
    stopSlowPlay(); video.pause(); gotoFrame(currentFrame() + 1).then(afterSeek);
  });
  /* 재생바는 프레임 단위. 드래그 중에는 손잡이를 사용자가 쥐고 있으므로
     updateTransport가 값을 덮어쓰지 못하게 하고, seek은 앞선 것이 끝난 뒤에만 건다.
     (2,400프레임짜리에 매 input마다 seek을 걸면 밀려서 아무 반응도 없는 것처럼 보인다.) */
  let scrubPending = null;
  let scrubBusy = false;

  function pumpScrub() {
    if (scrubBusy || scrubPending == null) return;
    scrubBusy = true;
    const target = scrubPending;
    scrubPending = null;
    gotoFrame(target).then(() => {
      scrubBusy = false;
      updateTransport();
      redraw();
      pumpScrub();
    }, () => { scrubBusy = false; });
  }

  function beginScrub() { scrubbing = true; stopSlowPlay(); video.pause(); }
  function endScrub() {
    if (!scrubbing) return;
    scrubbing = false;
    scrubPending = Number(scrubber.value);   // 놓은 자리로 정확히 맞춘다
    pumpScrub();
  }

  scrubber.addEventListener("pointerdown", beginScrub);
  scrubber.addEventListener("keydown", beginScrub);
  window.addEventListener("pointerup", endScrub);
  scrubber.addEventListener("change", endScrub);

  scrubber.addEventListener("input", () => {
    if (!scrubbing) beginScrub();
    const f = Number(scrubber.value);
    // 손잡이를 끌 때 숫자만이라도 바로 따라오게 해서 반응이 없어 보이지 않게 한다
    frameReadout.textContent = "f " + f + " / " + (state.frameCount - 1);
    scrubPending = f;
    pumpScrub();
  });

  function afterSeek() { updateTransport(); redraw(); }

  /* 재생 속도는 보기 위한 것일 뿐 — 시간 축은 촬영 fps에서만 나오므로 계산에 영향이 없다.
     "N f/s"는 브라우저 재생이 아니라 **타이머로 프레임을 한 장씩 넘기는** 방식이다.
     playbackRate는 브라우저가 아주 낮은 값에서 제멋대로 굴어서, 확실히 느리게 보려면 이쪽이 낫다. */
  let slowTimer = null;

  function isStepMode() { return String(rateSelect.value).startsWith("step"); }

  function stopSlowPlay() {
    if (slowTimer) { clearInterval(slowTimer); slowTimer = null; }
    updateTransport();
  }

  function startSlowPlay() {
    stopSlowPlay();
    video.pause();
    const fps = Number(String(rateSelect.value).replace("step", "")) || 4;
    let busy = false;
    slowTimer = setInterval(() => {
      if (busy) return;                       // seek이 끝나기 전에 다음 것을 걸지 않는다
      busy = true;
      const from = state.rangeStart != null ? state.rangeStart : 0;
      const to = state.rangeEnd != null ? state.rangeEnd : state.frameCount - 1;
      let f = currentFrame() + 1;
      if (f > to) f = loopRange.checked ? from : to;
      gotoFrame(f).then(() => { busy = false; updateTransport(); redraw(); },
                        () => { busy = false; });
    }, 1000 / fps);
    updateTransport();
  }

  /** 영상을 새로 불러오면 playbackRate가 1로 돌아간다 — 선택값을 다시 걸어 준다. */
  function applyRate() {
    stopSlowPlay();
    if (isStepMode()) { video.playbackRate = 1; return; }
    const r = Number(rateSelect.value) || 1;
    try { video.playbackRate = r; } catch (e) { /* 브라우저가 거부하면 그대로 둔다 */ }
  }

  rateSelect.addEventListener("change", () => {
    const wasPlaying = !video.paused || slowTimer;
    applyRate();
    if (wasPlaying) { if (isStepMode()) startSlowPlay(); else video.play(); }
  });

  /** 추적 구간을 정해 뒀으면 재생이 그 구간을 벗어날 때 시작으로 되돌린다. */
  function loopWithinRange() {
    if (!loopRange.checked || video.paused || state.tracking) return;
    if (state.rangeStart == null && state.rangeEnd == null) return;
    const from = state.rangeStart != null ? state.rangeStart : 0;
    const to = state.rangeEnd != null ? state.rangeEnd : state.frameCount - 1;
    const f = currentFrame();
    if (f > to || f < from) {
      video.currentTime = frameTime(from);
    }
  }

  video.addEventListener("timeupdate", () => {
    loopWithinRange();
    updateTransport();
    if (!state.tracking) redraw();
  });
  video.addEventListener("seeked", () => { if (!state.tracking) afterSeek(); });
  video.addEventListener("play", updateTransport);
  video.addEventListener("pause", updateTransport);

  window.addEventListener("keydown", (ev) => {
    if (!state.loaded) return;
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT") return;
    const step = ev.shiftKey ? 10 : 1;
    if (ev.key === "ArrowLeft") { ev.preventDefault(); video.pause(); gotoFrame(currentFrame() - step).then(afterSeek); }
    if (ev.key === "ArrowRight") { ev.preventDefault(); video.pause(); gotoFrame(currentFrame() + step).then(afterSeek); }
    if (ev.key === " ") { ev.preventDefault(); playBtn.click(); }
    if (ev.key === "Escape" && state.manual) toggleManual(false);
  });

  function updateRangeReadout() {
    const a = state.rangeStart, b = state.rangeEnd;
    if (a == null && b == null) rangeReadout.textContent = "전체";
    else rangeReadout.textContent = "f " + (a == null ? 0 : a) + " → f " + (b == null ? state.frameCount - 1 : b);
    clearRangeBtn.disabled = a == null && b == null;
    gotoStartBtn.disabled = a == null;
    gotoEndBtn.disabled = b == null;
  }

  setStartBtn.addEventListener("click", () => { state.rangeStart = currentFrame(); updateRangeReadout(); });
  setEndBtn.addEventListener("click", () => { state.rangeEnd = currentFrame(); updateRangeReadout(); });
  // 표시해 둔 구간 경계로 되돌아가기 — 발사 장면을 몇 번이고 다시 보게 된다
  gotoStartBtn.addEventListener("click", () => {
    if (state.rangeStart == null) return;
    stopSlowPlay();
    video.pause();
    gotoFrame(state.rangeStart).then(afterSeek);
  });
  gotoEndBtn.addEventListener("click", () => {
    if (state.rangeEnd == null) return;
    stopSlowPlay();
    video.pause();
    gotoFrame(state.rangeEnd).then(afterSeek);
  });
  clearRangeBtn.addEventListener("click", () => { state.rangeStart = null; state.rangeEnd = null; updateRangeReadout(); });

  /* ============================================================
     패널 · 단계 진행
     ============================================================ */

  function openStep(n) {
    state.openStep = n;
    document.querySelectorAll(".step-card").forEach((c) => {
      c.classList.toggle("open", Number(c.dataset.step) === n);
    });
    setMode(null);
    if (n === 5) drawGraph();
  }

  function markDone(n) {
    const card = document.querySelector('.step-card[data-step="' + n + '"]');
    if (card) card.classList.add("done");
    // 단계를 마쳐야 [확인 · 다음 단계로]가 열린다. 자동으로 넘어가지는 않는다.
    const next = document.getElementById("next" + n);
    if (next) next.disabled = false;
  }

  function setStepState(n, txt) {
    const el = $("state" + n);
    if (el) el.textContent = txt;
  }

  document.querySelectorAll(".step-head").forEach((head) => {
    head.addEventListener("click", () => {
      const n = Number(head.parentElement.dataset.step);
      openStep(state.openStep === n ? 0 : n);
    });
  });

  document.querySelectorAll(".step-next").forEach((btn) => {
    btn.addEventListener("click", () => openStep(Number(btn.dataset.next)));
  });

  function enableAfterLoad() {
    // 손으로 찍기는 색·범위가 없어도 쓸 수 있어야 한다 (자동 추적이 안 될 때의 최후 수단)
    [playBtn, prevFrameBtn, nextFrameBtn, scrubber, setStartBtn, setEndBtn, scaleBtn, manualBtn,
      rateSelect].forEach((el) => { el.disabled = false; });
  }

  function resetAnalysis() {
    // 새 영상을 올리면 2~4단계는 다시 처음부터. 확인 버튼도 잠근다.
    [2, 3, 4].forEach((n) => {
      const card = document.querySelector('.step-card[data-step="' + n + '"]');
      if (card) card.classList.remove("done");
      const next = document.getElementById("next" + n);
      if (next) next.disabled = true;
      setStepState(n, "대기");
    });
    state.scale = null;
    state.pxPerM = null;
    state.groundY = null;
    state.groundManual = false;
    state.points.clear();
    state.rois.clear();
    state.roi = null;
    state.series = null;
    state.selectedFrame = null;
    state.peakFrame = null;
    state.peakPinned = false;
    state.rangeStart = null;
    state.rangeEnd = null;
    roiRadius.disabled = true;
    trackBtn.disabled = true;
    retrackBtn.disabled = true;
    delFromHereBtn.disabled = true;
    resampleBtn.disabled = true;
    colorReadout.innerHTML = "&ndash;";
    if (state.manual) toggleManual(false);
    updateRangeReadout();
    updateScaleReadout();
    updateRoiReadout();
    trackReadout.textContent = "아직 추적하지 않았습니다.";
    renderResults();
  }

  /* ============================================================
     이벤트 배선
     ============================================================ */

  pickBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });

  fpsInput.addEventListener("input", recalcFrames);
  slowSelect.addEventListener("change", recalcFrames);
  shotFps.addEventListener("input", recalcFrames);
  manualBtn.addEventListener("click", () => toggleManual(!state.manual));

  scaleBtn.addEventListener("click", () => {
    setMode(state.mode === "scale" ? null : "scale", "기준 물체의 위·아래 끝을 드래그하세요");
  });
  scaleLength.addEventListener("input", () => { updateScaleReadout(); redraw(); });
  groundBtn.addEventListener("click", () => {
    setMode(state.mode === "ground" ? null : "ground", "지면 높이를 클릭하세요");
  });

  swatchRow.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".swatch");
    if (!btn || !state.loaded) return;
    setTarget(btn.dataset.color);
  });
  pickColorBtn.addEventListener("click", () => {
    setMode(state.mode === "color" ? null : "color", "테이프 한가운데에서 바깥으로 드래그하세요");
  });

  resampleBtn.addEventListener("click", () => {
    setMode(state.mode === "recolor" ? null : "recolor", "원 안에서 테이프의 밝은 부분을 클릭하세요");
  });

  roiRadius.addEventListener("input", () => {
    if (!state.roi) return;
    state.roi.r = Number(roiRadius.value);
    updateRoiReadout();
    redraw();
  });

  retrackBtn.addEventListener("click", () => runTracking(currentFrame()));

  setPeakBtn.addEventListener("click", () => {
    if (state.selectedFrame == null) return;
    state.peakFrame = state.selectedFrame;
    state.peakPinned = true;
    computeResults();
    redraw();
  });

  autoPeakBtn.addEventListener("click", () => {
    state.peakPinned = false;
    state.peakFrame = null;
    computeResults();
    redraw();
  });

  hueTol.addEventListener("input", () => { hueTolVal.textContent = hueTol.value + "°"; redraw(); });
  satMin.addEventListener("input", () => { satMinVal.textContent = Number(satMin.value).toFixed(2); redraw(); });
  maskToggle.addEventListener("change", redraw);

  trackBtn.addEventListener("click", () => runTracking(null));
  /** 지금 프레임의 점과 그 뒤의 점을 모두 지운다 — 궤적이 튄 지점부터 다시 찍을 때 쓴다. */
  delFromHereBtn.addEventListener("click", () => {
    const f = currentFrame();
    let removed = 0;
    for (const key of [...state.points.keys()]) {
      if (key >= f) { state.points.delete(key); state.rois.delete(key); removed++; }
    }
    if (!removed) {
      trackReadout.textContent = "f" + f + " 뒤로는 지울 점이 없습니다.";
      return;
    }
    state.selectedFrame = null;
    state.peakFrame = null;
    state.peakPinned = false;
    trackReadout.textContent = "f" + f + "부터 " + removed + "개 지움 · 남은 점 " + state.points.size + "개";
    if (state.points.size < 3) setStepState(4, "대기");
    computeResults();
    redraw();
  });

  delPointBtn.addEventListener("click", () => {
    state.points.delete(currentFrame());
    trackReadout.textContent = "점 " + state.points.size + "개";
    computeResults();
    redraw();
  });
  clearPointsBtn.addEventListener("click", () => {
    state.points.clear();
    state.rois.clear();
    state.selectedFrame = null;
    state.peakFrame = null;
    state.peakPinned = false;
    retrackBtn.disabled = true;
    delFromHereBtn.disabled = true;
    trackReadout.textContent = "아직 추적하지 않았습니다.";
    computeResults();
    redraw();
  });

  /* 복사 */
  function copyText(txt, btn) {
    const done = () => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = "복사됨";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = old; btn.classList.remove("copied"); }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, () => fallbackCopy(txt, done));
    } else {
      fallbackCopy(txt, done);
    }
  }
  function fallbackCopy(txt, done) {
    const ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* 복사 불가 브라우저 */ }
    document.body.removeChild(ta);
  }

  document.querySelectorAll(".btn-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const el = $(btn.dataset.copy);
      if (!el) return;
      copyText(el.textContent.replace(/[^0-9.\-]/g, ""), btn);
    });
  });

  copyAllBtn.addEventListener("click", () => {
    const txt = "발사속력 " + resSpeed.textContent
      + " / 높이 " + resHeight.textContent
      + " / 걸린 시간 " + resTime.textContent;
    copyText(txt, copyAllBtn);
  });

  window.addEventListener("resize", () => { redraw(); drawGraph(); });

  /* 초기 표시 */
  recalcFrames();
  updateRangeReadout();
  drawGraph();
})();
