import type { AppSettings } from "./types";

export const SETTINGS_DEFAULTS: AppSettings = {
  connectionType: "serial",
  selectedPort: "",
  baudRate: "115200",
  dataBits: "8",
  stopBits: "1",
  parity: "None",
  rtsEnabled: false,
  dtrEnabled: false,
  ipAddress: "127.0.0.1",
  port: "8080",
  localPort: "",
  tcpServerPort: "8080",
  tcpServerBindIp: "0.0.0.0",
  autoScroll: true,
  showTimestamp: false,
  hexSend: false,
  showHexArea: true,
  lineEnding: "none",
  textEncoding: "gb2312",
  timerInterval: 1000,
  commandHistory: [],
  tcpHistory: [],
  tcpServerHistory: [],
  udpHistory: [],
};

export function settingsKey(windowLabel: string): string {
  return `serialmate_settings_${windowLabel}`;
}

/** 读取持久化设置，缺失字段回落到默认值 */
export function loadSettings(windowLabel: string): AppSettings {
  try {
    const saved = localStorage.getItem(settingsKey(windowLabel));
    if (!saved) {
      return { ...SETTINGS_DEFAULTS };
    }

    const parsed = JSON.parse(saved) as Partial<AppSettings> | null;
    if (!parsed || typeof parsed !== "object") {
      return { ...SETTINGS_DEFAULTS };
    }

    const merged = { ...SETTINGS_DEFAULTS };
    for (const key of Object.keys(SETTINGS_DEFAULTS) as (keyof AppSettings)[]) {
      const value = parsed[key];
      if (value !== undefined && value !== null) {
        merged[key] = value as never;
      }
    }

    return merged;
  } catch (error) {
    console.error("加载设置失败:", error);
    return { ...SETTINGS_DEFAULTS };
  }
}

export function saveSettings(
  windowLabel: string,
  settings: AppSettings,
): void {
  try {
    localStorage.setItem(settingsKey(windowLabel), JSON.stringify(settings));
  } catch (error) {
    console.error("保存设置失败:", error);
  }
}
