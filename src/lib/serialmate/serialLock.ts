import { invoke } from "@tauri-apps/api/core";

interface SerialLockParams {
  windowLabel: string;
  portPath: string;
}

export async function acquireSerialPortLock({
  windowLabel,
  portPath,
}: SerialLockParams): Promise<void> {
  await invoke("acquire_serial_port_lock", {
    windowLabel,
    portPath,
  });
}

export async function releaseSerialPortLock({
  windowLabel,
  portPath,
}: SerialLockParams): Promise<void> {
  await invoke("release_serial_port_lock", {
    windowLabel,
    portPath,
  });
}

export async function releaseWindowSerialPortLocks(
  windowLabel: string,
): Promise<void> {
  await invoke("release_window_serial_port_locks", {
    windowLabel,
  });
}
