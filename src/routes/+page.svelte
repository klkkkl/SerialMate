<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { save } from "@tauri-apps/plugin-dialog";
  import { writeTextFile } from "@tauri-apps/plugin-fs";
  import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { browser } from "$app/environment";
  import { Buffer } from "buffer";
  import * as iconv from "iconv-lite";
  import type { PortInfo } from "tauri-plugin-serialplugin-api";
  import "./+page.css";
  import {
    SerialTransceiver,
    dataToString,
    hexStringToBytes,
    type DataTransceiver,
  } from "$lib/transceiver";
  import {
    CONNECTION_TIMEOUT,
    createTransceiver,
  } from "$lib/serialmate/connection";
  import { HISTORY_LIMITS, upsertRecentItem } from "$lib/serialmate/history";
  import {
    acquireSerialPortLock,
    releaseSerialPortLock,
    releaseWindowSerialPortLocks,
  } from "$lib/serialmate/serialLock";
  import type {
    AppSettings,
    ConnectionType,
    DataLine,
    FilterDirection,
    LineEnding,
    SearchMode,
    TextEncoding,
    TcpHistoryConfig,
    TcpServerHistoryConfig,
    UdpHistoryConfig,
  } from "$lib/serialmate/types";

  interface SerialPortOption {
    label: string;
    path: string;
  }

  // 连接类型：串口、TCP、TCP Server、UDP
  let connectionType = $state<ConnectionType>("serial");
  let isConnected = $state(false);
  let isConnecting = $state(false); // 正在连接中

  // 当前收发器实例
  let transceiver: DataTransceiver | null = $state(null);
  let lockedSerialPort = $state<string | null>(null);

  // 串口配置
  let serialPorts = $state<SerialPortOption[]>([]);
  let selectedPort = $state("");
  let baudRate = $state("115200");
  let dataBits = $state("8");
  let stopBits = $state("1");
  let parity = $state("None");

  // 串口控制信号（RTS/DTR 可设置，CTS/DSR/DCD 只读）
  let rtsEnabled = $state(false);
  let dtrEnabled = $state(false);
  let ctsState = $state(false);
  let dsrState = $state(false);
  let dcdState = $state(false);
  let signalPollingTimer: ReturnType<typeof setInterval> | null = null;

  // 网络配置
  let ipAddress = $state("127.0.0.1");
  let port = $state("8080");
  let localPort = $state(""); // TCP/UDP 本地端口
  let tcpServerPort = $state("8080"); // TCP Server 监听端口
  let tcpServerBindIp = $state("0.0.0.0"); // TCP Server 绑定IP
  let localIpAddresses = $state<string[]>(["0.0.0.0", "127.0.0.1"]); // 本机可用IP列表

  let tcpHistory = $state<TcpHistoryConfig[]>([]);
  let tcpServerHistory = $state<TcpServerHistoryConfig[]>([]);
  let udpHistory = $state<UdpHistoryConfig[]>([]);

  let dataLines = $state<DataLine[]>([]);
  let sendData = $state("");

  // 历史指令（最多15条不重复）
  let commandHistory = $state<string[]>([]);

  // 统计
  let rxBytes = $state(0);
  let txBytes = $state(0);

  // 设置选项
  let autoScroll = $state(true);
  let showTimestamp = $state(false);
  let hexSend = $state(false);
  let showHexArea = $state(true);
  let lineEnding = $state<LineEnding>("none");

  // 搜索和过滤
  let searchText = $state("");
  let searchMode = $state<SearchMode>("text");
  let filterDirection = $state<FilterDirection>("all");

  // 保存的滚动位置（用于 HEX 切换时保持位置）
  let savedScrollRatio = 0;

  // 切换 HEX 显示，保持滚动位置
  function toggleHexArea(show: boolean) {
    const container = document.getElementById("receive-container");
    if (container) {
      // 保存当前滚动比例
      const scrollHeight = container.scrollHeight - container.clientHeight;
      savedScrollRatio =
        scrollHeight > 0 ? container.scrollTop / scrollHeight : 0;
    }
    showHexArea = show;
    // 恢复滚动位置
    setTimeout(() => {
      const newContainer = document.getElementById("receive-container");
      if (newContainer) {
        const newScrollHeight =
          newContainer.scrollHeight - newContainer.clientHeight;
        newContainer.scrollTop = savedScrollRatio * newScrollHeight;
      }
    }, 10);
  }

  // 定时发送
  let timerEnabled = $state(false);
  let timerInterval = $state(1000); // 毫秒
  let timerRef: ReturnType<typeof setInterval> | null = null;

  // 选中状态：支持跨行选中
  // 起始位置
  let selStartLine = $state<number | null>(null);
  let selStartByte = $state<number | null>(null);
  // 结束位置
  let selEndLine = $state<number | null>(null);
  let selEndByte = $state<number | null>(null);

  let textEncoding = $state<TextEncoding>("gb2312");

  // 右键菜单状态
  let contextMenuVisible = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);
  let contextMenuType = $state<"text" | "hex">("hex");
  let receiveContainer = $state<HTMLDivElement | null>(null);

  const currentWindowLabel = browser ? WebviewWindow.getCurrent().label : "main";

  function isMacOS(): boolean {
    return typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
  }

  function getPortPath(key: string, info: Partial<PortInfo> | undefined): string {
    const rawPath = info?.path;
    if (typeof rawPath === "string" && rawPath && rawPath !== "Unknown") {
      return rawPath;
    }
    return key;
  }

  function stripMacSerialPrefix(path: string | null | undefined): string | null {
    if (typeof path !== "string" || path.length === 0) {
      return null;
    }
    const match = path.match(/^\/dev\/(?:cu|tty)\.(.+)$/);
    return match ? match[1] : null;
  }

  function normalizeSerialPorts(
    ports: Record<string, PortInfo>,
  ): SerialPortOption[] {
    const portEntries = Object.entries(ports).filter(
      ([key]) => typeof key === "string" && key.length > 0,
    );
    if (!isMacOS()) {
      return portEntries.map(([key, info]) => {
        const path = getPortPath(key, info);
        return { label: path, path };
      });
    }

    const normalizedPorts = new Map<string, SerialPortOption>();

    for (const [key, info] of portEntries) {
      const path = getPortPath(key, info);
      const strippedLabel = stripMacSerialPrefix(path);

      if (!strippedLabel) {
        normalizedPorts.set(path, { label: path, path });
        continue;
      }

      const existing = normalizedPorts.get(strippedLabel);
      const prefersCurrentPath = path.startsWith("/dev/cu.");

      if (!existing || prefersCurrentPath) {
        normalizedPorts.set(strippedLabel, {
          label: strippedLabel,
          path,
        });
      }
    }

    return Array.from(normalizedPorts.values());
  }

  async function openNewWindow() {
    if (!browser) {
      return;
    }

    const label = `serialmate-${Date.now()}`;
    const newWindow = new WebviewWindow(label, {
      title: "SerialMate",
      url: "/",
      width: 800,
      height: 600,
    });

    newWindow.once("tauri://error", (event) => {
      console.error("新建窗口失败:", event.payload);
      appendSystemMessage(`新建窗口失败: ${event.payload}`);
    });
  }

  // 刷新串口列表
  async function refreshPorts() {
    try {
      const ports = await SerialTransceiver.getAvailablePorts();
      serialPorts = normalizeSerialPorts(ports);

      if (serialPorts.length === 0) {
        selectedPort = "";
        return;
      }

      const selectedPortLabel = stripMacSerialPrefix(selectedPort);
      const matchedPort = serialPorts.find(
        (portOption) =>
          portOption.path === selectedPort ||
          (selectedPortLabel !== null && portOption.label === selectedPortLabel),
      );

      if (matchedPort) {
        selectedPort = matchedPort.path;
      } else {
        selectedPort = serialPorts[0].path;
      }
    } catch (error) {
      console.error("刷新串口失败:", error);
      appendSystemMessage(`刷新串口失败: ${error}`);
    }
  }

  // 获取本机IP地址列表
  async function refreshLocalIps() {
    try {
      // 通过后端 Rust 获取本机IP
      const ips = await invoke<string[]>("get_local_ips");
      localIpAddresses = ips;
    } catch (error) {
      console.error("获取本机IP失败:", error);
      localIpAddresses = ["0.0.0.0", "127.0.0.1"];
    }
  }

  // 启动信号状态轮询
  function startSignalPolling() {
    if (signalPollingTimer) return;
    signalPollingTimer = setInterval(async () => {
      if (isConnected && transceiver instanceof SerialTransceiver) {
        try {
          ctsState = await transceiver.readCTS();
          dsrState = await transceiver.readDSR();
          dcdState = await transceiver.readDCD();
        } catch (e) {
          // 忽略轮询错误
        }
      }
    }, 500);
  }

  // 停止信号状态轮询
  function stopSignalPolling() {
    if (signalPollingTimer) {
      clearInterval(signalPollingTimer);
      signalPollingTimer = null;
    }
    // 重置状态
    ctsState = false;
    dsrState = false;
    dcdState = false;
  }

  // 设置 RTS 信号
  async function toggleRTS() {
    if (!isConnected || !(transceiver instanceof SerialTransceiver)) return;
    try {
      rtsEnabled = !rtsEnabled;
      await transceiver.setRTS(rtsEnabled);
    } catch (e) {
      console.error("设置 RTS 失败:", e);
      rtsEnabled = !rtsEnabled; // 回滚
    }
  }

  // 设置 DTR 信号
  async function toggleDTR() {
    if (!isConnected || !(transceiver instanceof SerialTransceiver)) return;
    try {
      dtrEnabled = !dtrEnabled;
      await transceiver.setDTR(dtrEnabled);
    } catch (e) {
      console.error("设置 DTR 失败:", e);
      dtrEnabled = !dtrEnabled; // 回滚
    }
  }

  // 通用历史配置管理函数
  function addToHistory<T>(
    history: T[],
    config: T,
    keyFn: (c: T) => string,
    maxItems = 10,
  ): T[] {
    const key = keyFn(config);
    return [config, ...history.filter((c) => keyFn(c) !== key)].slice(
      0,
      maxItems,
    );
  }

  // 添加 TCP 历史配置
  function addTcpHistory(config: TcpHistoryConfig) {
    tcpHistory = upsertRecentItem(
      tcpHistory,
      config,
      (item) => `${item.remoteHost}:${item.remotePort}:${item.localPort}`,
      HISTORY_LIMITS.network,
    );
  }

  // 添加 TCP Server 历史配置
  function addTcpServerHistory(config: TcpServerHistoryConfig) {
    tcpServerHistory = upsertRecentItem(
      tcpServerHistory,
      config,
      (item) => `${item.bindIp}:${item.listenPort}`,
      HISTORY_LIMITS.network,
    );
  }

  // 添加 UDP 历史配置
  function addUdpHistory(config: UdpHistoryConfig) {
    udpHistory = upsertRecentItem(
      udpHistory,
      config,
      (item) => `${item.remoteHost}:${item.remotePort}:${item.localPort}`,
      HISTORY_LIMITS.network,
    );
  }

  // 应用 TCP 历史配置
  function applyTcpHistory(config: TcpHistoryConfig) {
    ipAddress = config.remoteHost;
    port = config.remotePort;
    localPort = config.localPort;
  }

  // 应用 TCP Server 历史配置
  function applyTcpServerHistory(config: TcpServerHistoryConfig) {
    tcpServerBindIp = config.bindIp;
    tcpServerPort = config.listenPort;
  }

  // 应用 UDP 历史配置
  function applyUdpHistory(config: UdpHistoryConfig) {
    ipAddress = config.remoteHost;
    port = config.remotePort;
    localPort = config.localPort;
  }

  // 连接控制器，用于取消连接
  let connectController: AbortController | null = null;

  // 连接/断开
  async function toggleConnection() {
    if (isConnecting) {
      // 如果正在连接中，取消连接
      cancelConnect();
    } else if (isConnected) {
      await disconnect();
    } else {
      await connect();
    }
  }

  // 取消连接
  function cancelConnect() {
    if (connectController) {
      connectController.abort();
    }
    // 立即清理 transceiver
    if (transceiver) {
      try {
        transceiver.offAllCallbacks();
        transceiver.disconnect().catch(() => {}); // 异步断开，不等待
      } catch (e) {
        // 忽略
      }
      transceiver = null;
    }
    if (lockedSerialPort) {
      releaseSerialPortLock({
        windowLabel: currentWindowLabel,
        portPath: lockedSerialPort,
      }).catch(() => {});
      lockedSerialPort = null;
    }
    isConnecting = false;
    connectController = null;
    appendSystemMessage("连接已取消");
  }

  async function releaseLockedSerialPort() {
    if (!lockedSerialPort) {
      return;
    }

    const portPath = lockedSerialPort;
    lockedSerialPort = null;

    try {
      await releaseSerialPortLock({
        windowLabel: currentWindowLabel,
        portPath,
      });
    } catch (error) {
      console.error("释放串口锁失败:", error);
    }
  }

  async function connect() {
    // 如果正在连接中，忽略
    if (isConnecting) return;

    // 创建新的 AbortController
    connectController = new AbortController();
    const signal = connectController.signal;

    // 清理旧的 transceiver
    if (transceiver) {
      transceiver.offAllCallbacks();
      try {
        await transceiver.disconnect();
      } catch (e) {
        // 忽略
      }
      transceiver = null;
    }
    await releaseLockedSerialPort();

    isConnecting = true;
    appendSystemMessage("正在连接...");
    try {
      if (connectionType === "serial") {
        await acquireSerialPortLock({
          windowLabel: currentWindowLabel,
          portPath: selectedPort,
        });
        lockedSerialPort = selectedPort;
      }

      transceiver = createTransceiver({
        connectionType,
        selectedPort,
        baudRate,
        dataBits,
        stopBits,
        parity,
        ipAddress,
        port,
        localPort,
        tcpServerPort,
        tcpServerBindIp,
      });

      if (transceiver) {
        // 设置数据回调
        transceiver.onData((data) => {
          const bytes =
            typeof data === "string"
              ? new TextEncoder().encode(data)
              : (data as Uint8Array);
          appendDataLine("rx", bytes);
          rxBytes += bytes.length;
        });

        // 设置断开回调
        transceiver.onDisconnect(() => {
          isConnected = false;
          appendSystemMessage("连接已断开");
        });

        // 检查是否已取消
        if (signal.aborted) {
          throw new Error("连接已取消");
        }

        // 带超时的连接
        const connectPromise = transceiver.connect();
        const timeoutPromise = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`连接超时 (${CONNECTION_TIMEOUT / 1000}秒)`));
          }, CONNECTION_TIMEOUT);

          // 如果被取消，清除定时器
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("连接已取消"));
          });
        });

        await Promise.race([connectPromise, timeoutPromise]);

        // 再次检查是否已取消
        if (signal.aborted) {
          throw new Error("连接已取消");
        }

        isConnected = true;
        appendSystemMessage("连接成功");

        // 保存网络连接历史配置
        if (connectionType === "tcp") {
          addTcpHistory({ remoteHost: ipAddress, remotePort: port, localPort });
        } else if (connectionType === "tcpserver") {
          addTcpServerHistory({
            bindIp: tcpServerBindIp,
            listenPort: tcpServerPort,
          });
        } else if (connectionType === "udp") {
          addUdpHistory({ remoteHost: ipAddress, remotePort: port, localPort });
        }

        // 串口连接成功后设置 RTS/DTR 信号并启动状态轮询
        if (
          connectionType === "serial" &&
          transceiver instanceof SerialTransceiver
        ) {
          try {
            await transceiver.setRTS(rtsEnabled);
            await transceiver.setDTR(dtrEnabled);
          } catch (e) {
            console.error("设置 RTS/DTR 失败:", e);
          }
          // 启动信号状态轮询
          startSignalPolling();
        }
      }
    } catch (error) {
      console.error("连接失败:", error);
      appendSystemMessage(`连接失败: ${error}`);
      // 清理可能部分初始化的 transceiver
      if (transceiver) {
        try {
          transceiver.offAllCallbacks();
          await transceiver.disconnect();
        } catch (e) {
          // 忽略清理错误
        }
        transceiver = null;
      }
      await releaseLockedSerialPort();
    } finally {
      isConnecting = false;
      connectController = null;
    }
  }

  async function disconnect() {
    // 如果正在连接中，调用取消连接
    if (isConnecting) {
      cancelConnect();
      return;
    }

    // 停止定时发送
    stopTimer();
    timerEnabled = false;

    // 停止信号状态轮询
    stopSignalPolling();

    try {
      if (transceiver) {
        await transceiver.disconnect();
        transceiver = null;
      }
      await releaseLockedSerialPort();
      isConnected = false;
      appendSystemMessage("已断开连接");
    } catch (error) {
      console.error("断开失败:", error);
      appendSystemMessage(`断开失败: ${error}`);
      await releaseLockedSerialPort();
    }
  }

  // 发送数据
  async function sendMessage() {
    if (!sendData.trim()) return;

    // 如果未连接，先尝试连接
    if (!isConnected || !transceiver) {
      await connect();
      // 连接失败则返回
      if (!isConnected || !transceiver) {
        return;
      }
    }

    try {
      let dataToSend: Uint8Array;
      if (hexSend) {
        dataToSend = hexStringToBytes(sendData);
      } else {
        // 根据选择的编码进行编码
        let textToSend = sendData;
        if (lineEnding === "crlf") {
          textToSend += "\r\n";
        } else if (lineEnding === "cr") {
          textToSend += "\r";
        } else if (lineEnding === "lf") {
          textToSend += "\n";
        }
        dataToSend = encodeText(textToSend);
      }

      const bytesSent = await transceiver.send(dataToSend);
      txBytes += bytesSent;
      appendDataLine("tx", dataToSend);

      // 更新历史指令（去重并限制为15条）
      updateCommandHistory(sendData.trim());
    } catch (error) {
      console.error("发送失败:", error);
      appendSystemMessage(`发送失败: ${error}`);
      // 发送异常后自动断开连接
      await disconnect();
    }
  }

  // 更新历史指令
  function updateCommandHistory(command: string) {
    if (!command) return;

    // 移除重复项（如果存在）
    commandHistory = commandHistory.filter((cmd) => cmd !== command);

    // 添加到开头
    commandHistory = [command, ...commandHistory];

    // 限制为15条
    if (commandHistory.length > 15) {
      commandHistory = commandHistory.slice(0, 15);
    }
  }

  // 从历史记录选择指令
  function selectFromHistory(command: string) {
    sendData = command;
  }

  // 检查是否有搜索/过滤条件 (派生状态)
  let hasFilter = $derived(
    searchText.trim() !== "" || filterDirection !== "all",
  );

  // 检查是否有搜索文本 (派生状态)
  let hasSearchText = $derived(searchText.trim() !== "");

  // 搜索查询字符串 (派生状态，避免重复计算)
  let searchQuery = $derived(searchText.trim().toLowerCase());

  // 获取过滤后的数据行 (派生状态)
  let filteredDataLines = $derived.by(() => {
    let result = dataLines.map((line, index) => ({
      line,
      originalIndex: index,
    }));

    // 按方向过滤
    if (filterDirection !== "all") {
      result = result.filter((item) => item.line.direction === filterDirection);
    }

    // 按搜索文本过滤
    if (searchQuery) {
      result = result.filter((item) => {
        const line = item.line;

        // 系统消息只搜索文本
        if (line.type === "system") {
          return line.text.toLowerCase().includes(searchQuery);
        }

        if (!line.data) return false;

        if (searchMode === "hex") {
          // HEX搜索模式：搜索十六进制字符串
          const hexStr = Array.from(line.data)
            .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
            .join(" ");
          return hexStr
            .toLowerCase()
            .includes(searchQuery.replace(/\s+/g, " "));
        } else {
          // 文本搜索模式：搜索解码后的文本
          const text = formatText(line.data);
          return text.toLowerCase().includes(searchQuery);
        }
      });
    }

    return result;
  });

  // 检查字节是否在搜索匹配范围内（用于HEX高亮）
  function isByteInSearchMatch(data: Uint8Array, byteIdx: number): boolean {
    if (!hasSearchText || searchMode !== "hex") return false;

    const query = searchQuery.replace(/\s+/g, "");
    if (!query) return false;

    const hexStr = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const lowerHex = hexStr.toLowerCase();
    let pos = 0;
    while ((pos = lowerHex.indexOf(query, pos)) !== -1) {
      const startByte = Math.floor(pos / 2);
      const endByte = Math.ceil((pos + query.length) / 2) - 1;
      if (byteIdx >= startByte && byteIdx <= endByte) {
        return true;
      }
      pos++;
    }
    return false;
  }

  // 检查字符项是否在搜索匹配范围内（用于文本高亮）
  function isCharInSearchMatch(data: Uint8Array, item: CharItem): boolean {
    if (!hasSearchText || searchMode !== "text") return false;
    if (!searchQuery) return false;

    const text = formatText(data);
    const lowerText = text.toLowerCase();
    const chars = parseDataToChars(data);

    // 找到所有匹配位置
    let pos = 0;
    while ((pos = lowerText.indexOf(searchQuery, pos)) !== -1) {
      const endPos = pos + searchQuery.length - 1;
      // 检查item是否在这个匹配范围内
      // 需要找到对应的字符索引
      let charStartIdx = -1;
      let charEndIdx = -1;
      let currentCharPos = 0;
      for (let i = 0; i < chars.length; i++) {
        const charLen = chars[i].char.length;
        if (
          currentCharPos <= pos &&
          pos < currentCharPos + charLen &&
          charStartIdx === -1
        ) {
          charStartIdx = i;
        }
        if (currentCharPos <= endPos && endPos < currentCharPos + charLen) {
          charEndIdx = i;
          break;
        }
        currentCharPos += charLen;
      }

      // 找到item在chars中的索引
      const itemIdx = chars.findIndex(
        (c) => c.startIdx === item.startIdx && c.endIdx === item.endIdx,
      );
      if (itemIdx >= charStartIdx && itemIdx <= charEndIdx) {
        return true;
      }
      pos++;
    }
    return false;
  }

  // 高亮系统消息文本
  function highlightSystemText(text: string): string {
    if (!hasSearchText) return escapeHtml(text);

    const query = searchText.trim();
    if (!query) return escapeHtml(text);

    const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
    return escapeHtml(text).replace(
      regex,
      '<mark class="search-highlight">$1</mark>',
    );
  }

  // 高亮数据文本（用于纯文本模式）
  function highlightDataText(data: Uint8Array): string {
    const text = formatText(data);
    if (!hasSearchText || searchMode !== "text") return escapeHtml(text);

    const query = searchText.trim();
    if (!query) return escapeHtml(text);

    const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
    return escapeHtml(text).replace(
      regex,
      '<mark class="search-highlight">$1</mark>',
    );
  }

  // 转义HTML特殊字符
  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // 转义正则表达式特殊字符
  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // 清除搜索
  function clearSearch() {
    searchText = "";
    filterDirection = "all";
  }

  // 清空接收区
  function clearReceive() {
    // 清空所有待处理的批处理数据
    pendingLines = [];
    rafScheduled = false;
    if (maxLatencyTimer) {
      clearTimeout(maxLatencyTimer);
      maxLatencyTimer = null;
    }
    dataLines = [];
    rxBytes = 0;
    txBytes = 0;
    // 清除选中状态
    selStartLine = null;
    selStartByte = null;
    selEndLine = null;
    selEndByte = null;
  }

  // 启动定时发送
  function startTimer() {
    if (timerRef) return;
    if (timerInterval < 10) timerInterval = 10; // 最小10ms
    timerRef = setInterval(() => {
      if (sendData.trim()) {
        sendMessage();
      }
    }, timerInterval);
  }

  // 停止定时发送
  function stopTimer() {
    if (timerRef) {
      clearInterval(timerRef);
      timerRef = null;
    }
  }

  // 切换定时发送状态
  function toggleTimer() {
    timerEnabled = !timerEnabled;
    if (timerEnabled) {
      startTimer();
    } else {
      stopTimer();
    }
  }

  // 保存数据
  async function saveData() {
    try {
      const filePath = await save({
        filters: [
          { name: "Text", extensions: ["txt"] },
          { name: "Log", extensions: ["log"] },
        ],
      });
      if (filePath) {
        const content = dataLines
          .map((line) => {
            const prefix =
              line.type === "rx"
                ? "[接收]"
                : line.type === "tx"
                  ? "[发送]"
                  : "[系统]";
            const ts = line.timestamp ? `[${line.timestamp}] ` : "";
            if (line.data) {
              const ascii = dataToString(line.data, "ASCII");
              const hex = dataToString(line.data, "HEX");
              return `${ts}${prefix} ASCII: ${ascii} | HEX: ${hex}`;
            }
            return `${ts}${prefix} ${line.text}`;
          })
          .join("\n");
        await writeTextFile(filePath, content);
        appendSystemMessage(`数据已保存到: ${filePath}`);
      }
    } catch (error) {
      console.error("保存失败:", error);
      appendSystemMessage(`保存失败: ${error}`);
    }
  }

  // 最大保留行数
  const MAX_DATA_LINES = 5000;

  // 接收数据批处理：使用 requestAnimationFrame 限制 UI 更新频率（对标串口插件的 200ms 累积）
  // 同时设置最大延迟保障，避免数据长时间不显示
  let pendingLines: DataLine[] = [];
  let rafScheduled = false;
  let maxLatencyTimer: ReturnType<typeof setTimeout> | null = null;
  const MAX_BATCH_LATENCY = 100; // 最大批处理延迟（毫秒）

  function scheduleFlush() {
    if (rafScheduled) return;
    rafScheduled = true;

    // 配合浏览器渲染周期刷新（通常 16ms，即 60fps）
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (maxLatencyTimer) {
        clearTimeout(maxLatencyTimer);
        maxLatencyTimer = null;
      }
      flushPendingLines();
    });

    // 保障最大延迟：即使 rAF 被阻塞，也在 MAX_BATCH_LATENCY 内刷新
    if (!maxLatencyTimer) {
      maxLatencyTimer = setTimeout(() => {
        maxLatencyTimer = null;
        if (rafScheduled) {
          rafScheduled = false;
          flushPendingLines();
        }
      }, MAX_BATCH_LATENCY);
    }
  }

  function flushPendingLines() {
    if (pendingLines.length === 0) return;

    const lines = pendingLines;
    pendingLines = [];

    if (dataLines.length + lines.length > MAX_DATA_LINES) {
      dataLines = [
        ...dataLines.slice(-Math.floor(MAX_DATA_LINES / 2)),
        ...lines,
      ];
    } else {
      dataLines = [...dataLines, ...lines];
    }
    scheduleScrollToBottom();
  }

  // 用于发送操作或断开时立即刷新（保持 TX 的即时性和系统消息的时序正确）
  function flushPendingLinesSync() {
    if (pendingLines.length > 0) {
      const lines = pendingLines;
      pendingLines = [];
      rafScheduled = false;
      if (maxLatencyTimer) {
        clearTimeout(maxLatencyTimer);
        maxLatencyTimer = null;
      }

      if (dataLines.length + lines.length > MAX_DATA_LINES) {
        dataLines = [
          ...dataLines.slice(-Math.floor(MAX_DATA_LINES / 2)),
          ...lines,
        ];
      } else {
        dataLines = [...dataLines, ...lines];
      }
    }
  }

  // 滚动到底部（去重）
  let scrollScheduled = false;
  function scheduleScrollToBottom() {
    if (!autoScroll || scrollScheduled) return;
    scrollScheduled = true;
    queueMicrotask(() => {
      scrollScheduled = false;
      const container = document.getElementById("receive-container");
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  // 添加数据行（带自动清理和批处理）
  function formatTimestamp(): string {
    const now = new Date();
    return `${now.toLocaleTimeString()}.${now.getMilliseconds().toString().padStart(3, "0")}`;
  }

  function appendDataLine(type: "rx" | "tx", data: Uint8Array) {
    const line: DataLine = {
      type,
      direction: type,
      data,
      text: "",
      timestamp: showTimestamp ? formatTimestamp() : undefined,
    };
    if (type === "rx") {
      // 接收数据：加入批处理队列，延迟更新
      pendingLines.push(line);
      scheduleFlush();
    } else {
      // 发送数据：立即更新（用户主动操作需要即时反馈）
      flushPendingLinesSync();
      // 超过最大行数时保留后半部分
      if (dataLines.length >= MAX_DATA_LINES) {
        dataLines = [...dataLines.slice(-Math.floor(MAX_DATA_LINES / 2)), line];
      } else {
        dataLines = [...dataLines, line];
      }
      scheduleScrollToBottom();
    }
  }

  // 添加系统消息
  function appendSystemMessage(text: string) {
    // 系统消息之前先刷新 pending 的接收数据，保持时序正确
    flushPendingLinesSync();

    const line: DataLine = {
      type: "system",
      direction: "system",
      data: null,
      text,
      timestamp: showTimestamp ? formatTimestamp() : undefined,
    };
    // 超过最大行数时保留后半部分
    if (dataLines.length >= MAX_DATA_LINES) {
      dataLines = [...dataLines.slice(-Math.floor(MAX_DATA_LINES / 2)), line];
    } else {
      dataLines = [...dataLines, line];
    }
    scheduleScrollToBottom();
  }

  // 使用 iconv-lite 编码文本
  function encodeText(text: string): Uint8Array {
    try {
      if (textEncoding === "ascii" || textEncoding === "utf-8") {
        return new TextEncoder().encode(text);
      }
      const buffer = iconv.encode(text, textEncoding);
      return new Uint8Array(buffer);
    } catch (e) {
      // 编码失败时回退到 UTF-8
      return new TextEncoder().encode(text);
    }
  }

  // 使用 iconv-lite 解码文本
  function formatText(data: Uint8Array): string {
    try {
      // ascii 模式：不可打印字符显示为点
      if (textEncoding === "ascii") {
        return Array.from(data)
          .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
          .join("");
      }
      // UTF-8 使用原生 TextDecoder
      if (textEncoding === "utf-8") {
        const decoder = new TextDecoder("utf-8", { fatal: false });
        return decoder.decode(data);
      }
      // 其他编码使用 iconv-lite
      const buffer = Buffer.from(data);
      return iconv.decode(buffer, textEncoding);
    } catch (e) {
      // 解码失败时回退到 ASCII 点表示
      return Array.from(data)
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
        .join("");
    }
  }

  // 解析字节数据为字符项数组，每个字符项包含显示字符和对应的字节索引范围
  interface CharItem {
    char: string;
    startIdx: number;
    endIdx: number; // inclusive
  }

  function parseDataToChars(data: Uint8Array): CharItem[] {
    const result: CharItem[] = [];

    if (textEncoding === "ascii") {
      // ASCII 模式：每个字节对应一个字符
      for (let i = 0; i < data.length; i++) {
        const b = data[i];
        result.push({
          char: b >= 32 && b <= 126 ? String.fromCharCode(b) : ".",
          startIdx: i,
          endIdx: i,
        });
      }
      return result;
    }

    if (textEncoding === "utf-8") {
      // UTF-8 解码
      let i = 0;
      while (i < data.length) {
        const b = data[i];
        let charLen = 1;
        if ((b & 0x80) === 0) {
          charLen = 1;
        } else if ((b & 0xe0) === 0xc0) {
          charLen = 2;
        } else if ((b & 0xf0) === 0xe0) {
          charLen = 3;
        } else if ((b & 0xf8) === 0xf0) {
          charLen = 4;
        }

        const endIdx = Math.min(i + charLen - 1, data.length - 1);
        const slice = data.slice(i, endIdx + 1);

        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const char = decoder.decode(slice);
          result.push({ char, startIdx: i, endIdx });
        } catch {
          // 解码失败，显示为点
          result.push({ char: ".", startIdx: i, endIdx: i });
          i++;
          continue;
        }
        i = endIdx + 1;
      }
      return result;
    }

    // GB2312/GBK/Big5 等双字节编码
    try {
      const buffer = Buffer.from(data);
      const decoded = iconv.decode(buffer, textEncoding);

      // 尝试建立字符到字节的映射
      let byteIdx = 0;
      for (const char of decoded) {
        // 重新编码该字符以确定其字节长度
        const charBytes = iconv.encode(char, textEncoding);
        const charLen = charBytes.length;
        const endIdx = Math.min(byteIdx + charLen - 1, data.length - 1);

        if (byteIdx < data.length) {
          result.push({ char, startIdx: byteIdx, endIdx });
        }
        byteIdx += charLen;
      }

      // 如果还有剩余字节（可能是不完整的多字节序列）
      while (byteIdx < data.length) {
        result.push({ char: ".", startIdx: byteIdx, endIdx: byteIdx });
        byteIdx++;
      }
    } catch {
      // 解码失败，逐字节显示为点
      for (let i = 0; i < data.length; i++) {
        const b = data[i];
        result.push({
          char: b >= 32 && b <= 126 ? String.fromCharCode(b) : ".",
          startIdx: i,
          endIdx: i,
        });
      }
    }

    return result;
  }

  // 规范化的选中范围（派生状态，确保 start <= end）
  let normalizedSelection = $derived.by(() => {
    if (
      selStartLine === null ||
      selStartByte === null ||
      selEndLine === null ||
      selEndByte === null
    ) {
      return null;
    }

    let startLine = selStartLine;
    let startByte = selStartByte;
    let endLine = selEndLine;
    let endByte = selEndByte;

    // 如果结束行在起始行之前，或者同一行但结束字节在起始字节之前，则交换
    if (endLine < startLine || (endLine === startLine && endByte < startByte)) {
      [startLine, endLine] = [endLine, startLine];
      [startByte, endByte] = [endByte, startByte];
    }

    return { startLine, startByte, endLine, endByte };
  });

  // 检查字符项是否被选中（支持跨行）
  function isCharSelected(lineIdx: number, item: CharItem): boolean {
    if (!normalizedSelection) return false;

    const { startLine, startByte, endLine, endByte } = normalizedSelection;

    // 完全在选中范围之外
    if (lineIdx < startLine || lineIdx > endLine) return false;

    // 在中间行，整行都选中
    if (lineIdx > startLine && lineIdx < endLine) return true;

    // 在起始行
    if (lineIdx === startLine && lineIdx === endLine) {
      // 同一行：检查字节范围
      return item.endIdx >= startByte && item.startIdx <= endByte;
    } else if (lineIdx === startLine) {
      // 起始行：从 startByte 到行尾
      return item.endIdx >= startByte;
    } else if (lineIdx === endLine) {
      // 结束行：从行首到 endByte
      return item.startIdx <= endByte;
    }

    return false;
  }

  // 检查字节是否被选中（支持跨行）
  function isByteSelected(lineIdx: number, byteIdx: number): boolean {
    if (!normalizedSelection) return false;

    const { startLine, startByte, endLine, endByte } = normalizedSelection;

    // 完全在选中范围之外
    if (lineIdx < startLine || lineIdx > endLine) return false;

    // 在中间行，整行都选中
    if (lineIdx > startLine && lineIdx < endLine) return true;

    // 在起始行
    if (lineIdx === startLine && lineIdx === endLine) {
      // 同一行：检查字节范围
      return byteIdx >= startByte && byteIdx <= endByte;
    } else if (lineIdx === startLine) {
      // 起始行：从 startByte 到行尾
      return byteIdx >= startByte;
    } else if (lineIdx === endLine) {
      // 结束行：从行首到 endByte
      return byteIdx <= endByte;
    }

    return false;
  }

  // 格式化 HEX 显示
  function formatHex(data: Uint8Array): string {
    return Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join(" ");
  }

  function getNativeSelectionText(): string {
    return window.getSelection?.()?.toString().trim() ?? "";
  }

  function hasCustomSelection(): boolean {
    return normalizedSelection !== null;
  }

  function hasNativeSelection(): boolean {
    return getNativeSelectionText().length > 0;
  }

  /** 获取过滤后的数据行（派生状态的函数形式，用于模板中） */
  function getFilteredDataLines(): Array<{
    line: DataLine;
    originalIndex: number;
  }> {
    return filteredDataLines;
  }

  // 清除选中
  function clearSelection() {
    selStartLine = null;
    selStartByte = null;
    selEndLine = null;
    selEndByte = null;
    window.getSelection?.()?.removeAllRanges();
  }

  function selectAllReceiveContent() {
    if (showHexArea) {
      const visibleDataLines = getFilteredDataLines().filter(
        (item) => item.line.data && item.line.data.length > 0,
      );

      if (visibleDataLines.length === 0) {
        return;
      }

      const firstLine = visibleDataLines[0];
      const lastLine = visibleDataLines[visibleDataLines.length - 1];

      selStartLine = firstLine.originalIndex;
      selStartByte = 0;
      selEndLine = lastLine.originalIndex;
      selEndByte = lastLine.line.data!.length - 1;
      receiveContainer?.focus();
      return;
    }

    if (!receiveContainer) {
      return;
    }

    const selection = window.getSelection?.();
    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(receiveContainer);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 获取选中的所有字节数据
  function getSelectedBytes(): Uint8Array {
    if (!normalizedSelection) return new Uint8Array(0);

    const { startLine, startByte, endLine, endByte } = normalizedSelection;
    const chunks: Uint8Array[] = [];

    for (let i = startLine; i <= endLine; i++) {
      const line = dataLines[i];
      if (!line || !line.data) continue;

      let start = 0;
      let end = line.data.length - 1;

      if (i === startLine) {
        start = startByte;
      }
      if (i === endLine) {
        end = endByte;
      }

      if (start <= end && start < line.data.length) {
        chunks.push(line.data.slice(start, end + 1));
      }
    }

    // 合并所有 chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  // 复制选中的数据
  async function copySelectedData() {
    const nativeSelection = getNativeSelectionText();
    if (nativeSelection) {
      try {
        await navigator.clipboard.writeText(nativeSelection);
        appendSystemMessage(`已复制文本 (${nativeSelection.length} 字符)`);
      } catch (error) {
        console.error("复制失败:", error);
        appendSystemMessage(`复制失败: ${error}`);
      }
      return;
    }

    const selectedBytes = getSelectedBytes();
    if (selectedBytes.length === 0) {
      return;
    }

    // 使用当前编码解码文本
    let textStr: string;
    try {
      if (textEncoding === "ascii") {
        textStr = Array.from(selectedBytes)
          .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
          .join("");
      } else if (textEncoding === "utf-8") {
        const decoder = new TextDecoder("utf-8", { fatal: false });
        textStr = decoder.decode(selectedBytes);
      } else {
        const buffer = Buffer.from(selectedBytes);
        textStr = iconv.decode(buffer, textEncoding);
      }
    } catch {
      textStr = Array.from(selectedBytes)
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
        .join("");
    }

    // 复制编码后的文本到剪贴板
    try {
      await navigator.clipboard.writeText(textStr);
      appendSystemMessage(`已复制文本 (${selectedBytes.length} 字节)`);
    } catch (error) {
      console.error("复制失败:", error);
      appendSystemMessage(`复制失败: ${error}`);
    }
  }

  // 复制选中的HEX数据
  async function copySelectedHex() {
    const selectedBytes = getSelectedBytes();
    if (selectedBytes.length === 0) {
      return;
    }

    // 格式化为 HEX
    const hexStr = Array.from(selectedBytes)
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join(" ");

    try {
      await navigator.clipboard.writeText(hexStr);
      appendSystemMessage(`已复制HEX (${selectedBytes.length} 字节)`);
    } catch (error) {
      console.error("复制失败:", error);
      appendSystemMessage(`复制失败: ${error}`);
    }
  }

  function openReceiveContextMenu(
    event: MouseEvent,
    type: "text" | "hex",
    selection?: {
      line: number;
      startByte: number;
      endByte: number;
    },
  ) {
    event.preventDefault();

    if (selection) {
      selStartLine = selection.line;
      selStartByte = selection.startByte;
      selEndLine = selection.line;
      selEndByte = selection.endByte;
    }

    contextMenuType = type;
    contextMenuX = event.clientX;
    contextMenuY = event.clientY;
    contextMenuVisible = true;
  }

  // 关闭右键菜单
  function closeContextMenu() {
    contextMenuVisible = false;
  }

  // 右键菜单复制操作
  function handleContextMenuCopy() {
    copySelectedData();
    closeContextMenu();
  }

  function handleContextMenuCopyHex() {
    copySelectedHex();
    closeContextMenu();
  }

  function handleContextMenuSelectAll() {
    selectAllReceiveContent();
    closeContextMenu();
  }

  function handleContextMenuClearSelection() {
    clearSelection();
    closeContextMenu();
  }

  // 处理键盘事件
  function handleKeydown(event: KeyboardEvent) {
    // Ctrl+C 复制
    if ((event.ctrlKey || event.metaKey) && event.key === "c") {
      if (hasCustomSelection() || hasNativeSelection()) {
        event.preventDefault();
        copySelectedData();
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "a") {
      event.preventDefault();
      selectAllReceiveContent();
    }
    // Escape 取消选中
    if (event.key === "Escape") {
      clearSelection();
    }
  }

  // 设置持久化
  const SETTINGS_KEY = `serialmate_settings_${currentWindowLabel}`;

  function loadSettings() {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const settings: AppSettings = JSON.parse(saved);
        connectionType = settings.connectionType ?? "serial";
        selectedPort = settings.selectedPort ?? "";
        baudRate = settings.baudRate ?? "115200";
        dataBits = settings.dataBits ?? "8";
        stopBits = settings.stopBits ?? "1";
        parity = settings.parity ?? "None";
        rtsEnabled = settings.rtsEnabled ?? false;
        dtrEnabled = settings.dtrEnabled ?? false;
        ipAddress = settings.ipAddress ?? "127.0.0.1";
        port = settings.port ?? "8080";
        localPort = settings.localPort ?? "";
        tcpServerPort = settings.tcpServerPort ?? "8080";
        tcpServerBindIp = settings.tcpServerBindIp ?? "0.0.0.0";
        autoScroll = settings.autoScroll ?? true;
        showTimestamp = settings.showTimestamp ?? false;
        hexSend = settings.hexSend ?? false;
        showHexArea = settings.showHexArea ?? true;
        lineEnding = settings.lineEnding ?? "none";
        textEncoding = settings.textEncoding ?? "gb2312";
        timerInterval = settings.timerInterval ?? 1000;
        commandHistory = settings.commandHistory ?? [];
        tcpHistory = settings.tcpHistory ?? [];
        tcpServerHistory = settings.tcpServerHistory ?? [];
        udpHistory = settings.udpHistory ?? [];
      }
    } catch (e) {
      console.error("加载设置失败:", e);
    }
  }

  function saveSettings() {
    try {
      const settings: AppSettings = {
        connectionType,
        selectedPort,
        baudRate,
        dataBits,
        stopBits,
        parity,
        rtsEnabled,
        dtrEnabled,
        ipAddress,
        port,
        localPort,
        tcpServerPort,
        tcpServerBindIp,
        autoScroll,
        showTimestamp,
        hexSend,
        showHexArea,
        lineEnding,
        textEncoding,
        timerInterval,
        commandHistory,
        tcpHistory,
        tcpServerHistory,
        udpHistory,
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.error("保存设置失败:", e);
    }
  }

  // 初始化：加载设置并刷新串口
  let initialized = false;
  let settingsLoaded = false; // 标记设置是否已加载完成
  let unlistenUsb: UnlistenFn | null = null;

  $effect(() => {
    // 同步加载设置（不会触发依赖追踪问题，因为在 effect 内部）
    loadSettings();
    settingsLoaded = true;

    // 异步操作放到 microtask 中，避免阻塞渲染
    queueMicrotask(() => {
      refreshPorts();
      refreshLocalIps();
    });

    // 监听 USB 设备变化事件
    listen("usb-device-changed", () => {
      console.log("USB 设备变化，刷新串口列表");
      refreshPorts();
    }).then((unlisten) => {
      unlistenUsb = unlisten;
    });

    // 延迟设置初始化标志，避免首次加载触发断开
    setTimeout(() => {
      initialized = true;
    }, 100);

    // 清理函数
    return () => {
      if (unlistenUsb) {
        unlistenUsb();
      }
      releaseWindowSerialPortLocks(currentWindowLabel).catch(() => {});
    };
  });

  // 全局空格键快捷发送：输入框失去焦点时按空格键直接发送数据
  $effect(() => {
    function handleGlobalKeydown(e: KeyboardEvent) {
      // 只处理空格键
      if (e.code !== "Space") return;

      // 如果焦点在输入元素上，不处理
      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      // 如果有数据可发送，则发送
      if (sendData.trim()) {
        e.preventDefault();
        sendMessage();
      }
    }

    window.addEventListener("keydown", handleGlobalKeydown);

    return () => {
      window.removeEventListener("keydown", handleGlobalKeydown);
    };
  });

  // 监听连接方式变化，如果有 transceiver 实例（已连接或正在连接）则断开
  let prevConnectionType: "serial" | "tcp" | "tcpserver" | "udp" = "serial";
  $effect(() => {
    const currentType = connectionType;
    // 只有当值真正发生变化时才处理
    if (initialized && currentType !== prevConnectionType) {
      // 如果 transceiver 存在（已连接或正在连接中），先清理回调再断开
      if (transceiver) {
        transceiver.offAllCallbacks();
        disconnect();
      }
    }
    prevConnectionType = currentType;
  });

  // 监听所有设置变化并保存（使用防抖避免频繁写入）
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // 读取所有设置变量以触发依赖追踪
    const _ = [
      connectionType,
      selectedPort,
      baudRate,
      dataBits,
      stopBits,
      parity,
      rtsEnabled,
      dtrEnabled,
      ipAddress,
      port,
      localPort,
      tcpServerPort,
      tcpServerBindIp,
      autoScroll,
      showTimestamp,
      hexSend,
      showHexArea,
      lineEnding,
      textEncoding,
      timerInterval,
      commandHistory,
      tcpHistory,
      tcpServerHistory,
      udpHistory,
    ];

    // 只有在设置加载完成后才保存，避免初始化时的循环触发
    if (!settingsLoaded) return;

    // 使用防抖，避免频繁保存
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveSettings();
    }, 100);
  });

  // 🎮 彩蛋：Konami Code (↑↑↓↓←→←→BA)
  const konamiCode = [
    "ArrowUp",
    "ArrowUp",
    "ArrowDown",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowLeft",
    "ArrowRight",
    "KeyB",
    "KeyA",
  ];
  let konamiIndex = 0;
  let easterEggActive = $state(false);

  function handleKonamiCode(event: KeyboardEvent) {
    if (event.code === konamiCode[konamiIndex]) {
      konamiIndex++;
      if (konamiIndex === konamiCode.length) {
        triggerEasterEgg();
        konamiIndex = 0;
      }
    } else {
      konamiIndex = event.code === konamiCode[0] ? 1 : 0;
    }
  }

  function triggerEasterEgg() {
    if (easterEggActive) return;
    easterEggActive = true;
    appendSystemMessage("🎉 恭喜你发现了彩蛋！Konami Code 激活！🎮");

    // 3秒后关闭彩蛋效果
    setTimeout(() => {
      easterEggActive = false;
    }, 3000);
  }

  // 监听键盘事件
  $effect(() => {
    window.addEventListener("keydown", handleKonamiCode);
    return () => {
      window.removeEventListener("keydown", handleKonamiCode);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<main
  class="app-container"
  class:easter-egg={easterEggActive}
  oncontextmenu={(e) => e.preventDefault()}
>
  <header class="header">
    <div class="header-title">
      <h1 class:rainbow-text={easterEggActive}>SerialMate</h1>
      <span class="subtitle"
        >{easterEggActive
          ? "🎮 Konami Code Activated! 🎮"
          : "串口调试助手"}</span
      >
    </div>
    <div class="header-actions">
      <button class="header-btn" onclick={openNewWindow}>新建窗口</button>
      <div class="header-stats">
      <span>RX: {rxBytes}</span>
      <span>TX: {txBytes}</span>
      </div>
    </div>
  </header>

  <div class="main-content">
    <!-- 上部接收区 -->
    <div class="top-panel">
      <!-- 接收区 -->
      <div class="receive-area">
        <div class="receive-header">
          <div class="receive-header-left">
            <span class="receive-label">{textEncoding.toUpperCase()}</span>
            {#if showHexArea}
              <span class="receive-label hex-label">
                HEX
                <button
                  class="toggle-hex-btn"
                  onclick={() => toggleHexArea(false)}
                  title="隐藏HEX区">✕</button
                >
              </span>
            {:else}
              <button
                class="show-hex-btn"
                onclick={() => toggleHexArea(true)}
                title="显示HEX区">显示HEX</button
              >
            {/if}
          </div>

          <!-- 搜索和过滤 -->
          <div class="search-filter-group">
            <select
              class="filter-direction"
              bind:value={filterDirection}
              title="过滤方向"
            >
              <option value="all">全部</option>
              <option value="rx">← 接收</option>
              <option value="tx">→ 发送</option>
            </select>
            <div class="search-box">
              <input
                type="text"
                class="search-input"
                bind:value={searchText}
                placeholder={searchMode === "hex"
                  ? "搜索HEX..."
                  : "搜索文本..."}
              />
              <select
                class="search-mode"
                bind:value={searchMode}
                title="搜索模式"
              >
                <option value="text">文本</option>
                <option value="hex">HEX</option>
              </select>
              {#if hasFilter}
                <button
                  class="clear-search-btn"
                  onclick={clearSearch}
                  title="清除搜索">✕</button
                >
              {/if}
            </div>
            {#if hasFilter}
              <span class="filter-count"
                >{filteredDataLines.length}/{dataLines.length}</span
              >
            {/if}
          </div>
        </div>
        {#if showHexArea}
          <!-- HEX 模式：显示字节级交互 -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            id="receive-container"
            bind:this={receiveContainer}
            class="receive-container"
            onkeydown={handleKeydown}
            onmousedown={(e) => {
              // 只有点击空白区域（不是 byte 元素）时才清除选择
              const target = e.target as HTMLElement;
              if (
                !target.classList.contains("byte-char") &&
                !target.classList.contains("byte-hex")
              ) {
                clearSelection();
              }
            }}
            oncontextmenu={(e) => openReceiveContextMenu(e, "text")}
            tabindex="0"
            role="textbox"
            aria-label="接收数据区域"
            aria-readonly="true"
          >
            {#each filteredDataLines as { line, originalIndex }}
              <div class="data-row {line.direction}">
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="ascii-col">
                  {#if showTimestamp && line.timestamp}
                    <span class="timestamp">{line.timestamp}</span>
                  {/if}
                  <span class="direction"
                    >{line.direction === "rx"
                      ? "←"
                      : line.direction === "tx"
                        ? "→"
                        : "●"}</span
                  >
                  {#if line.data}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span class="data-content"
                      >{#each parseDataToChars(line.data) as item}<span
                          class="byte-char"
                          class:selected={isCharSelected(originalIndex, item)}
                          class:search-highlight={isCharInSearchMatch(
                            line.data,
                            item,
                          )}
                          onmousedown={(e) => {
                            if (e.button === 0) {
                              selStartLine = originalIndex;
                              selStartByte = item.startIdx;
                              selEndLine = originalIndex;
                              selEndByte = item.endIdx;
                            }
                          }}
                          onmouseenter={(e) => {
                            if (e.buttons === 1 && selStartLine !== null) {
                              selEndLine = originalIndex;
                              selEndByte = item.endIdx;
                            }
                          }}
                          oncontextmenu={(e) => {
                            openReceiveContextMenu(e, "text", {
                              line: originalIndex,
                              startByte: item.startIdx,
                              endByte: item.endIdx,
                            });
                          }}>{item.char}</span
                        >{/each}</span
                    >
                  {:else}
                    <span
                      class="system-text"
                      oncontextmenu={(e) => openReceiveContextMenu(e, "text")}
                      >{@html highlightSystemText(line.text)}</span
                    >
                  {/if}
                </div>
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="hex-col">
                  {#if line.data}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span class="data-content"
                      >{#each line.data as byte, byteIdx}<span
                          class="byte-hex"
                          class:selected={isByteSelected(
                            originalIndex,
                            byteIdx,
                          )}
                          class:search-highlight={isByteInSearchMatch(
                            line.data,
                            byteIdx,
                          )}
                          onmousedown={(e) => {
                            if (e.button === 0) {
                              selStartLine = originalIndex;
                              selStartByte = byteIdx;
                              selEndLine = originalIndex;
                              selEndByte = byteIdx;
                            }
                          }}
                          onmouseenter={(e) => {
                            if (e.buttons === 1 && selStartLine !== null) {
                              selEndLine = originalIndex;
                              selEndByte = byteIdx;
                            }
                          }}
                          oncontextmenu={(e) => {
                            openReceiveContextMenu(e, "hex", {
                              line: originalIndex,
                              startByte: byteIdx,
                              endByte: byteIdx,
                            });
                          }}
                          >{byte
                            .toString(16)
                            .padStart(2, "0")
                            .toUpperCase()}</span
                        >{" "}{/each}</span
                    >
                  {/if}
                </div>
              </div>
            {/each}
            {#if filteredDataLines.length === 0}
              <div class="placeholder">
                {hasFilter ? "没有匹配的数据" : "接收的数据将显示在这里..."}
              </div>
            {/if}
          </div>
        {:else}
          <!-- 纯文本模式：使用 div 显示以支持高亮 -->
          <div
            id="receive-container"
            bind:this={receiveContainer}
            class="receive-container text-mode"
            onkeydown={handleKeydown}
            oncontextmenu={(e) => openReceiveContextMenu(e, "text")}
            tabindex="0"
            role="textbox"
            aria-label="接收数据区域"
            aria-readonly="true"
          >
            {#each getFilteredDataLines() as { line }}
              <div class="text-line {line.direction}">
                {#if showTimestamp && line.timestamp}
                  <span class="timestamp">[{line.timestamp}]</span>
                {/if}
                <span class="direction"
                  >{line.direction === "rx"
                    ? "←"
                    : line.direction === "tx"
                      ? "→"
                      : "●"}</span
                >
                {#if line.data}
                  <span class="text-content"
                    >{@html highlightDataText(line.data)}</span
                  >
                {:else}
                  <span
                    class="system-text"
                    oncontextmenu={(e) => openReceiveContextMenu(e, "text")}
                    >{@html highlightSystemText(line.text)}</span
                  >
                {/if}
              </div>
            {/each}
            {#if filteredDataLines.length === 0}
              <div class="placeholder">
                {hasFilter ? "没有匹配的数据" : "接收的数据将显示在这里..."}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- 下部面板 -->
    <div class="bottom-panel">
      <!-- 左下配置面板 -->
      <aside class="config-panel">
        <div class="config-content">
          <!-- 连接类型选择 -->
          <div class="config-section">
            <div class="conn-type-grid">
              <button
                class={connectionType === "serial" ? "active" : ""}
                onclick={() => (connectionType = "serial")}
                disabled={isConnecting}>串口</button
              >
              <button
                class={connectionType === "tcp" ? "active" : ""}
                onclick={() => (connectionType = "tcp")}
                disabled={isConnecting}>TCP</button
              >
              <button
                class={connectionType === "tcpserver" ? "active" : ""}
                onclick={() => (connectionType = "tcpserver")}
                disabled={isConnecting}>TCP Server</button
              >
              <button
                class={connectionType === "udp" ? "active" : ""}
                onclick={() => (connectionType = "udp")}
                disabled={isConnecting}>UDP</button
              >
            </div>
          </div>

          <!-- 串口配置 -->
          {#if connectionType === "serial"}
            <div class="config-section compact">
              <div class="form-row">
                <label for="serial-port" title="串口">串口</label>
                <div class="input-with-button">
                  <select
                    id="serial-port"
                    bind:value={selectedPort}
                    title={selectedPort}
                  >
                    {#each serialPorts as p}
                      <option value={p.path} title={p.path}>{p.label}</option>
                    {/each}
                  </select>
                  <button class="icon-btn" onclick={refreshPorts} title="刷新"
                    >🔄</button
                  >
                </div>
              </div>
              <div class="form-row">
                <label for="baud-rate" title="波特率">波特率</label>
                <select id="baud-rate" bind:value={baudRate} title={baudRate}>
                  <option value="9600">9600</option>
                  <option value="19200">19200</option>
                  <option value="38400">38400</option>
                  <option value="57600">57600</option>
                  <option value="115200">115200</option>
                </select>
              </div>
              <div class="form-row-inline">
                <div class="form-col">
                  <label for="data-bits" title="数据位">数据位</label>
                  <select id="data-bits" bind:value={dataBits} title={dataBits}>
                    <option value="7">7</option>
                    <option value="8">8</option>
                  </select>
                </div>
                <div class="form-col">
                  <label for="stop-bits" title="停止位">停止位</label>
                  <select id="stop-bits" bind:value={stopBits} title={stopBits}>
                    <option value="1">1</option>
                    <option value="2">2</option>
                  </select>
                </div>
                <div class="form-col">
                  <label for="parity" title="校验">校验</label>
                  <select id="parity" bind:value={parity} title={parity}>
                    <option value="None">N</option>
                    <option value="Odd">O</option>
                    <option value="Even">E</option>
                  </select>
                </div>
              </div>

              <!-- 串口控制信号 -->
              <div class="signal-control">
                <div class="signal-row">
                  <button
                    class="signal-btn {rtsEnabled ? 'active' : ''}"
                    onclick={toggleRTS}
                    disabled={!isConnected}
                    title="Request To Send">RTS</button
                  >
                  <button
                    class="signal-btn {dtrEnabled ? 'active' : ''}"
                    onclick={toggleDTR}
                    disabled={!isConnected}
                    title="Data Terminal Ready">DTR</button
                  >
                  <span
                    class="signal-indicator {ctsState ? 'on' : ''}"
                    title="Clear To Send">CTS</span
                  >
                  <span
                    class="signal-indicator {dsrState ? 'on' : ''}"
                    title="Data Set Ready">DSR</span
                  >
                  <span
                    class="signal-indicator {dcdState ? 'on' : ''}"
                    title="Data Carrier Detect">DCD</span
                  >
                </div>
              </div>
            </div>
          {:else if connectionType === "tcp"}
            <div class="config-section compact">
              <div class="form-row">
                <label for="tcp-remote-ip" title="远程IP">远程IP</label>
                <input
                  id="tcp-remote-ip"
                  type="text"
                  bind:value={ipAddress}
                  placeholder="127.0.0.1"
                  title={ipAddress}
                />
              </div>
              <div class="form-row">
                <label for="tcp-remote-port" title="远程端口">远程端口</label>
                <input
                  id="tcp-remote-port"
                  type="text"
                  bind:value={port}
                  placeholder="8080"
                  title={port}
                />
              </div>
              <div class="form-row">
                <label for="tcp-local-port" title="本地端口">本地端口</label>
                <input
                  id="tcp-local-port"
                  type="text"
                  bind:value={localPort}
                  placeholder="自动"
                  title={localPort || "自动"}
                />
              </div>
              {#if tcpHistory.length > 0}
                <div class="history-select">
                  <select
                    onchange={(e) => {
                      const idx = parseInt(
                        (e.target as HTMLSelectElement).value,
                      );
                      if (!isNaN(idx) && tcpHistory[idx]) {
                        applyTcpHistory(tcpHistory[idx]);
                      }
                      (e.target as HTMLSelectElement).value = "";
                    }}
                  >
                    <option value="">历史记录...</option>
                    {#each tcpHistory as config, idx}
                      <option value={idx}
                        >{config.remoteHost}:{config.remotePort}{config.localPort
                          ? ` (本地:${config.localPort})`
                          : ""}</option
                      >
                    {/each}
                  </select>
                </div>
              {/if}
            </div>
          {:else if connectionType === "tcpserver"}
            <div class="config-section compact">
              <div class="form-row">
                <label for="tcpserver-listen-port" title="监听端口"
                  >监听端口</label
                >
                <input
                  id="tcpserver-listen-port"
                  type="text"
                  bind:value={tcpServerPort}
                  placeholder="8080"
                  title={tcpServerPort}
                />
              </div>
              <div class="form-row">
                <label for="tcpserver-bind-ip" title="绑定IP">绑定IP</label>
                <select
                  id="tcpserver-bind-ip"
                  bind:value={tcpServerBindIp}
                  title={tcpServerBindIp}
                >
                  {#each localIpAddresses as ip}
                    <option value={ip} title={ip}>{ip}</option>
                  {/each}
                </select>
              </div>
              {#if tcpServerHistory.length > 0}
                <div class="history-select">
                  <select
                    onchange={(e) => {
                      const idx = parseInt(
                        (e.target as HTMLSelectElement).value,
                      );
                      if (!isNaN(idx) && tcpServerHistory[idx]) {
                        applyTcpServerHistory(tcpServerHistory[idx]);
                      }
                      (e.target as HTMLSelectElement).value = "";
                    }}
                  >
                    <option value="">历史记录...</option>
                    {#each tcpServerHistory as config, idx}
                      <option value={idx}
                        >{config.bindIp}:{config.listenPort}</option
                      >
                    {/each}
                  </select>
                </div>
              {/if}
            </div>
          {:else if connectionType === "udp"}
            <div class="config-section compact">
              <div class="form-row">
                <label for="udp-remote-ip" title="远程IP">远程IP</label>
                <input
                  id="udp-remote-ip"
                  type="text"
                  bind:value={ipAddress}
                  placeholder="127.0.0.1"
                  title={ipAddress}
                />
              </div>
              <div class="form-row">
                <label for="udp-remote-port" title="远程端口">远程端口</label>
                <input
                  id="udp-remote-port"
                  type="text"
                  bind:value={port}
                  placeholder="8080"
                  title={port}
                />
              </div>
              <div class="form-row">
                <label for="udp-local-port" title="本地端口">本地端口</label>
                <input
                  id="udp-local-port"
                  type="text"
                  bind:value={localPort}
                  placeholder="自动"
                  title={localPort || "自动"}
                />
              </div>
              {#if udpHistory.length > 0}
                <div class="history-select">
                  <select
                    onchange={(e) => {
                      const idx = parseInt(
                        (e.target as HTMLSelectElement).value,
                      );
                      if (!isNaN(idx) && udpHistory[idx]) {
                        applyUdpHistory(udpHistory[idx]);
                      }
                      (e.target as HTMLSelectElement).value = "";
                    }}
                  >
                    <option value="">历史记录...</option>
                    {#each udpHistory as config, idx}
                      <option value={idx}
                        >{config.remoteHost}:{config.remotePort}{config.localPort
                          ? ` (本地:${config.localPort})`
                          : ""}</option
                      >
                    {/each}
                  </select>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- 连接按钮 -->
        <button
          class="connect-btn {isConnected ? 'connected' : ''} {isConnecting
            ? 'connecting'
            : ''}"
          onclick={toggleConnection}
        >
          {#if isConnecting}
            取消连接
          {:else if connectionType === "tcpserver"}
            {isConnected ? "停止" : "监听"}
          {:else}
            {isConnected ? "断开" : "连接"}
          {/if}
        </button>
      </aside>

      <!-- 右下发送面板 -->
      <div class="send-panel">
        <!-- 工具栏 -->
        <div class="toolbar">
          <div class="toolbar-left">
            <label class="toolbar-checkbox">
              <input type="checkbox" bind:checked={autoScroll} />自动滚动
            </label>
            <label class="toolbar-checkbox">
              <input type="checkbox" bind:checked={showTimestamp} />时间戳
            </label>
            <label class="toolbar-checkbox">
              <input type="checkbox" bind:checked={hexSend} />HEX发送
            </label>
            <label class="toolbar-checkbox">
              <span>换行:</span>
              <select class="line-ending-select" bind:value={lineEnding}>
                <option value="none">无</option>
                <option value="crlf">\r\n</option>
                <option value="cr">\r</option>
                <option value="lf">\n</option>
              </select>
            </label>
          </div>
          <div class="toolbar-center">
            <span class="toolbar-label">编码:</span>
            <select class="encoding-select" bind:value={textEncoding}>
              <option value="gb2312">GB2312</option>
              <option value="gbk">GBK</option>
              <option value="utf-8">UTF-8</option>
              <option value="big5">Big5</option>
              <option value="ascii">ASCII</option>
            </select>
          </div>
          <div class="toolbar-right">
            <button class="toolbar-btn" onclick={clearReceive} title="清空"
              >🗑️ 清空</button
            >
            <button class="toolbar-btn" onclick={saveData} title="保存"
              >💾 保存</button
            >
          </div>
        </div>

        <!-- 发送区 -->
        <div class="send-area">
          <div class="send-input-group">
            <textarea
              bind:value={sendData}
              placeholder={hexSend ? "HEX: 01 02 03 FF" : "输入发送数据..."}
              oncontextmenu={(e) => e.stopPropagation()}
            ></textarea>

            <!-- 历史指令下拉框 -->
            {#if commandHistory.length > 0}
              <div class="command-history">
                <label for="history-select">历史指令:</label>
                <select
                  id="history-select"
                  onchange={(e) => {
                    const select = e.target as HTMLSelectElement;
                    const value = select.value;
                    if (value) {
                      selectFromHistory(value);
                      // 重置选择，允许重复选择同一条指令
                      select.value = "";
                    }
                  }}
                >
                  <option value="">选择历史指令...</option>
                  {#each commandHistory as cmd}
                    <option value={cmd}>
                      {cmd.length > 50 ? cmd.substring(0, 50) + "..." : cmd}
                    </option>
                  {/each}
                </select>
              </div>
            {/if}

            <div class="send-buttons">
              <button
                class="send-btn"
                onclick={sendMessage}
                disabled={!sendData.trim()}>发送</button
              >
              <div class="timer-group">
                <button
                  class="timer-btn {timerEnabled ? 'active' : ''}"
                  onclick={toggleTimer}
                  disabled={!sendData.trim()}
                  title="定时发送"
                >
                  {timerEnabled ? "停止" : "定时"}
                </button>
                <input
                  type="number"
                  class="timer-input"
                  bind:value={timerInterval}
                  min="10"
                  step="100"
                  disabled={timerEnabled}
                  title="定时间隔(毫秒)"
                />
                <span class="timer-unit">ms</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</main>

<!-- 右键菜单 -->
{#if contextMenuVisible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="context-menu-overlay"
    onclick={closeContextMenu}
    onkeydown={(e) => {
      if (e.key === "Escape") closeContextMenu();
    }}
    role="button"
    tabindex="-1"
    style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 999;"
  ></div>
  <div
    class="context-menu"
    style="position: fixed; left: {contextMenuX}px; top: {contextMenuY}px; z-index: 1000; background: white; border: 1px solid #d1d9e0; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); padding: 0.25rem 0; min-width: 120px;"
  >
    <button
      class="context-menu-item"
      onclick={handleContextMenuCopy}
      disabled={!hasCustomSelection() && !hasNativeSelection()}
      style="display: block; width: 100%; padding: 0.5rem 1rem; text-align: left; background: none; border: none; cursor: pointer; font-size: 0.85rem; color: #374151;"
    >
      📋 复制文本
    </button>
    {#if contextMenuType === "hex"}
      <button
        class="context-menu-item"
        onclick={handleContextMenuCopyHex}
        disabled={!hasCustomSelection()}
        style="display: block; width: 100%; padding: 0.5rem 1rem; text-align: left; background: none; border: none; cursor: pointer; font-size: 0.85rem; color: #374151;"
      >
        📋 复制 HEX
      </button>
    {/if}
    <button
      class="context-menu-item"
      onclick={handleContextMenuSelectAll}
      style="display: block; width: 100%; padding: 0.5rem 1rem; text-align: left; background: none; border: none; cursor: pointer; font-size: 0.85rem; color: #374151;"
    >
      选择全部
    </button>
    <button
      class="context-menu-item"
      onclick={handleContextMenuClearSelection}
      disabled={!hasCustomSelection() && !hasNativeSelection()}
      style="display: block; width: 100%; padding: 0.5rem 1rem; text-align: left; background: none; border: none; cursor: pointer; font-size: 0.85rem; color: #374151;"
    >
      取消选择
    </button>
  </div>
{/if}
