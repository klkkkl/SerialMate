// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use local_ip_address::list_afinet_netifas;
use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(windows)]
mod usb_monitor {
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};
    use windows::core::*;
    use windows::Win32::Foundation::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

    const DBT_DEVNODES_CHANGED: u32 = 0x0007;

    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

    pub fn start_usb_monitor(app: AppHandle) {
        let _ = APP_HANDLE.set(app);

        std::thread::spawn(|| {
            unsafe {
                let instance = GetModuleHandleW(None).unwrap_or_default();

                let wc = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(window_proc),
                    hInstance: instance.into(),
                    lpszClassName: w!("SerialMateUSBMonitor"),
                    ..Default::default()
                };

                let atom = RegisterClassExW(&wc);
                if atom == 0 {
                    eprintln!("Failed to register window class");
                    return;
                }

                // 创建一个普通的隐藏窗口以接收广播消息
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("SerialMateUSBMonitor"),
                    w!("USB Monitor"),
                    WINDOW_STYLE::default(),
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    instance,
                    None,
                );

                match hwnd {
                    Ok(h) => {
                        println!("USB monitor window created: {:?}", h);
                    }
                    Err(e) => {
                        eprintln!("Failed to create USB monitor window: {:?}", e);
                        return;
                    }
                }

                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_DEVICECHANGE {
            let event_type = wparam.0 as u32;
            // DBT_DEVNODES_CHANGED 是设备树变化的通用通知
            if event_type == DBT_DEVNODES_CHANGED {
                println!("USB device changed detected");
                if let Some(app) = APP_HANDLE.get() {
                    let _ = app.emit("usb-device-changed", ());
                }
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[tauri::command]
fn get_local_ips() -> Vec<String> {
    let mut ips = vec!["0.0.0.0".to_string(), "127.0.0.1".to_string()];

    // 虚拟机/容器网卡名称关键字（小写匹配）
    let virtual_keywords = [
        "vmware",
        "vmnet",
        "vbox",
        "virtualbox",
        "docker",
        "veth",
        "br-",
        "virbr",
        "hyper-v",
        "vethernet",
        "wsl",
        "podman",
        "container",
        "lima",
        "multipass",
        "parallels",
        "qemu",
    ];

    if let Ok(network_interfaces) = list_afinet_netifas() {
        for (name, ip) in network_interfaces {
            // 检查是否是虚拟网卡
            let name_lower = name.to_lowercase();
            let is_virtual = virtual_keywords.iter().any(|kw| name_lower.contains(kw));

            if is_virtual {
                continue;
            }

            if let std::net::IpAddr::V4(ipv4) = ip {
                let ip_str = ipv4.to_string();
                if !ips.contains(&ip_str) {
                    ips.push(ip_str);
                }
            }
        }
    }

    ips
}

#[derive(Default)]
struct SerialPortLocks {
    ports: Mutex<HashMap<String, String>>,
}

#[tauri::command]
fn acquire_serial_port_lock(
    state: tauri::State<'_, SerialPortLocks>,
    window_label: String,
    port_path: String,
) -> Result<(), String> {
    if window_label.trim().is_empty() {
        return Err("窗口标识不能为空".to_string());
    }

    if port_path.trim().is_empty() {
        return Err("串口不能为空".to_string());
    }

    let mut ports = state
        .ports
        .lock()
        .map_err(|_| "串口锁状态不可用".to_string())?;

    match ports.get(&port_path) {
        Some(owner) if owner != &window_label => {
            Err(format!("串口 {port_path} 已被窗口 {owner} 打开"))
        }
        _ => {
            ports.insert(port_path, window_label);
            Ok(())
        }
    }
}

#[tauri::command]
fn release_serial_port_lock(
    state: tauri::State<'_, SerialPortLocks>,
    window_label: String,
    port_path: String,
) -> Result<(), String> {
    if window_label.trim().is_empty() || port_path.trim().is_empty() {
        return Ok(());
    }

    let mut ports = state
        .ports
        .lock()
        .map_err(|_| "串口锁状态不可用".to_string())?;

    if ports
        .get(&port_path)
        .is_some_and(|owner| owner == &window_label)
    {
        ports.remove(&port_path);
    }

    Ok(())
}

#[tauri::command]
fn release_window_serial_port_locks(
    state: tauri::State<'_, SerialPortLocks>,
    window_label: String,
) -> Result<(), String> {
    if window_label.trim().is_empty() {
        return Ok(());
    }

    let mut ports = state
        .ports
        .lock()
        .map_err(|_| "串口锁状态不可用".to_string())?;

    ports.retain(|_, owner| owner != &window_label);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_serialplugin::init())
        .plugin(tauri_plugin_tcp::init())
        .plugin(tauri_plugin_udp::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SerialPortLocks::default())
        .invoke_handler(tauri::generate_handler![
            get_local_ips,
            acquire_serial_port_lock,
            release_serial_port_lock,
            release_window_serial_port_locks
        ])
        .setup(|_app| {
            #[cfg(windows)]
            usb_monitor::start_usb_monitor(_app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
