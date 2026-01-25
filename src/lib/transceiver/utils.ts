// 辅助函数：将数据转换为可显示的字符串
export function dataToString(data: string | Uint8Array, mode: "ASCII" | "HEX"): string {
    if (typeof data === "string") {
        if (mode === "HEX") {
            return Array.from(new TextEncoder().encode(data))
                .map(b => b.toString(16).padStart(2, "0").toUpperCase())
                .join(" ");
        }
        return data;
    } else {
        if (mode === "HEX") {
            return Array.from(data)
                .map(b => b.toString(16).padStart(2, "0").toUpperCase())
                .join(" ");
        }
        return new TextDecoder().decode(data);
    }
}

// 辅助函数：将 HEX 字符串转换为 Uint8Array
export function hexStringToBytes(hex: string): Uint8Array {
    const bytes = hex.replace(/\s/g, "").match(/.{1,2}/g);
    if (!bytes) return new Uint8Array();
    return new Uint8Array(bytes.map(byte => parseInt(byte, 16)));
}

// 辅助函数：将字符串转换为 Uint8Array
export function stringToBytes(str: string): Uint8Array {
    return new TextEncoder().encode(str);
}

// 辅助函数：将 Uint8Array 转换为字符串（用于发送）
export function bytesToString(data: Uint8Array): string {
    return String.fromCharCode(...data);
}
