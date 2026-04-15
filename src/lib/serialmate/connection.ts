import {
  SerialTransceiver,
  TcpClientTransceiver,
  TcpServerTransceiver,
  UdpTransceiver,
} from "$lib/transceiver";
import type { DataBits, Parity, StopBits } from "tauri-plugin-serialplugin-api";
import type { DataTransceiver } from "$lib/transceiver";
import type { ConnectionType } from "./types";

/** 连接超时时间（毫秒） */
export const CONNECTION_TIMEOUT = 10_000;

export interface CreateTransceiverOptions {
  connectionType: ConnectionType;
  selectedPort: string;
  baudRate: string;
  dataBits: string;
  stopBits: string;
  parity: string;
  ipAddress: string;
  port: string;
  localPort: string;
  tcpServerPort: string;
  tcpServerBindIp: string;
}

/**
 * 根据连接类型创建对应的收发器实例
 */
export function createTransceiver(
  options: CreateTransceiverOptions,
): DataTransceiver {
  const { connectionType } = options;

  if (connectionType === "serial") {
    return new SerialTransceiver({
      port: options.selectedPort,
      baudRate: parseInt(options.baudRate),
      dataBits: parseInt(options.dataBits) as DataBits,
      stopBits: parseInt(options.stopBits) as unknown as StopBits,
      parity: options.parity as Parity,
    });
  }

  if (connectionType === "tcp") {
    return new TcpClientTransceiver({
      remoteHost: options.ipAddress,
      remotePort: parseInt(options.port),
      localPort: options.localPort ? parseInt(options.localPort) : undefined,
    });
  }

  if (connectionType === "tcpserver") {
    return new TcpServerTransceiver({
      bindHost: options.tcpServerBindIp,
      listenPort: parseInt(options.tcpServerPort),
    });
  }

  if (connectionType === "udp") {
    return new UdpTransceiver({
      remoteHost: options.ipAddress,
      remotePort: parseInt(options.port),
      localPort: parseInt(options.localPort) || 0,
    });
  }

  throw new Error(`Unknown connection type: ${connectionType}`);
}
