import type { LineEnding } from "./types";

const LINE_ENDING_SUFFIX: Record<LineEnding, string> = {
  none: "",
  crlf: "\r\n",
  cr: "\r",
  lf: "\n",
};

export function lineEndingSuffix(lineEnding: LineEnding): string {
  return LINE_ENDING_SUFFIX[lineEnding] ?? "";
}

/** 当前时间戳，格式 HH:mm:ss.SSS */
export function formatTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2) =>
    value.toString().padStart(width, "0");

  return (
    `${pad(date.getHours())}:${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

export function directionSymbol(direction: "rx" | "tx" | "system"): string {
  if (direction === "rx") return "←";
  if (direction === "tx") return "→";
  return "●";
}
