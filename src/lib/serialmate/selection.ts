import type { CharItem, DataLine } from "./types";

export interface SelectionAnchor {
  startLine: number | null;
  startByte: number | null;
  endLine: number | null;
  endByte: number | null;
}

export interface NormalizedSelection {
  startLine: number;
  startByte: number;
  endLine: number;
  endByte: number;
}

export const EMPTY_SELECTION: SelectionAnchor = {
  startLine: null,
  startByte: null,
  endLine: null,
  endByte: null,
};

/** 规范化选区，保证 start 在 end 之前 */
export function normalizeSelection(
  anchor: SelectionAnchor,
): NormalizedSelection | null {
  const { startLine, startByte, endLine, endByte } = anchor;

  if (
    startLine === null ||
    startByte === null ||
    endLine === null ||
    endByte === null
  ) {
    return null;
  }

  const reversed =
    endLine < startLine || (endLine === startLine && endByte < startByte);

  return reversed
    ? { startLine: endLine, startByte: endByte, endLine: startLine, endByte: startByte }
    : { startLine, startByte, endLine, endByte };
}

/** 判断某行的字节区间 [from, to] 是否与选区相交 */
function isRangeSelected(
  selection: NormalizedSelection | null,
  lineIdx: number,
  from: number,
  to: number,
): boolean {
  if (!selection) {
    return false;
  }

  const { startLine, startByte, endLine, endByte } = selection;

  if (lineIdx < startLine || lineIdx > endLine) {
    return false;
  }

  // 中间整行选中
  if (lineIdx > startLine && lineIdx < endLine) {
    return true;
  }

  if (lineIdx === startLine && lineIdx === endLine) {
    return to >= startByte && from <= endByte;
  }

  if (lineIdx === startLine) {
    return to >= startByte;
  }

  return from <= endByte;
}

export function isByteSelected(
  selection: NormalizedSelection | null,
  lineIdx: number,
  byteIdx: number,
): boolean {
  return isRangeSelected(selection, lineIdx, byteIdx, byteIdx);
}

export function isCharSelected(
  selection: NormalizedSelection | null,
  lineIdx: number,
  item: CharItem,
): boolean {
  return isRangeSelected(selection, lineIdx, item.startIdx, item.endIdx);
}

/** 取出选区覆盖的所有字节，跨行拼接 */
export function collectSelectedBytes(
  lines: DataLine[],
  selection: NormalizedSelection | null,
): Uint8Array {
  if (!selection) {
    return new Uint8Array(0);
  }

  const { startLine, startByte, endLine, endByte } = selection;
  const chunks: Uint8Array[] = [];

  for (let lineIdx = startLine; lineIdx <= endLine; lineIdx++) {
    const data = lines[lineIdx]?.data;
    if (!data) {
      continue;
    }

    const from = lineIdx === startLine ? startByte : 0;
    const to = lineIdx === endLine ? endByte : data.length - 1;

    if (from <= to && from < data.length) {
      chunks.push(data.slice(from, to + 1));
    }
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
