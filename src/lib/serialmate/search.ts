import { decodeText, formatHex } from "./encoding";
import type {
  CharItem,
  DataLine,
  FilterDirection,
  IndexedDataLine,
  SearchMode,
  TextEncoding,
} from "./types";

interface FilterDataLinesOptions {
  lines: DataLine[];
  filterDirection: FilterDirection;
  searchText: string;
  searchMode: SearchMode;
  encoding: TextEncoding;
}

function normalizeHexQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, "");
}

function packedHex(data: Uint8Array): string {
  return formatHex(data).toLowerCase().replace(/\s+/g, "");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasSearchQuery(searchText: string): boolean {
  return searchText.trim() !== "";
}

export function hasActiveFilter(
  searchText: string,
  filterDirection: FilterDirection,
): boolean {
  return hasSearchQuery(searchText) || filterDirection !== "all";
}

export function filterDataLines({
  lines,
  filterDirection,
  searchText,
  searchMode,
  encoding,
}: FilterDataLinesOptions): IndexedDataLine[] {
  let result = lines.map((line, originalIndex) => ({ line, originalIndex }));

  if (filterDirection !== "all") {
    result = result.filter((item) => item.line.direction === filterDirection);
  }

  const normalizedQuery = searchText.trim().toLowerCase();
  if (!normalizedQuery) {
    return result;
  }

  const hexQuery = normalizeHexQuery(searchText);

  return result.filter(({ line }) => {
    if (line.type === "system") {
      return line.text.toLowerCase().includes(normalizedQuery);
    }

    if (!line.data) {
      return false;
    }

    if (searchMode === "hex") {
      return packedHex(line.data).includes(hexQuery);
    }

    return decodeText(line.data, encoding)
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

/**
 * 为一行数据的每个字节标记是否命中 HEX 搜索。
 * 每行只扫描一次，避免逐字节重复匹配。
 */
export function hexMatchFlags(
  data: Uint8Array,
  searchText: string,
): boolean[] {
  const flags = new Array<boolean>(data.length).fill(false);
  const query = normalizeHexQuery(searchText);
  if (!query) {
    return flags;
  }

  const hex = packedHex(data);
  let matchPos = 0;

  while ((matchPos = hex.indexOf(query, matchPos)) !== -1) {
    const startByte = Math.floor(matchPos / 2);
    const endByte = Math.min(
      Math.ceil((matchPos + query.length) / 2) - 1,
      data.length - 1,
    );

    for (let byteIdx = startByte; byteIdx <= endByte; byteIdx++) {
      flags[byteIdx] = true;
    }

    matchPos++;
  }

  return flags;
}

/**
 * 为一行数据的每个字符项标记是否命中文本搜索。
 * 字符与文本偏移的映射只建立一次。
 */
export function charMatchFlags(
  chars: CharItem[],
  searchText: string,
): boolean[] {
  const flags = new Array<boolean>(chars.length).fill(false);
  const query = searchText.trim().toLowerCase();
  if (!query) {
    return flags;
  }

  // 用小写片段拼接文本，保证偏移量与查找用的文本一致
  const offsets: number[] = [];
  const lengths: number[] = [];
  let text = "";

  for (const item of chars) {
    const lowered = item.char.toLowerCase();
    offsets.push(text.length);
    lengths.push(lowered.length);
    text += lowered;
  }

  let matchPos = 0;
  while ((matchPos = text.indexOf(query, matchPos)) !== -1) {
    const matchEnd = matchPos + query.length - 1;

    for (let index = 0; index < chars.length; index++) {
      const charStart = offsets[index];
      const charEnd = charStart + lengths[index] - 1;

      if (charEnd >= matchPos && charStart <= matchEnd) {
        flags[index] = true;
      }
    }

    matchPos++;
  }

  return flags;
}

export function highlightMatch(text: string, searchText: string): string {
  const query = searchText.trim();
  const safeText = escapeHtml(text);

  if (!query) {
    return safeText;
  }

  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  return safeText.replace(regex, '<mark class="search-highlight">$1</mark>');
}
