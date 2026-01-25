import { connect as tcpConnect, disconnect as tcpDisconnect, send as tcpSend, listen as tcpListen, type Payload as TcpPayload } from "@kuyoonjo/tauri-plugin-tcp";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { DataTransceiver, TcpClientConfig } from "./types";

// TCP 客户端收发器
export class TcpClientTransceiver implements DataTransceiver {
    private config: TcpClientConfig;
    private connected: boolean = false;
    private dataCallback: ((data: string | Uint8Array) => void) | null = null;
    private disconnectCallback: (() => void) | null = null;
    private unlistenFn: UnlistenFn | null = null;
    private readonly id: string;

    constructor(config: TcpClientConfig) {
        this.config = config;
        this.id = `tcp-client-${Date.now()}`;
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
                const data = new Uint8Array(payload.event.message.data);
                if (this.dataCallback) {
                    this.dataCallback(data);
                }
            } else if (payload.event.disconnect) {
                this.connected = false;
                if (this.disconnectCallback) {
                    this.disconnectCallback();
                }
            }
        });

        await tcpConnect(this.id, remoteAddr);
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        // 无论是否已连接，都执行清理操作（支持 connecting 状态下的中断）
        try {
            await tcpDisconnect(this.id);
        } catch (e) {
            // 忽略错误（可能本来就没连接）
        } finally {
            if (this.unlistenFn) {
                this.unlistenFn();
                this.unlistenFn = null;
            }
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
            throw new Error("Not connected");
        }

        const sendData = typeof data === "string" ? data : Array.from(data);
        await tcpSend(this.id, sendData);
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
}
