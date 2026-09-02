/* ============================================================
   SimUtils — 캔버스 그리기 관련 공용 함수 모음
   parabolic-motion.js, water-rocket.js 양쪽에서 <script>로 불러와 사용한다.
   ============================================================ */

const SimUtils = (() => {
  "use strict";

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  /** 캔버스를 devicePixelRatio에 맞춰 선명하게 리사이즈하고 2D 컨텍스트를 스케일링한다. */
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, ctx };
  }

  /** 축에 보기 좋은 눈금 간격을 계산한다 (1, 2, 5 × 10^n 규칙). */
  function niceStep(span, targetTicks = 6) {
    const raw = span / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm < 1.5) step = 1;
    else if (norm < 3.5) step = 2;
    else if (norm < 7.5) step = 5;
    else step = 10;
    return step * mag;
  }

  /** samples: [{x, y}, ...] 형태의 배열을 선으로 그린다. */
  function drawPath(ctx, samples, toPx, color, width, dashed) {
    if (!samples.length) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dashed) ctx.setLineDash([5, 5]);
    ctx.beginPath();
    samples.forEach((s, i) => {
      const { px, py } = toPx(s.x, s.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  }

  /** (x1,y1) → (x2,y2) 방향 화살표를 그린다 (속도 벡터 등에 사용). */
  function arrow(ctx, x1, y1, x2, y2) {
    const headLen = 7;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }

  /**
   * 지면 기준 그리드 + 축 눈금을 그리고, world 좌표 → 픽셀 좌표 변환 함수를 반환한다.
   * worldW, worldH: 그리드가 표현해야 할 최대 가로/세로 범위(m)
   */
  function drawWorldGrid(ctx, w, h, worldW, worldH, opts = {}) {
    const padL = opts.padL ?? 46;
    const padR = opts.padR ?? 18;
    const padT = opts.padT ?? 18;
    const padB = opts.padB ?? 34;
    const gridColor = opts.gridColor ?? "#e5e7eb";
    const textColor = opts.textColor ?? "#8e8e93";
    const axisColor = opts.axisColor ?? "#a8aab2";

    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const scale = Math.min(plotW / worldW, plotH / worldH);

    const originX = padL;
    const originY = padT + plotH;

    const toPx = (x, y) => ({
      px: originX + x * scale,
      py: originY - y * scale,
    });

    const stepX = niceStep(worldW);
    const stepY = niceStep(worldH);

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = "11px JetBrains Mono, monospace";
    ctx.fillStyle = textColor;

    for (let gx = 0; gx <= worldW; gx += stepX) {
      const { px } = toPx(gx, 0);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, originY);
      ctx.stroke();
      ctx.fillText(String(Math.round(gx)), px + 2, originY + 14);
    }
    for (let gy = 0; gy <= worldH; gy += stepY) {
      const { py } = toPx(0, gy);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(w - padR, py);
      ctx.stroke();
      ctx.fillText(String(Math.round(gy)), 4, py - 3);
    }

    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, originY);
    ctx.lineTo(w - padR, originY);
    ctx.stroke();

    return { toPx, plotW, plotH, originX, originY, scale };
  }

  return { toRad, fitCanvas, niceStep, drawPath, arrow, drawWorldGrid };
})();
