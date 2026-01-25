import { bind as tcpBind, unbind as tcpUnbind, send as tcpSend, listen as tcpListen, disconnect as tcpDisconnect, type Payload as TcpPayload } from "@kuyoonjo/tauri-plugin-tcp";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { DataTransceiver, TcpServerConfig } from "./types";

// TCP 服务器收发器
export class TcpServerTransceiver implements DataTransceiver {
    private config: TcpServerConfig;
    private connected: boolean = false;
    private dataCallback: ((data: string | Uint8Array) => void) | null = null;
    private disconnectCallback: (() => void) | null = null;
    private unlistenFn: UnlistenFn | null = null;
    private readonly id: string;
    private clients: Set<string> = new Set();

    constructor(config: TcpServerConfig) {
        this.config = config;

        this.id = `tcp-server-${Date.now()}`;
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
                const data = new Uint8Array(payload.event.message.data);
                if (this.dataCallback) {
                    this.dataCallback(data);
                }
            }
        });

        await tcpBind(this.id, bindAddr);
        this.connected = true;
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
            if (this.unlistenFn) {
                this.unlistenFn();
                this.unlistenFn = null;
            }
            this.clients.clear();
            const wasConnected = this.connected;
            this.connected = false;
            // 只有之前是连接状态才触发断开回调
            if (wasConnected && this.disconnectCallback) {
                this.disconnectCallback();
            }
        }
    }

    async send(data: string | Uint8Array): Promise<number> {
        if (!this.connected) {
            throw new Error("Not listening");
        }

        const sendData = typeof data === "string" ? data : Array.from(data);

        // 发送给所有连接的客户端
        for (const clientAddr of this.clients) {
            await tcpSend(this.id, sendData, clientAddr);
        }

        return typeof data === "string" ? data.length : data.length;
    }

    // 发送给指定客户端
    async sendTo(clientAddr: string, data: string | Uint8Array): Promise<number> {
        if (!this.connected) {
            throw new Error("Not listening");
        }

        const sendData = typeof data === "string" ? data : Array.from(data);
        await tcpSend(this.id, sendData, clientAddr);
        return typeof data === "string" ? data.length : data.length;
    }

    onData(callback: (data: string | Uint8Array) => void): void {
        this.dataCallback = callback;
    }

    onDisconnect(callback: () => void): void {
        this.disconnectCallback = callback;
    }

    offAllCallbacks(): void {
        this.dataCallback = null;
        this.disconnectCallback = null;
    }

    isConnected(): boolean {
        return this.connected;
    }

    getConnectedClients(): string[] {
        return Array.from(this.clients);
    }
}
