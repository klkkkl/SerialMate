import {
  SerialPort,
  FlowControl,
  type PortInfo,
} from "tauri-plugin-serialplugin-api";
import type { DataTransceiver, SerialConfig } from "./types";

// 串口收发器
export class SerialTransceiver implements DataTransceiver {
  private port: SerialPort | null = null;
  private config: SerialConfig;
  private connected: boolean = false;
  private dataCallback: ((data: string | Uint8Array) => void) | null = null;
  private disconnectCallback: (() => void) | null = null;
  private unlistenFn: (() => void) | null = null;

  constructor(config: SerialConfig) {
    this.config = config;
  }

  // 获取可用串口列表
  static async getAvailablePorts(): Promise<{ [key: string]: PortInfo }> {
    return await SerialPort.available_ports();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error("Already connected");
    }

    this.port = new SerialPort({
      path: this.config.port,
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      stopBits: this.config.stopBits,
      parity: this.config.parity,
      flowControl: this.config.flowControl || FlowControl.None,
    });

    await this.port.open();
    await this.port.startListening();

    // 设置数据监听
    this.unlistenFn = await this.port.listen((data) => {
      if (this.dataCallback) {
        this.dataCallback(data);
      }
    });

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    // 无论是否已连接，都执行清理操作（支持 connecting 状态下的中断）
    try {
      if (this.unlistenFn) {
        this.unlistenFn();
        this.unlistenFn = null;
      }
      if (this.port) {
        await this.port.stopListening();
        await this.port.close();
      }
    } catch (e) {
      // 忽略错误（可能本来就没连接）
    } finally {
      this.port = null;
      const wasConnected = this.connected;
      this.connected = false;
      // 只有之前是连接状态才触发断开回调
      if (wasConnected && this.disconnectCallback) {
        this.disconnectCallback();
      }
    }
  }

  async send(data: string | Uint8Array): Promise<number> {
    if (!this.connected || !this.port) {
      throw new Error("Not connected");
    }

    if (typeof data === "string") {
      return await this.port.write(data);
    } else {
      return await this.port.writeBinary(data);
    }
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

  // 更新配置
  updateConfig(config: Partial<SerialConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // 设置 RTS (Request To Send) 信号
  async setRTS(level: boolean): Promise<void> {
    if (!this.connected || !this.port) {
      throw new Error("Not connected");
    }
    await this.port.writeRequestToSend(level);
  }

  // 设置 DTR (Data Terminal Ready) 信号
  async setDTR(level: boolean): Promise<void> {
    if (!this.connected || !this.port) {
      throw new Error("Not connected");
    }
    await this.port.writeDataTerminalReady(level);
  }

  // 读取 CTS (Clear To Send) 信号
  async readCTS(): Promise<boolean> {
    if (!this.connected || !this.port) {
      throw new Error("Not connected");
    }
    return await this.port.readClearToSend();
  }

  // 读取 DSR (Data Set Ready) 信号
  async readDSR(): Promise<boolean> {
    if (!this.connected || !this.port) {
      throw new Error("Not connected");
    }
    return await this.port.readDataSetReady();
  }

  // 读取 DCD (Data Carrier Detect) 信号
  async readDCD(): Promise<boolean> {
    if (!this.connected || !this.port) {
      throw new Error("Not connected");
    }
    return await this.port.readCarrierDetect();
  }
}
