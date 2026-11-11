// One on-screen stick (QGC-style): pointer-driven (touch + mouse), knob is
// clamped to a circle, and it springs back to center when released.
// Reports normalized axes in [-1, 1] with +y meaning "stick pushed up".

import { useRef, useState, type PointerEvent as RPE } from "react";

interface StickProps {
  label: string;
  horizontalName: string;
  verticalName: string;
  size?: number;
  onChange: (x: number, y: number) => void;
}

export function Stick({ label, horizontalName, verticalName, size = 148, onChange }: StickProps) {
  const baseRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const radius = size / 2 - 30;

  const update = (clientX: number, clientY: number) => {
    const el = baseRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > radius) {
      dx = (dx / len) * radius;
      dy = (dy / len) * radius;
    }
    setKnob({ x: dx, y: dy });
    onChange(dx / radius, -dy / radius);
  };

  const down = (e: RPE<HTMLDivElement>) => {
    pointerId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    update(e.clientX, e.clientY);
  };
  const move = (e: RPE<HTMLDivElement>) => {
    if (pointerId.current !== e.pointerId) return;
    update(e.clientX, e.clientY);
  };
  const up = (e: RPE<HTMLDivElement>) => {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    setDragging(false);
    setKnob({ x: 0, y: 0 });
    onChange(0, 0); // spring back to neutral on release
  };

  const knobSize = 54;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        ref={baseRef}
        className="stick-base"
        style={{ width: size, height: size }}
        role="slider"
        aria-label={label}
        aria-valuetext={`${horizontalName} ${(knob.x / radius).toFixed(2)}, ${verticalName} ${(-knob.y / radius).toFixed(2)}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {/* crosshair */}
        <div className="absolute left-1/2 top-[8%] bottom-[8%] w-px" style={{ background: "var(--border)" }} />
        <div className="absolute top-1/2 left-[8%] right-[8%] h-px" style={{ background: "var(--border)" }} />
        <div
          className="stick-knob"
          style={{
            width: knobSize,
            height: knobSize,
            left: `calc(50% - ${knobSize / 2}px)`,
            top: `calc(50% - ${knobSize / 2}px)`,
            transform: `translate(${knob.x}px, ${knob.y}px)`,
            transition: dragging ? "none" : "transform 0.18s ease-out",
          }}
        />
      </div>
      <div className="text-xs" style={{ color: "var(--dim)" }}>{label}</div>
    </div>
  );
}
