// Round artificial horizon, drawn as SVG from live ATTITUDE telemetry.
// The instrument is a circular gauge (like a classic attitude
// indicator): the sky/ground ball, pitch ladder and roll pointer live
// inside the circle and the roll scale runs around its rim. The SVG is
// exactly the circle (plus a soft backing disc) so it can float on the
// map with no square panel behind it; the heading and numeric readouts
// live in HTML chips next to it in App.tsx.
// Pure presentation: all values come from the server snapshot.

interface HudProps {
  rollDeg: number | null;
  pitchDeg: number | null;
}

const CX = 160;
const CY = 126;
const R = 114;
const PX_PER_DEG = 2.4;

export function Hud({ rollDeg, pitchDeg }: HudProps) {
  const roll = rollDeg ?? 0;
  const pitch = pitchDeg ?? 0;
  const pitchPx = Math.max(-55, Math.min(55, pitch)) * PX_PER_DEG;

  const ladder = [-30, -20, -10, 10, 20, 30];

  return (
    <svg
      viewBox="0 0 320 252"
      className="w-full"
      role="img"
      aria-label="姿勢表示器"
      style={{ filter: "drop-shadow(0 6px 16px rgba(0,0,0,0.6))", display: "block" }}
    >
      <defs>
        <clipPath id="hud-clip">
          <circle cx={CX} cy={CY} r={R} />
        </clipPath>
      </defs>
      {/* soft circular backing so the gauge reads against any map tile —
          a disc, never a square panel */}
      <circle cx={CX} cy={CY} r={R + 7} fill="rgba(11,17,22,0.45)" />
      <circle cx={CX} cy={CY} r={R + 7} fill="none" stroke="rgba(219,231,238,0.22)" strokeWidth="1" />
      <g clipPath="url(#hud-clip)">
        {/* rotating / pitching world */}
        <g transform={`rotate(${(-roll).toFixed(2)} ${CX} ${CY})`}>
          <g transform={`translate(0 ${pitchPx.toFixed(1)})`}>
            <rect x="-320" y={CY - 900} width="960" height="900" fill="#17455e" />
            <rect x="-320" y={CY} width="960" height="900" fill="#4d3a26" />
            <line x1="-320" y1={CY} x2="640" y2={CY} stroke="#e8f6fb" strokeWidth="2.5" />
            {ladder.map((deg) => {
              const y = CY - deg * PX_PER_DEG;
              const w = deg % 20 === 0 ? 34 : 22;
              return (
                <g key={deg} stroke="#cfe8f2" strokeWidth="1.6" opacity="0.85">
                  <line x1={CX - w} y1={y} x2={CX - 10} y2={y} />
                  <line x1={CX + 10} y1={y} x2={CX + w} y2={y} />
                  <text
                    x={CX - w - 6} y={y + 4} textAnchor="end" fontSize="10"
                    fill="#cfe8f2" stroke="none" className="mono"
                  >
                    {Math.abs(deg)}
                  </text>
                  <text
                    x={CX + w + 6} y={y + 4} textAnchor="start" fontSize="10"
                    fill="#cfe8f2" stroke="none" className="mono"
                  >
                    {Math.abs(deg)}
                  </text>
                </g>
              );
            })}
          </g>
        </g>
        {/* roll scale (fixed, around the rim) */}
        {[-60, -45, -30, -15, 0, 15, 30, 45, 60].map((a) => {
          const rad = ((a - 90) * Math.PI) / 180;
          const r1 = R - 3;
          const r2 = a % 30 === 0 ? R - 17 : R - 11;
          return (
            <line
              key={a}
              x1={CX + r1 * Math.cos(rad)} y1={CY + r1 * Math.sin(rad)}
              x2={CX + r2 * Math.cos(rad)} y2={CY + r2 * Math.sin(rad)}
              stroke="#8fa6b3" strokeWidth={a === 0 ? 2.4 : 1.4}
            />
          );
        })}
        {/* roll pointer (rotates with the aircraft) */}
        <g transform={`rotate(${(-roll).toFixed(2)} ${CX} ${CY})`}>
          <polygon
            points={`${CX},${CY - R + 22} ${CX - 6},${CY - R + 34} ${CX + 6},${CY - R + 34}`}
            fill="#22d3ee"
          />
        </g>
        {/* fixed aircraft symbol */}
        <g stroke="#22d3ee" strokeWidth="3.5" strokeLinecap="round">
          <line x1={CX - 64} y1={CY} x2={CX - 16} y2={CY} />
          <line x1={CX + 16} y1={CY} x2={CX + 64} y2={CY} />
          <line x1={CX - 16} y1={CY} x2={CX - 16} y2={CY + 8} />
          <line x1={CX + 16} y1={CY} x2={CX + 16} y2={CY + 8} />
        </g>
        <circle cx={CX} cy={CY} r="3.5" fill="#22d3ee" />
      </g>
      {/* bezel */}
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="#1f303d" strokeWidth="3" />
      <circle cx={CX} cy={CY} r={R + 4} fill="none" stroke="#1f303d" strokeWidth="1" opacity="0.6" />
    </svg>
  );
}
