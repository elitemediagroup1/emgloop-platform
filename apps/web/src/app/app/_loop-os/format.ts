export function money(cents: number | null | undefined): string {
  const n = typeof cents === "number" && !Number.isNaN(cents) ? cents : 0;
  const dollars = n / 100;
  return "$" + Math.round(dollars).toLocaleString("en-US");
}

export function num(n: number | null | undefined): string {
  const v = typeof n === "number" && !Number.isNaN(n) ? n : 0;
  return v.toLocaleString("en-US");
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function todayLabel(): string {
  try {
    return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.round(hrs / 24) + "d ago";
}

export function clockDuration(seconds: number | null | undefined): string {
  const s = typeof seconds === "number" && !Number.isNaN(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}

export function sparkPath(seed: number): string {
  const pts: number[] = [];
  for (let i = 0; i < 16; i++) {
    const wob = Math.sin((i + seed) * 0.9) * 14 + Math.cos((i + seed) * 0.5) * 8;
    pts.push(Math.max(6, Math.min(56, 40 + wob)));
  }
  const step = 120 / (pts.length - 1);
  return pts
    .map((y, i) => (i === 0 ? "M" : "L") + (i * step).toFixed(1) + " " + y.toFixed(1))
    .join(" ");
}
