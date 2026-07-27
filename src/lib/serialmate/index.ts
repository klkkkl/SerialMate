// 领域类型
export type {
  AppSettings,
  CharItem,
  ConnectionType,
  DataLine,
  FilterDirection,
  IndexedDataLine,
  LineEnding,
  SearchMode,
  TcpHistoryConfig,
  TcpServerHistoryConfig,
  TextEncoding,
  UdpHistoryConfig,
} from "./types";

// 连接
export {
  CONNECTION_TIMEOUT,
  createTransceiver,
  type ConnectionFormState,
} from "./connection";

// 编解码
export { decodeText, encodeText, formatHex, parseDataToChars } from "./encoding";

// 展示格式
export { directionSymbol, formatTimestamp, lineEndingSuffix } from "./format";

// 历史记录
export { HISTORY_LIMITS, upsertRecentItem } from "./history";

// 串口列表
export {
  normalizeSerialPorts,
  resolveSelectedPort,
  stripMacSerialPrefix,
  type SerialPortOption,
} from "./ports";

// 搜索与过滤
export {
  charMatchFlags,
  filterDataLines,
  hasActiveFilter,
  hasSearchQuery,
  hexMatchFlags,
  highlightMatch,
} from "./search";

// 选区
export {
  collectSelectedBytes,
  EMPTY_SELECTION,
  isByteSelected,
  isCharSelected,
  normalizeSelection,
  type NormalizedSelection,
  type SelectionAnchor,
} from "./selection";

// 串口跨窗口互斥锁
export {
  acquireSerialPortLock,
  releaseSerialPortLock,
  releaseWindowSerialPortLocks,
} from "./serialLock";

// 设置持久化
export {
  loadSettings,
  saveSettings,
  SETTINGS_DEFAULTS,
  settingsKey,
} from "./settings";

// 日志导出
export { formatLogText } from "./exportLog";
