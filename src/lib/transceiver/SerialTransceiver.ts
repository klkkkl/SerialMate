import {
  SerialPort,
  FlowControl,
  type PortInfo,
} from "tauri-plugin-serialplugin-api";
import { BaseTransceiver } from "./BaseTransceiver";
import type { DataTransceiver, SerialConfig } from "./types";

// 串口收发器
export class SerialTransceiver
  extends BaseTransceiver
  implements DataTransceiver
{
  private port: SerialPort | null = null;
  private unlistenFn: (() => void) | null = null;

  constructor(private config: SerialConfig) {
    super();
  }

  // 获取可用串口列表
  static async getAvailablePorts(): Promise<{ [key: string]: PortInfo }> {
    return await SerialPort.available_ports();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error("Already connected");
    }

    const port = new SerialPort({
      path: this.config.port,
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      stopBits: this.config.stopBits,
      parity: this.config.parity,
      flowControl: this.config.flowControl || FlowControl.None,
    });

    try {
      await port.open();
      await port.startListening();

      this.unlistenFn = await port.listen((data) => {
        this.emitData(data);
      });

      this.port = port;
      this.connected = true;
    } catch (error) {
      try {
        await port.stopListening();
      } catch {
        // 忽略清理错误
      }

      try {
        await port.close();
      } catch {
        // 忽略清理错误
      }

      throw error;
    }
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
      this.markDisconnected();
    }
  }

  async send(data: string | Uint8Array): Promise<number> {
    this.assertConnected();
    if (!this.port) throw new Error("Not connected");

    if (typeof data === "string") {
      return await this.port.write(data);
    } else {
      return await this.port.writeBinary(data);
    }
  }

  // 更新配置
  updateConfig(config: Partial<SerialConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // 设置 RTS (Request To Send) 信号
  async setRTS(level: boolean): Promise<void> {
    this.assertConnected();
    if (!this.port) throw new Error("Not connected");
    await this.port.writeRequestToSend(level);
  }

  // 设置 DTR (Data Terminal Ready) 信号
  async setDTR(level: boolean): Promise<void> {
    this.assertConnected();
    if (!this.port) throw new Error("Not connected");
    await this.port.writeDataTerminalReady(level);
  }

  // 读取 CTS (Clear To Send) 信号
  async readCTS(): Promise<boolean> {
    this.assertConnected();
    if (!this.port) throw new Error("Not connected");
    return await this.port.readClearToSend();
  }

  // 读取 DSR (Data Set Ready) 信号
  async readDSR(): Promise<boolean> {
    this.assertConnected();
    if (!this.port) throw new Error("Not connected");
    return await this.port.readDataSetReady();
  }

  // 读取 DCD (Data Carrier Detect) 信号
  async readDCD(): Promise<boolean> {
    this.assertConnected();
    if (!this.port) throw new Error("Not connected");
    return await this.port.readCarrierDetect();
  }
}
