import {
  bind as udpBind,
  unbind as udpUnbind,
  send as udpSend,
} from "@kuyoonjo/tauri-plugin-udp";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { BaseTransceiver } from "./BaseTransceiver";
import type { DataTransceiver, UdpConfig } from "./types";

// UDP 收发器
export class UdpTransceiver
  extends BaseTransceiver
  implements DataTransceiver
{
  private unlistenFn: UnlistenFn | null = null;
  private readonly id: string;

  constructor(private config: UdpConfig) {
    super();
    this.id = `udp-${Date.now()}`;
  }

  private clearListener(): void {
    this.unlistenFn?.();
    this.unlistenFn = null;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error("Already bound");
    }

    const localAddr = `0.0.0.0:${this.config.localPort}`;

    // 设置事件监听
    this.unlistenFn = await listen<{
      id: string;
      addr: string;
      data: number[];
    }>("plugin://udp", (event) => {
      const payload = event.payload;
      if (payload.id !== this.id) return;

      this.emitData(new Uint8Array(payload.data));
    });

    try {
      await udpBind(this.id, localAddr);
      this.connected = true;
    } catch (error) {
      this.clearListener();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // 无论是否已连接，都执行清理操作（支持 connecting 状态下的中断）
    try {
      await udpUnbind(this.id);
    } catch (e) {
      // 忽略错误（可能本来就没绑定）
    } finally {
      this.clearListener();
      this.markDisconnected();
    }
  }

  async send(data: string | Uint8Array): Promise<number> {
    this.assertConnected("Not bound");

    const remoteAddr = `${this.config.remoteHost}:${this.config.remotePort}`;
    const sendData = typeof data === "string" ? data : Array.from(data);
    await udpSend(this.id, remoteAddr, sendData);
    return typeof data === "string" ? data.length : data.length;
  }

  updateConfig(config: Partial<UdpConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
