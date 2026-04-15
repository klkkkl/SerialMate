import {
  connect as tcpConnect,
  disconnect as tcpDisconnect,
  send as tcpSend,
  listen as tcpListen,
  type Payload as TcpPayload,
} from "@kuyoonjo/tauri-plugin-tcp";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { BaseTransceiver } from "./BaseTransceiver";
import type { DataTransceiver, TcpClientConfig } from "./types";

// TCP 客户端收发器
export class TcpClientTransceiver
  extends BaseTransceiver
  implements DataTransceiver
{
  private unlistenFn: UnlistenFn | null = null;
  private readonly id: string;

  constructor(private readonly config: TcpClientConfig) {
    super();
    this.id = `tcp-client-${Date.now()}`;
  }

  private clearListener(): void {
    this.unlistenFn?.();
    this.unlistenFn = null;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error("Already connected");
    }

    const remoteAddr = `${this.config.remoteHost}:${this.config.remotePort}`;

    // 设置事件监听
    this.unlistenFn = await tcpListen((event) => {
      const payload = event.payload as TcpPayload;
      if (payload.id !== this.id) return;

      if (payload.event.message) {
        this.emitData(new Uint8Array(payload.event.message.data));
      } else if (payload.event.disconnect) {
        this.clearListener();
        this.markDisconnected();
      }
    });

    try {
      await tcpConnect(this.id, remoteAddr);
      this.connected = true;
    } catch (error) {
      this.clearListener();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // 无论是否已连接，都执行清理操作（支持 connecting 状态下的中断）
    try {
      await tcpDisconnect(this.id);
    } catch (e) {
      // 忽略错误（可能本来就没连接）
    } finally {
      this.clearListener();
      this.markDisconnected();
    }
  }

  async send(data: string | Uint8Array): Promise<number> {
    this.assertConnected();

    const sendData = typeof data === "string" ? data : Array.from(data);
    await tcpSend(this.id, sendData);
    return typeof data === "string" ? data.length : data.length;
  }
}
