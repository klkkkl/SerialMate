<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { save } from "@tauri-apps/plugin-dialog";
  import { writeTextFile } from "@tauri-apps/plugin-fs";
  import * as iconv from "iconv-lite";
  import { Buffer } from "buffer";
  import "./+page.css";
  import {
    SerialTransceiver,
    TcpClientTransceiver,
    TcpServerTransceiver,
    UdpTransceiver,
    dataToString,
    hexStringToBytes,
    DataBits,
    StopBits,
    Parity,
    FlowControl,
    type DataTransceiver,
    type SerialConfig,
    type TcpClientConfig,
    type TcpServerConfig,
    type UdpConfig,
  } from "$lib/transceiver";

  // 连接类型：串口、TCP、TCP Server、UDP
  let connectionType = $state<"serial" | "tcp" | "tcpserver" | "udp">("serial");
  let isConnected = $state(false);
  let isConnecting = $state(false); // 正在连接中

  // 当前收发器实例
  let transceiver: DataTransceiver | null = $state(null);

  // 串口配置
  let serialPorts = $state<string[]>([]);
  let selectedPort = $state("");
  let baudRate = $state("115200");
  let dataBits = $state("8");
  let stopBits = $state("1");
  let parity = $state("None");

  // 网络配置
  let ipAddress = $state("127.0.0.1");
  let port = $state("8080");
  let localPort = $state(""); // TCP/UDP 本地端口
  let tcpServerPort = $state("8080"); // TCP Server 监听端口
  let tcpServerBindIp = $state("0.0.0.0"); // TCP Server 绑定IP
  let localIpAddresses = $state<string[]>(["0.0.0.0", "127.0.0.1"]); // 本机可用IP列表

  // 数据显示
  interface DataLine {
    type: "rx" | "tx" | "system";
    direction: "rx" | "tx" | "system"; // 方向标识
    data: Uint8Array | null; // null 表示系统消息
    text: string; // 系统消息或原始文本
    timestamp?: string;
  }
  let dataLines = $state<DataLine[]>([]);
  let sendData = $state("");

  // 统计
  let rxBytes = $state(0);
  let txBytes = $state(0);

  // 设置选项
  let autoScroll = $state(true);
  let showTimestamp = $state(false);
  let hexSend = $state(false);
  let showHexArea = $state(true);
  let lineEnding = $state<"none" | "crlf" | "cr" | "lf">("none");

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

  let textEncoding = $state<"gb2312" | "utf-8" | "gbk" | "big5" | "ascii">(
    "gb2312",
  );

  // 右键菜单状态
  let contextMenuVisible = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);
  let contextMenuType = $state<"text" | "hex">("hex");

  // 刷新串口列表
  async function refreshPorts() {
    try {
      const ports = await SerialTransceiver.getAvailablePorts();
      serialPorts = Object.keys(ports);
      if (serialPorts.length > 0 && !selectedPort) {
        selectedPort = serialPorts[0];
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

  // 连接/断开
  async function toggleConnection() {
    if (isConnected) {
      await disconnect();
    } else {
      await connect();
    }
  }

  async function connect() {
    // 如果正在连接中，忽略
    if (isConnecting) return;

    // 清理旧的 transceiver
    if (transceiver) {
      transceiver.offAllCallbacks();
      await transceiver.disconnect();
      transceiver = null;
    }

    isConnecting = true;
    try {
      if (connectionType === "serial") {
        const config: SerialConfig = {
          port: selectedPort,
          baudRate: parseInt(baudRate),
          dataBits: dataBits === "7" ? DataBits.Seven : DataBits.Eight,
          stopBits: stopBits === "1" ? StopBits.One : StopBits.Two,
          parity:
            parity === "Odd"
              ? Parity.Odd
              : parity === "Even"
                ? Parity.Even
                : Parity.None,
          flowControl: FlowControl.None,
        };
        transceiver = new SerialTransceiver(config);
      } else if (connectionType === "tcp") {
        const config: TcpClientConfig = {
          remoteHost: ipAddress,
          remotePort: parseInt(port),
          localPort: localPort ? parseInt(localPort) : undefined,
        };
        transceiver = new TcpClientTransceiver(config);
      } else if (connectionType === "tcpserver") {
        const config: TcpServerConfig = {
          bindHost: tcpServerBindIp || "0.0.0.0",
          listenPort: parseInt(tcpServerPort),
        };
        transceiver = new TcpServerTransceiver(config);
      } else if (connectionType === "udp") {
        const config: UdpConfig = {
          remoteHost: ipAddress,
          remotePort: parseInt(port),
          localPort: parseInt(localPort) || 0,
        };
        transceiver = new UdpTransceiver(config);
      }

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

        await transceiver.connect();
        isConnected = true;
        appendSystemMessage("连接成功");
      }
    } catch (error) {
      console.error("连接失败:", error);
      appendSystemMessage(`连接失败: ${error}`);
      transceiver = null;
    } finally {
      isConnecting = false;
    }
  }

  async function disconnect() {
    // 如果正在连接中，忽略
    if (isConnecting) return;

    // 停止定时发送
    stopTimer();
    timerEnabled = false;

    try {
      if (transceiver) {
        await transceiver.disconnect();
        transceiver = null;
      }
      isConnected = false;
      appendSystemMessage("已断开连接");
    } catch (error) {
      console.error("断开失败:", error);
      appendSystemMessage(`断开失败: ${error}`);
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
    } catch (error) {
      console.error("发送失败:", error);
      appendSystemMessage(`发送失败: ${error}`);
      // 发送异常后自动断开连接
      await disconnect();
    }
  }

  // 清空接收区
  function clearReceive() {
    dataLines = [];
    rxBytes = 0;
    txBytes = 0;
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

  // 添加数据行
  function appendDataLine(type: "rx" | "tx", data: Uint8Array) {
    const line: DataLine = {
      type,
      direction: type,
      data,
      text: "",
      timestamp: showTimestamp ? new Date().toLocaleTimeString() : undefined,
    };
    dataLines = [...dataLines, line];
    scrollToBottom();
  }

  // 添加系统消息
  function appendSystemMessage(text: string) {
    const line: DataLine = {
      type: "system",
      direction: "system",
      data: null,
      text,
      timestamp: showTimestamp ? new Date().toLocaleTimeString() : undefined,
    };
    dataLines = [...dataLines, line];
    scrollToBottom();
  }

  // 滚动到底部
  function scrollToBottom() {
    if (autoScroll) {
      setTimeout(() => {
        const container = document.getElementById("receive-container");
        if (container) container.scrollTop = container.scrollHeight;
      }, 10);
    }
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

  // 格式化单个字节为字符显示
  function formatByte(byte: number): string {
    try {
      if (textEncoding === "ascii") {
        return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".";
      }
      // 对于多字节编码，单字节显示可能不完整，简化处理
      if (byte >= 32 && byte <= 126) {
        return String.fromCharCode(byte);
      }
      if (byte > 127) {
        // 高位字节显示为点，实际多字节字符需要组合显示
        return ".";
      }
      return ".";
    } catch {
      return ".";
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

  // 获取规范化的选中范围（确保 start <= end）
  function getNormalizedSelection(): {
    startLine: number;
    startByte: number;
    endLine: number;
    endByte: number;
  } | null {
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
  }

  // 检查字符项是否被选中（支持跨行）
  function isCharSelected(lineIdx: number, item: CharItem): boolean {
    const sel = getNormalizedSelection();
    if (!sel) return false;

    const { startLine, startByte, endLine, endByte } = sel;

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
    const sel = getNormalizedSelection();
    if (!sel) return false;

    const { startLine, startByte, endLine, endByte } = sel;

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

  // 清除选中
  function clearSelection() {
    selStartLine = null;
    selStartByte = null;
    selEndLine = null;
    selEndByte = null;
  }

  // 获取选中的所有字节数据
  function getSelectedBytes(): Uint8Array {
    const sel = getNormalizedSelection();
    if (!sel) return new Uint8Array(0);

    const { startLine, startByte, endLine, endByte } = sel;
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

  // HEX区右键菜单
  function handleHexContextMenu(event: MouseEvent) {
    if (selStartLine !== null && selStartByte !== null && selEndByte !== null) {
      event.preventDefault();
      contextMenuType = "hex";
      contextMenuX = event.clientX;
      contextMenuY = event.clientY;
      contextMenuVisible = true;
    }
  }

  // 文本区右键菜单
  function handleTextContextMenu(event: MouseEvent) {
    if (selStartLine !== null && selStartByte !== null && selEndByte !== null) {
      event.preventDefault();
      contextMenuType = "text";
      contextMenuX = event.clientX;
      contextMenuY = event.clientY;
      contextMenuVisible = true;
    }
  }

  // 关闭右键菜单
  function closeContextMenu() {
    contextMenuVisible = false;
  }

  // 右键菜单复制操作
  function handleContextMenuCopy() {
    if (contextMenuType === "hex") {
      copySelectedHex();
    } else {
      copySelectedData();
    }
    closeContextMenu();
  }

  // 处理键盘事件
  function handleKeydown(event: KeyboardEvent) {
    // Ctrl+C 复制
    if ((event.ctrlKey || event.metaKey) && event.key === "c") {
      if (getNormalizedSelection() !== null) {
        event.preventDefault();
        copySelectedData();
      }
    }
    // Escape 取消选中
    if (event.key === "Escape") {
      clearSelection();
    }
  }

  // 设置持久化
  const SETTINGS_KEY = "serialmate_settings";

  interface AppSettings {
    connectionType: "serial" | "tcp" | "tcpserver" | "udp";
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
    autoScroll: boolean;
    showTimestamp: boolean;
    hexSend: boolean;
    showHexArea: boolean;
    lineEnding: "none" | "crlf" | "cr" | "lf";
    textEncoding: "gb2312" | "utf-8" | "gbk" | "big5" | "ascii";
    timerInterval: number;
  }

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
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.error("保存设置失败:", e);
    }
  }

  // 初始化：加载设置并刷新串口
  let initialized = false;
  let unlistenUsb: UnlistenFn | null = null;

  $effect(() => {
    loadSettings();
    refreshPorts();
    refreshLocalIps();

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

  // 监听所有设置变化并保存
  $effect(() => {
    // 读取所有设置变量以触发依赖追踪
    const _ = [
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
      autoScroll,
      showTimestamp,
      hexSend,
      showHexArea,
      lineEnding,
      textEncoding,
      timerInterval,
    ];
    saveSettings();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<main class="app-container" oncontextmenu={(e) => e.preventDefault()}>
  <header class="header">
    <div class="header-title">
      <h1>SerialMate</h1>
      <span class="subtitle">串口调试助手</span>
    </div>
    <div class="header-stats">
      <span>RX: {rxBytes}</span>
      <span>TX: {txBytes}</span>
    </div>
  </header>

  <div class="main-content">
    <!-- 上部接收区 -->
    <div class="top-panel">
      <!-- 接收区 -->
      <div class="receive-area">
        <div class="receive-header">
          <span class="receive-label">{textEncoding.toUpperCase()}</span>
          {#if showHexArea}
            <span class="receive-label hex-label">
              HEX
              <button
                class="toggle-hex-btn"
                onclick={() => (showHexArea = false)}
                title="隐藏HEX区">✕</button
              >
            </span>
          {:else}
            <button
              class="show-hex-btn"
              onclick={() => (showHexArea = true)}
              title="显示HEX区">显示HEX</button
            >
          {/if}
        </div>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          id="receive-container"
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
          tabindex="0"
          role="textbox"
          aria-label="接收数据区域"
          aria-readonly="true"
        >
          {#each dataLines as line, lineIdx}
            <div class="data-row {line.direction}">
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="ascii-col" class:full-width={!showHexArea}>
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
                        class:selected={isCharSelected(lineIdx, item)}
                        onmousedown={(e) => {
                          if (e.button === 0) {
                            selStartLine = lineIdx;
                            selStartByte = item.startIdx;
                            selEndLine = lineIdx;
                            selEndByte = item.endIdx;
                          }
                        }}
                        onmouseenter={(e) => {
                          if (e.buttons === 1 && selStartLine !== null) {
                            selEndLine = lineIdx;
                            selEndByte = item.endIdx;
                          }
                        }}
                        oncontextmenu={(e) => {
                          e.preventDefault();
                          if (selStartLine === null) {
                            selStartLine = lineIdx;
                            selStartByte = item.startIdx;
                            selEndLine = lineIdx;
                            selEndByte = item.endIdx;
                          }
                          contextMenuType = "text";
                          contextMenuX = e.clientX;
                          contextMenuY = e.clientY;
                          contextMenuVisible = true;
                        }}>{item.char}</span
                      >{/each}</span
                  >
                {:else}
                  <span class="system-text">{line.text}</span>
                {/if}
              </div>
              {#if showHexArea}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="hex-col">
                  {#if line.data}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span class="data-content"
                      >{#each Array.from(line.data) as byte, byteIdx}<span
                          class="byte-hex"
                          class:selected={isByteSelected(lineIdx, byteIdx)}
                          onmousedown={(e) => {
                            if (e.button === 0) {
                              selStartLine = lineIdx;
                              selStartByte = byteIdx;
                              selEndLine = lineIdx;
                              selEndByte = byteIdx;
                            }
                          }}
                          onmouseenter={(e) => {
                            if (e.buttons === 1 && selStartLine !== null) {
                              selEndLine = lineIdx;
                              selEndByte = byteIdx;
                            }
                          }}
                          oncontextmenu={(e) => {
                            e.preventDefault();
                            if (selStartLine === null) {
                              selStartLine = lineIdx;
                              selStartByte = byteIdx;
                              selEndLine = lineIdx;
                              selEndByte = byteIdx;
                            }
                            contextMenuType = "hex";
                            contextMenuX = e.clientX;
                            contextMenuY = e.clientY;
                            contextMenuVisible = true;
                          }}
                          >{byte
                            .toString(16)
                            .padStart(2, "0")
                            .toUpperCase()}</span
                        >{" "}{/each}</span
                    >
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
          {#if dataLines.length === 0}
            <div class="placeholder">接收的数据将显示在这里...</div>
          {/if}
        </div>
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
                      <option value={p} title={p}>{p}</option>
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
            </div>
          {/if}
        </div>

        <!-- 连接按钮 -->
        <button
          class="connect-btn {isConnected ? 'connected' : ''}"
          onclick={toggleConnection}
          disabled={isConnecting}
        >
          {#if isConnecting}
            连接中...
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
      style="display: block; width: 100%; padding: 0.5rem 1rem; text-align: left; background: none; border: none; cursor: pointer; font-size: 0.85rem; color: #374151;"
    >
      📋 复制{contextMenuType === "hex" ? " HEX" : ""}
    </button>
  </div>
{/if}
