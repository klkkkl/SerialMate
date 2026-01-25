import { bind as udpBind, unbind as udpUnbind, send as udpSend } from "@kuyoonjo/tauri-plugin-udp";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { DataTransceiver, UdpConfig } from "./types";

// UDP 收发器
export class UdpTransceiver implements DataTransceiver {
    private config: UdpConfig;
    private connected: boolean = false;
    private dataCallback: ((data: string | Uint8Array) => void) | null = null;
    private disconnectCallback: (() => void) | null = null;
    private unlistenFn: UnlistenFn | null = null;
    private readonly id: string;

    constructor(config: UdpConfig) {
        this.config = config;
        this.id = `udp-${Date.now()}`;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            throw new Error("Already bound");
        }

        const localAddr = `0.0.0.0:${this.config.localPort}`;

        // 设置事件监听
        this.unlistenFn = await listen<{ id: string; addr: string; data: number[] }>("plugin://udp", (event) => {
            const payload = event.payload;
            if (payload.id !== this.id) return;

            const data = new Uint8Array(payload.data);
            if (this.dataCallback) {
                this.dataCallback(data);
            }
        });

        await udpBind(this.id, localAddr);
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        // 无论是否已连接，都执行清理操作（支持 connecting 状态下的中断）
        try {
            await udpUnbind(this.id);
        } catch (e) {
            // 忽略错误（可能本来就没绑定）
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
            throw new Error("Not bound");
        }

        const remoteAddr = `${this.config.remoteHost}:${this.config.remotePort}`;
        const sendData = typeof data === "string" ? data : Array.from(data);
        await udpSend(this.id, remoteAddr, sendData);
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

    updateConfig(config: Partial<UdpConfig>): void {
        this.config = { ...this.config, ...config };
    }
}
