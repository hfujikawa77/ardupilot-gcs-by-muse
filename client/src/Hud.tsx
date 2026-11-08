// Artificial horizon + heading display, drawn as SVG from live ATTITUDE /
// GLOBAL_POSITION_INT telemetry. Pure presentation: all values come from
// the server snapshot.

interface HudProps {
  rollDeg: number | null;
  pitchDeg: number | null;
  headingDeg: number | null;
}

const CX = 160;
const CY = 150;
const PX_PER_DEG = 2.4;

export function Hud({ rollDeg, pitchDeg, headingDeg }: HudProps) {
  const roll = rollDeg ?? 0;
  const pitch = pitchDeg ?? 0;
  const pitchPx = Math.max(-55, Math.min(55, pitch)) * PX_PER_DEG;
  const hdg = headingDeg ?? 0;

  const ladder = [-30, -20, -10, 10, 20, 30];
  // Heading tape: ticks every 10 degrees within +-40 of current heading.
  const tapeTicks: { deg: number; off: number }[] = [];
  for (let d = -40; d <= 40; d += 10) {
    const deg = ((Math.round(hdg / 10) * 10 + d) % 360 + 360) % 360;
    const off = ((((deg - hdg) % 360) + 540) % 360) - 180;
    if (Math.abs(off) <= 42) tapeTicks.push({ deg, off });
  }

  return (
    <svg viewBox="0 0 320 300" className="w-full" role="img" aria-label="姿勢表示器">
      <defs>
        <clipPath id="hud-clip">
          <rect x="6" y="6" width="308" height="248" rx="10" />
        </clipPath>
      </defs>
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
        {/* roll scale (fixed) */}
        {[-60, -45, -30, -15, 0, 15, 30, 45, 60].map((a) => {
          const rad = ((a - 90) * Math.PI) / 180;
          const r1 = 118;
          const r2 = a % 30 === 0 ? 104 : 110;
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
            points={`${CX},${CY - 100} ${CX - 6},${CY - 88} ${CX + 6},${CY - 88}`}
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
        <rect x="6" y="6" width="308" height="248" rx="10" fill="none" stroke="#1f303d" strokeWidth="2" />
      </g>
      {/* heading tape */}
      <g>
        <rect x="6" y="262" width="308" height="32" rx="8" fill="#0d151c" stroke="#1f303d" />
        {tapeTicks.map(({ deg, off }) => {
          const x = CX + off * 2.6;
          return (
            <g key={deg}>
              <line x1={x} y1="268" x2={x} y2="276" stroke="#8fa6b3" strokeWidth="1.4" />
              <text x={x} y="290" textAnchor="middle" fontSize="10" fill="#8fa6b3" className="mono">
                {String(deg).padStart(3, "0")}
              </text>
            </g>
          );
        })}
        <polygon points={`${CX},274 ${CX - 5},266 ${CX + 5},266`} fill="#22d3ee" />
        <text x={CX} y="258" textAnchor="middle" fontSize="12" fill="#22d3ee" className="mono">
          HDG {String(Math.round(hdg)).padStart(3, "0")}°
        </text>
      </g>
    </svg>
  );
}
