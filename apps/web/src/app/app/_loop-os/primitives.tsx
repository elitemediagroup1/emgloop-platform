import type { Tone } from "./types";
import { sparkPath } from "./format";

export function StatusDot(props: { tone: Tone }) {
  return <span className={"loop-dot loop-dot--" + props.tone} aria-hidden="true" />;
}

export function Sparkline(props: { seed: number; tone: Tone }) {
  return (
    <svg className={"loop-spark loop-spark--" + props.tone} viewBox="0 0 120 62" preserveAspectRatio="none" aria-hidden="true">
      <path d={sparkPath(props.seed)} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
