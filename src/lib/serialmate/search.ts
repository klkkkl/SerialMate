import { formatHex } from "./encoding";
import type {
  CharItem,
  DataLine,
  FilterDirection,
  IndexedDataLine,
  SearchMode,
} from "./types";

interface FilterDataLinesOptions {
  lines: DataLine[];
  filterDirection: FilterDirection;
  searchText: string;
  searchMode: SearchMode;
  formatText: (data: Uint8Array) => string;
}

function normalizeHexQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, "");
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
  formatText,
}: FilterDataLinesOptions): IndexedDataLine[] {
  let result = lines.map((line, originalIndex) => ({ line, originalIndex }));

  if (filterDirection !== "all") {
    result = result.filter((item) => item.line.direction === filterDirection);
  }

  const normalizedQuery = searchText.trim().toLowerCase();
  if (!normalizedQuery) {
    return result;
  }

  return result.filter(({ line }) => {
    if (line.type === "system") {
      return line.text.toLowerCase().includes(normalizedQuery);
    }

    if (!line.data) {
      return false;
    }

    if (searchMode === "hex") {
      const hexData = formatHex(line.data).toLowerCase().replace(/\s+/g, "");
      return hexData.includes(normalizeHexQuery(searchText));
    }

    return formatText(line.data).toLowerCase().includes(normalizedQuery);
  });
}

export function isByteInHexSearchMatch(
  data: Uint8Array,
  byteIdx: number,
  searchText: string,
): boolean {
  const query = normalizeHexQuery(searchText);
  if (!query) {
    return false;
  }

  const normalizedHex = formatHex(data).toLowerCase().replace(/\s+/g, "");
  let matchPos = 0;

  while ((matchPos = normalizedHex.indexOf(query, matchPos)) !== -1) {
    const startByte = Math.floor(matchPos / 2);
    const endByte = Math.ceil((matchPos + query.length) / 2) - 1;

    if (byteIdx >= startByte && byteIdx <= endByte) {
      return true;
    }

    matchPos++;
  }

  return false;
}

export function isCharInTextSearchMatch(
  data: Uint8Array,
  item: CharItem,
  searchText: string,
  formatText: (data: Uint8Array) => string,
  parseChars: (data: Uint8Array) => CharItem[],
): boolean {
  const query = searchText.trim().toLowerCase();
  if (!query) {
    return false;
  }

  const text = formatText(data).toLowerCase();
  const chars = parseChars(data);
  const itemIdx = chars.findIndex(
    (char) => char.startIdx === item.startIdx && char.endIdx === item.endIdx,
  );

  if (itemIdx === -1) {
    return false;
  }

  let matchPos = 0;
  while ((matchPos = text.indexOf(query, matchPos)) !== -1) {
    const matchEnd = matchPos + query.length - 1;
    let currentTextPos = 0;
    let charStartIdx = -1;
    let charEndIdx = -1;

    for (let index = 0; index < chars.length; index++) {
      const charLength = chars[index].char.length;

      if (
        charStartIdx === -1 &&
        currentTextPos <= matchPos &&
        matchPos < currentTextPos + charLength
      ) {
        charStartIdx = index;
      }

      if (
        currentTextPos <= matchEnd &&
        matchEnd < currentTextPos + charLength
      ) {
        charEndIdx = index;
        break;
      }

      currentTextPos += charLength;
    }

    if (itemIdx >= charStartIdx && itemIdx <= charEndIdx) {
      return true;
    }

    matchPos++;
  }

  return false;
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
