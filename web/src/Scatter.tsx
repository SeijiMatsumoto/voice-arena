import { useState } from "react";
import type { Kind } from "./api";

export interface Point {
  name: string;
  kind: Kind;
  x: number;
  y: number;
  details: [string, string][];
}

interface Props {
  points: Point[];
  xLabel: string;
  formatX: (v: number) => string;
  onSelect?: (name: string) => void;
  linear?: boolean;
  /** Draws a dashed vertical line, e.g. the latency budget. */
  limitX?: { value: number; label: string };
}

const W = 560;
const H = 300;
const M = { top: 12, right: 24, bottom: 36, left: 44 };

/** Share of errors caught (y) against a log-scaled x (delay or cost). Up-and-left is better. */
export function Scatter({
  points,
  xLabel,
  formatX,
  onSelect,
  linear = false,
  limitX,
}: Props) {
  const [hover, setHover] = useState<{
    p: Point;
    cx: number;
    cy: number;
  } | null>(null);
  const valid = points.filter(
    (p) => (linear ? p.x >= 0 : p.x > 0) && Number.isFinite(p.x),
  );
  if (!valid.length) return <div className="empty">No data for this axis.</div>;

  const transform = (x: number) => (linear ? x : Math.log10(x));
  const xs = valid.map((p) => transform(p.x));
  let [x0, x1] = [Math.floor(Math.min(...xs)), Math.ceil(Math.max(...xs))];
  if (linear) {
    x0 = 0;
    x1 = Math.max(...xs) * 1.15 || 1;
  }
  if (x0 === x1) x1 = x0 + 1;
  const ys = valid.map((p) => p.y);
  // Fit the axis to the data: pad 2 points below the lowest model, snap to a 5-point grid.
  const y0 = Math.max(0, Math.floor((Math.min(...ys) - 0.02) * 20) / 20);
  const yStep = 1 - y0 > 0.3 ? 0.1 : 0.05;
  const y1 = 1;

  const sx = (v: number) =>
    M.left + ((transform(v) - x0) / (x1 - x0)) * (W - M.left - M.right);
  const sy = (v: number) =>
    H - M.bottom - ((v - y0) / (y1 - y0)) * (H - M.top - M.bottom);

  const xTicks: number[] = [];
  if (linear) {
    for (let i = 0; i <= 4; i++) xTicks.push((x1 * i) / 4);
  } else {
    for (let e = x0; e <= x1; e++) xTicks.push(10 ** e);
  }
  const yTicks: number[] = [];
  for (let v = y0; v <= y1 + 1e-9; v += yStep)
    yTicks.push(Math.round(v * 100) / 100);

  const labels = placeLabels(
    valid.map((p) => ({ p, cx: sx(p.x), cy: sy(p.y) })),
    { left: M.left, right: W - 4, top: 0, bottom: H - M.bottom },
  );

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Errors caught versus ${xLabel}`}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line
              className="gridline"
              x1={M.left}
              x2={W - M.right}
              y1={sy(v)}
              y2={sy(v)}
            />
            <text
              x={M.left - 8}
              y={sy(v) + 4}
              textAnchor="end"
            >{`${Math.round(v * 100)}%`}</text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={v} x={sx(v)} y={H - M.bottom + 16} textAnchor="middle">
            {formatX(v)}
          </text>
        ))}
        <line
          className="axis"
          x1={M.left}
          x2={W - M.right}
          y1={H - M.bottom}
          y2={H - M.bottom}
        />
        <text x={(W + M.left - M.right) / 2} y={H - 4} textAnchor="middle">
          {xLabel}
          {linear ? "" : " (log scale)"} →
        </text>
        {limitX && limitX.value >= 10 ** x0 && limitX.value <= 10 ** x1 && (
          <g>
            <line className="limit" x1={sx(limitX.value)} x2={sx(limitX.value)} y1={M.top} y2={H - M.bottom} />
            <text className="limit-label" x={sx(limitX.value) + 4} y={M.top + 10}>
              {limitX.label}
            </text>
          </g>
        )}
        {labels.map(({ p, x, y, anchor, leader }) => (
          <g key={`l-${p.name}`}>
            {leader && (
              <line
                className="leader"
                x1={leader[0]}
                y1={leader[1]}
                x2={leader[2]}
                y2={leader[3]}
              />
            )}
            <text className="point-label" x={x} y={y} textAnchor={anchor}>
              {p.name}
            </text>
          </g>
        ))}
        {valid.map((p) => {
          const cx = sx(p.x);
          const cy = sy(p.y);
          const on = hover?.p.name === p.name;
          return (
            <g key={p.name}>
              <circle
                className="dot"
                cx={cx}
                cy={cy}
                r={on ? 7 : 5.5}
                fill={`var(--kind-${p.kind})`}
              />
              <circle
                className="hit"
                cx={cx}
                cy={cy}
                r={14}
                tabIndex={0}
                onPointerMove={(e) =>
                  setHover({ p, cx: e.clientX, cy: e.clientY })
                }
                onPointerLeave={() => setHover(null)}
                onFocus={(e) => {
                  const r = (
                    e.target as SVGCircleElement
                  ).getBoundingClientRect();
                  setHover({ p, cx: r.right, cy: r.top });
                }}
                onBlur={() => setHover(null)}
                onClick={() => onSelect?.(p.name)}
              />
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          className="tooltip"
          style={{ left: hover.cx + 14, top: hover.cy + 14 }}
        >
          <div className="t-title">{hover.p.name}</div>
          {hover.p.details.map(([k, v]) => (
            <div className="t-row" key={k}>
              <span>{k}</span>
              <b>{v}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function KindLegend() {
  return (
    <div className="legend">
      <span className="kind check">Rules</span>
      <span className="kind llm">Small LLM</span>
      <span className="kind decision">Decision model</span>
      <span className="kind cascade">Cascade</span>
    </div>
  );
}

interface Placed {
  p: Point;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  leader?: [number, number, number, number];
}

type Box = { x0: number; x1: number; y0: number; y1: number };

const CHAR_W = 6.2; // approx. width of one 11px glyph in viewBox units
const LABEL_H = 12;
const DOT_R = 8;

/**
 * Greedy label placement: for each dot, try 8 spots around it, nearest first, and keep the first
 * that collides with no other label or dot. If all are taken, step outward and draw a leader
 * line back to the dot. Labels that still don't fit are dropped (the tooltip still names them).
 */
function placeLabels(
  dots: { p: Point; cx: number; cy: number }[],
  bounds: { left: number; right: number; top: number; bottom: number },
): Placed[] {
  const dotBoxes: Box[] = dots.map(({ cx, cy }) => ({
    x0: cx - DOT_R,
    x1: cx + DOT_R,
    y0: cy - DOT_R,
    y1: cy + DOT_R,
  }));
  const taken: Box[] = [];
  const out: Placed[] = [];
  const overlaps = (a: Box, b: Box) =>
    a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

  // Place crowded dots first so they get the closest spots.
  const crowding = (i: number) =>
    dots.filter(
      (d, j) =>
        j !== i && Math.hypot(d.cx - dots[i].cx, d.cy - dots[i].cy) < 60,
    ).length;
  const order = dots
    .map((_, i) => i)
    .sort((a, b) => crowding(b) - crowding(a) || a - b);

  for (const i of order) {
    const { p, cx, cy } = dots[i];
    const w = p.name.length * CHAR_W;
    let done = false;
    for (const extra of [0, 12, 24]) {
      const g = 10 + extra; // gap between dot centre and label
      const candidates: [number, number, Placed["anchor"]][] = [
        [cx + g, cy + 4, "start"],
        [cx - g, cy + 4, "end"],
        [cx, cy - g, "middle"],
        [cx, cy + g + 8, "middle"],
        [cx + g * 0.7, cy - g * 0.7, "start"],
        [cx + g * 0.7, cy + g * 0.7 + 8, "start"],
        [cx - g * 0.7, cy - g * 0.7, "end"],
        [cx - g * 0.7, cy + g * 0.7 + 8, "end"],
      ];
      for (const [x, y, anchor] of candidates) {
        const x0 =
          anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
        const box = {
          x0: x0 - 2,
          x1: x0 + w + 2,
          y0: y - LABEL_H + 2,
          y1: y + 2,
        };
        if (
          box.x0 < bounds.left ||
          box.x1 > bounds.right ||
          box.y0 < bounds.top ||
          box.y1 > bounds.bottom
        )
          continue;
        if (
          taken.some((b) => overlaps(b, box)) ||
          dotBoxes.some((b) => overlaps(b, box))
        )
          continue;
        taken.push(box);
        const placed: Placed = { p, x, y, anchor };
        if (extra > 0) {
          // Leader from the dot's edge to the nearest point of the label box.
          const lx = Math.min(Math.max(cx, box.x0), box.x1);
          const ly = Math.min(Math.max(cy, box.y0), box.y1);
          const d = Math.hypot(lx - cx, ly - cy) || 1;
          placed.leader = [
            cx + ((lx - cx) / d) * 6,
            cy + ((ly - cy) / d) * 6,
            lx,
            ly,
          ];
        }
        out.push(placed);
        done = true;
        break;
      }
      if (done) break;
    }
  }
  return out;
}
