import { dataToString } from "$lib/transceiver";
import type { DataLine } from "./types";

const DIRECTION_LABELS: Record<DataLine["type"], string> = {
  rx: "[接收]",
  tx: "[发送]",
  system: "[系统]",
};

/** 将接收区内容序列化为可保存的纯文本日志 */
export function formatLogText(lines: DataLine[]): string {
  return lines
    .map((line) => {
      const prefix = DIRECTION_LABELS[line.type];
      const timestamp = line.timestamp ? `[${line.timestamp}] ` : "";

      if (line.data) {
        const ascii = dataToString(line.data, "ASCII");
        const hex = dataToString(line.data, "HEX");
        return `${timestamp}${prefix} ASCII: ${ascii} | HEX: ${hex}`;
      }

      return `${timestamp}${prefix} ${line.text}`;
    })
    .join("\n");
}
