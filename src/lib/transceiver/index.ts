// 类型导出
export type {
  DataTransceiver,
  SerialConfig,
  TcpClientConfig,
  TcpServerConfig,
  UdpConfig,
} from "./types";

export { DataBits, FlowControl, Parity, StopBits } from "./types";

// 收发器类导出
export { SerialTransceiver } from "./SerialTransceiver";
export { TcpClientTransceiver } from "./TcpClientTransceiver";
export { TcpServerTransceiver } from "./TcpServerTransceiver";
export { UdpTransceiver } from "./UdpTransceiver";

// 辅助函数导出
export {
  dataToString,
  hexStringToBytes,
  stringToBytes,
  bytesToString,
} from "./utils";
