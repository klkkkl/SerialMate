import type { DataTransceiver } from "./types";

export abstract class BaseTransceiver implements DataTransceiver {
  protected connected = false;

  private dataCallback: ((data: string | Uint8Array) => void) | null = null;
  private disconnectCallback: (() => void) | null = null;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(data: string | Uint8Array): Promise<number>;

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

  protected emitData(data: string | Uint8Array): void {
    this.dataCallback?.(data);
  }

  protected markDisconnected(): void {
    const wasConnected = this.connected;
    this.connected = false;

    if (wasConnected) {
      this.disconnectCallback?.();
    }
  }

  protected assertConnected(message = "Not connected"): void {
    if (!this.connected) {
      throw new Error(message);
    }
  }
}
