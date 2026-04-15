import {
  bind as tcpBind,
  unbind as tcpUnbind,
  send as tcpSend,
  listen as tcpListen,
  disconnect as tcpDisconnect,
  type Payload as TcpPayload,
} from "@kuyoonjo/tauri-plugin-tcp";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { BaseTransceiver } from "./BaseTransceiver";
import type { DataTransceiver, TcpServerConfig } from "./types";

// TCP 服务器收发器
export class TcpServerTransceiver
  extends BaseTransceiver
  implements DataTransceiver
{
  private unlistenFn: UnlistenFn | null = null;
  private readonly id: string;
  private clients: Set<string> = new Set();

  constructor(private readonly config: TcpServerConfig) {
    super();
    this.id = `tcp-server-${Date.now()}`;
  }

  private clearListener(): void {
    this.unlistenFn?.();
    this.unlistenFn = null;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error("Already listening");
    }

    try {
      for (const clientAddr of this.clients) {
        try {
          await tcpDisconnect(clientAddr);
        } catch (e) {
          console.error(`Error disconnecting client ${clientAddr}:`, e);
        }
      }
      await tcpUnbind(this.id);
    } catch (e) {
      // 忽略错误
    }

    const bindAddr = `${this.config.bindHost}:${this.config.listenPort}`;

    // 设置事件监听
    this.unlistenFn = await tcpListen((event) => {
      const payload = event.payload as TcpPayload;
      if (payload.id !== this.id) return;

      if (payload.event.connect) {
        this.clients.add(payload.event.connect);
        console.log(`Client connected: ${payload.event.connect}`);
      } else if (payload.event.disconnect) {
        this.clients.delete(payload.event.disconnect);
        console.log(`Client disconnected: ${payload.event.disconnect}`);
      } else if (payload.event.message) {
        this.emitData(new Uint8Array(payload.event.message.data));
      }
    });

    try {
      await tcpBind(this.id, bindAddr);
      this.connected = true;
    } catch (error) {
      this.clearListener();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // 无论是否已连接，都执行清理操作（支持 connecting 状态下的中断）
    try {
      // 先断开所有客户端连接
      for (const clientAddr of this.clients) {
        try {
          await tcpDisconnect(clientAddr);
        } catch (e) {
          console.error(`Error disconnecting client ${clientAddr}:`, e);
        }
      }
      // 再解绑服务器
      await tcpUnbind(this.id);
      await tcpDisconnect(this.id);
    } catch (e) {
      // 忽略错误（可能本来就没绑定）
    } finally {
      this.clearListener();
      this.clients.clear();
      this.markDisconnected();
    }
  }

  async send(data: string | Uint8Array): Promise<number> {
    this.assertConnected("Not listening");

    const sendData = typeof data === "string" ? data : Array.from(data);

    // 发送给所有连接的客户端
    for (const clientAddr of this.clients) {
      await tcpSend(this.id, sendData, clientAddr);
    }

    return typeof data === "string" ? data.length : data.length;
  }

  // 发送给指定客户端
  async sendTo(clientAddr: string, data: string | Uint8Array): Promise<number> {
    this.assertConnected("Not listening");

    const sendData = typeof data === "string" ? data : Array.from(data);
    await tcpSend(this.id, sendData, clientAddr);
    return typeof data === "string" ? data.length : data.length;
  }

  getConnectedClients(): string[] {
    return Array.from(this.clients);
  }
}
