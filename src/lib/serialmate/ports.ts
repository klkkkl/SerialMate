import type { PortInfo } from "tauri-plugin-serialplugin-api";

export interface SerialPortOption {
  label: string;
  path: string;
}

function isMacOS(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
}

function getPortPath(
  key: string,
  info: Partial<PortInfo> | undefined,
): string {
  const rawPath = info?.path;
  if (typeof rawPath === "string" && rawPath && rawPath !== "Unknown") {
    return rawPath;
  }
  return key;
}

/** 取出 macOS 串口设备名（去掉 /dev/cu. 或 /dev/tty. 前缀） */
export function stripMacSerialPrefix(
  path: string | null | undefined,
): string | null {
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }
  const match = path.match(/^\/dev\/(?:cu|tty)\.(.+)$/);
  return match ? match[1] : null;
}

/**
 * 规范化串口列表。macOS 上同一设备会同时出现 cu.* 和 tty.*，
 * 合并为一项并优先使用 cu.*。
 */
export function normalizeSerialPorts(
  ports: Record<string, PortInfo>,
): SerialPortOption[] {
  const portEntries = Object.entries(ports).filter(
    ([key]) => typeof key === "string" && key.length > 0,
  );

  if (!isMacOS()) {
    return portEntries.map(([key, info]) => {
      const path = getPortPath(key, info);
      return { label: path, path };
    });
  }

  const normalizedPorts = new Map<string, SerialPortOption>();

  for (const [key, info] of portEntries) {
    const path = getPortPath(key, info);
    const strippedLabel = stripMacSerialPrefix(path);

    if (!strippedLabel) {
      normalizedPorts.set(path, { label: path, path });
      continue;
    }

    const existing = normalizedPorts.get(strippedLabel);
    const prefersCurrentPath = path.startsWith("/dev/cu.");

    if (!existing || prefersCurrentPath) {
      normalizedPorts.set(strippedLabel, { label: strippedLabel, path });
    }
  }

  return Array.from(normalizedPorts.values());
}

/** 刷新后重新定位当前选中的串口，找不到则退回第一项 */
export function resolveSelectedPort(
  ports: SerialPortOption[],
  currentPath: string,
): string {
  if (ports.length === 0) {
    return "";
  }

  const currentLabel = stripMacSerialPrefix(currentPath);
  const matched = ports.find(
    (option) =>
      option.path === currentPath ||
      (currentLabel !== null && option.label === currentLabel),
  );

  return matched ? matched.path : ports[0].path;
}
