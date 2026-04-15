export type ConnectionType = "serial" | "tcp" | "tcpserver" | "udp";

export interface DataLine {
  type: "rx" | "tx" | "system";
  direction: "rx" | "tx" | "system";
  data: Uint8Array | null;
  text: string;
  timestamp?: string;
}

export type FilterDirection = "all" | "rx" | "tx";

export type LineEnding = "none" | "crlf" | "cr" | "lf";

export type SearchMode = "text" | "hex";

export type TextEncoding = "gb2312" | "gbk" | "utf-8" | "big5" | "ascii";

export interface TcpHistoryConfig {
  remoteHost: string;
  remotePort: string;
  localPort: string;
}

export interface TcpServerHistoryConfig {
  bindIp: string;
  listenPort: string;
}

export interface UdpHistoryConfig {
  remoteHost: string;
  remotePort: string;
  localPort: string;
}

export interface AppSettings {
  connectionType: ConnectionType;
  selectedPort: string;
  baudRate: string;
  dataBits: string;
  stopBits: string;
  parity: string;
  rtsEnabled: boolean;
  dtrEnabled: boolean;
  ipAddress: string;
  port: string;
  localPort: string;
  tcpServerPort: string;
  tcpServerBindIp: string;
  autoScroll: boolean;
  showTimestamp: boolean;
  hexSend: boolean;
  showHexArea: boolean;
  lineEnding: LineEnding;
  textEncoding: TextEncoding;
  timerInterval: number;
  commandHistory: string[];
  tcpHistory: TcpHistoryConfig[];
  tcpServerHistory: TcpServerHistoryConfig[];
  udpHistory: UdpHistoryConfig[];
}
