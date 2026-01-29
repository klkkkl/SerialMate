import {
  DataBits,
  FlowControl,
  Parity,
  StopBits,
} from "tauri-plugin-serialplugin-api";

// 数据收发器接口
export interface DataTransceiver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: string | Uint8Array): Promise<number>;
  onData(callback: (data: string | Uint8Array) => void): void;
  onDisconnect(callback: () => void): void;
  offAllCallbacks(): void;
  isConnected(): boolean;
}

// 串口配置
export interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: DataBits;
  stopBits: StopBits;
  parity: Parity;
  flowControl?: FlowControl;
}

// TCP 客户端配置
export interface TcpClientConfig {
  remoteHost: string;
  remotePort: number;
  localPort?: number;
}

// TCP 服务器配置
export interface TcpServerConfig {
  bindHost: string;
  listenPort: number;
}

// UDP 配置
export interface UdpConfig {
  remoteHost: string;
  remotePort: number;
  localPort: number;
}

// 导出枚举类型
export {
  DataBits,
  FlowControl,
  Parity,
  StopBits,
} from "tauri-plugin-serialplugin-api";
