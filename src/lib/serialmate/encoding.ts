import { Buffer } from "buffer";
import * as iconv from "iconv-lite";
import type { CharItem, TextEncoding } from "./types";

const ASCII_PRINTABLE_MIN = 32;
const ASCII_PRINTABLE_MAX = 126;

function toAsciiDisplayChar(byte: number): string {
  return byte >= ASCII_PRINTABLE_MIN && byte <= ASCII_PRINTABLE_MAX
    ? String.fromCharCode(byte)
    : ".";
}

function decodeAsciiFallback(data: Uint8Array): string {
  return Array.from(data).map(toAsciiDisplayChar).join("");
}

export function formatHex(data: Uint8Array): string {
  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

export function encodeText(
  text: string,
  encoding: TextEncoding,
): Uint8Array {
  try {
    if (encoding === "ascii" || encoding === "utf-8") {
      return new TextEncoder().encode(text);
    }

    return new Uint8Array(iconv.encode(text, encoding));
  } catch {
    return new TextEncoder().encode(text);
  }
}

export function decodeText(data: Uint8Array, encoding: TextEncoding): string {
  try {
    if (encoding === "ascii") {
      return decodeAsciiFallback(data);
    }

    if (encoding === "utf-8") {
      return new TextDecoder("utf-8", { fatal: false }).decode(data);
    }

    return iconv.decode(Buffer.from(data), encoding);
  } catch {
    return decodeAsciiFallback(data);
  }
}

export function parseDataToChars(
  data: Uint8Array,
  encoding: TextEncoding,
): CharItem[] {
  const result: CharItem[] = [];

  if (encoding === "ascii") {
    for (let index = 0; index < data.length; index++) {
      result.push({
        char: toAsciiDisplayChar(data[index]),
        startIdx: index,
        endIdx: index,
      });
    }
    return result;
  }

  if (encoding === "utf-8") {
    let index = 0;

    while (index < data.length) {
      const currentByte = data[index];
      let charLength = 1;

      if ((currentByte & 0x80) === 0) {
        charLength = 1;
      } else if ((currentByte & 0xe0) === 0xc0) {
        charLength = 2;
      } else if ((currentByte & 0xf0) === 0xe0) {
        charLength = 3;
      } else if ((currentByte & 0xf8) === 0xf0) {
        charLength = 4;
      }

      const endIdx = Math.min(index + charLength - 1, data.length - 1);
      const slice = data.slice(index, endIdx + 1);

      try {
        const char = new TextDecoder("utf-8", { fatal: true }).decode(slice);
        result.push({ char, startIdx: index, endIdx });
        index = endIdx + 1;
      } catch {
        result.push({ char: ".", startIdx: index, endIdx: index });
        index++;
      }
    }

    return result;
  }

  try {
    const decoded = iconv.decode(Buffer.from(data), encoding);
    let byteIdx = 0;

    for (const char of decoded) {
      const charLength = iconv.encode(char, encoding).length;
      const endIdx = Math.min(byteIdx + charLength - 1, data.length - 1);

      if (byteIdx < data.length) {
        result.push({ char, startIdx: byteIdx, endIdx });
      }

      byteIdx += charLength;
    }

    while (byteIdx < data.length) {
      result.push({ char: ".", startIdx: byteIdx, endIdx: byteIdx });
      byteIdx++;
    }
  } catch {
    for (let index = 0; index < data.length; index++) {
      result.push({
        char: toAsciiDisplayChar(data[index]),
        startIdx: index,
        endIdx: index,
      });
    }
  }

  return result;
}
