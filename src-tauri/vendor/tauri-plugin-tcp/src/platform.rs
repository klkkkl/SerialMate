use socket2::{Domain, Socket, Type};
use std::collections::HashMap;
use std::net::ToSocketAddrs;
use std::sync::Arc;

use debug_print::debug_println;
use lazy_static::lazy_static;
use tauri::{Emitter, Manager, Runtime};
use tokio::{
    io::{self, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, RwLock},
    time::{sleep, Duration, Instant},
};

use crate::models::*;

lazy_static! {
    static ref SOCKETS: RwLock<HashMap<String, Tcp>> = RwLock::new(HashMap::new());
}

/// 数据缓冲周期（毫秒），对标串口插件 desktop_api.rs 中的 200ms 累积窗口
const BUFFER_INTERVAL_MS: u64 = 200;
/// 累积缓冲区的最大字节数，超过此值立即刷新（防止高速数据流中 select! 偏向读分支导致缓冲区无限增长）
const MAX_BUFFER_SIZE: usize = 65536;

/// 每个 TCP 连接读取协程的通用实现：累积数据后定时/按事件刷新到前端
async fn run_read_loop<R: Runtime>(
    window: tauri::Window<R>,
    tcp_id: String,
    addr: String,
    mut read_half: tokio::net::tcp::OwnedReadHalf,
) {
    let mut buf = [0; 65535];
    let mut combined_buffer: Vec<u8> = Vec::with_capacity(4096);
    let mut last_emit = Instant::now();

    loop {
        tokio::select! {
            result = read_half.read(&mut buf) => {
                match result {
                    Ok(len) if len > 0 => {
                        combined_buffer.extend_from_slice(&buf[..len]);
                        debug_println!("{:?} bytes received from {:?}", len, addr);
                    }
                    _ => {
                        // 连接关闭或读取错误：先刷新剩余数据，再通知断开
                        if !combined_buffer.is_empty() {
                            let data = std::mem::take(&mut combined_buffer);
                            let _ = window.app_handle().emit_to(
                                window.label(),
                                "plugin://tcp",
                                Payload {
                                    id: tcp_id.clone(),
                                    event: PayloadEvent::Message {
                                        addr: addr.to_string(),
                                        data,
                                    },
                                },
                            );
                        }
                        let _ = window.app_handle().emit_to(
                            window.label(),
                            "plugin://tcp",
                            Payload {
                                id: tcp_id.clone(),
                                event: PayloadEvent::Disconnect(addr.to_string()),
                            },
                        );
                        SOCKETS.write().await.remove(&tcp_id);
                        break;
                    }
                }
            }
            _ = sleep(Duration::from_millis(BUFFER_INTERVAL_MS)) => {
                // 定时触发器：检查是否需要刷新累积数据
            }
        }

        // 满足以下任一条件时刷新累积数据：
        //   a) 已经过了 BUFFER_INTERVAL_MS 且有数据
        //   b) 累积缓冲区超过 MAX_BUFFER_SIZE（防止高速流中缓冲区无限增长）
        let should_flush = !combined_buffer.is_empty()
            && (last_emit.elapsed() >= Duration::from_millis(BUFFER_INTERVAL_MS)
                || combined_buffer.len() >= MAX_BUFFER_SIZE);

        if should_flush {
            let data = std::mem::take(&mut combined_buffer);
            debug_println!("{:?} buffered bytes flushed to UI from {:?}", data.len(), addr);
            let _ = window.app_handle().emit_to(
                window.label(),
                "plugin://tcp",
                Payload {
                    id: tcp_id.clone(),
                    event: PayloadEvent::Message {
                        addr: addr.to_string(),
                        data,
                    },
                },
            );
            last_emit = Instant::now();
        }
    }
}

pub async fn connect<R: Runtime>(
    window: tauri::Window<R>,
    id: String,
    endpoint: String,
) -> io::Result<()> {
    let mut sockets = SOCKETS.write().await;

    if let Some(s) = sockets.get(&id) {
        s.task.abort();
        sockets.remove(&id);
        sleep(Duration::from_millis(100)).await;
    }

    let stream = TcpStream::connect(&endpoint).await?;
    let (read_half, write_half) = stream.into_split();
    debug_println!("{} tcp connected to {}", &id, &endpoint);
    let _ = window.app_handle().emit_to(
        window.label(),
        "plugin://tcp",
        Payload {
            id: id.clone(),
            event: PayloadEvent::Connect(endpoint.to_string()),
        },
    );
    let tcp_id = id.clone();
    let addr = endpoint.clone();
    let write_half = Arc::new(Mutex::new(write_half));
    let task = tokio::task::spawn(run_read_loop(window, tcp_id, addr, read_half));

    sockets.insert(
        id,
        Tcp {
            task,
            kind: TcpKind::Client {
                write_half,
                endpoint,
            },
        },
    );
    Ok(())
}

pub async fn connect_with_bind<R: Runtime>(
    window: tauri::Window<R>,
    id: String,
    local_addr: String, // 本地绑定地址（如：192.168.1.100:0）
    endpoint: String,   // 远端连接地址（如：example.com:1234）
) -> io::Result<()> {
    let mut sockets = SOCKETS.write().await;

    if let Some(s) = sockets.get(&id) {
        s.task.abort();
        sockets.remove(&id);
        sleep(Duration::from_millis(100)).await;
    }

    let local_addr = local_addr
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid local_addr"))?;
    let remote_addr = endpoint
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid endpoint"))?;

    // 使用 socket2 手动创建 socket 并绑定本地地址
    let socket = Socket::new(Domain::for_address(remote_addr), Type::STREAM, None)?;
    socket.bind(&local_addr.into())?;

    // Windows 兼容性处理：connect 时用阻塞模式，之后再转非阻塞交给 tokio
    socket.set_nonblocking(false)?;
    socket.connect(&remote_addr.into())?;
    socket.set_nonblocking(true)?;

    let stream = TcpStream::from_std(socket.into())?;
    let (read_half, write_half) = stream.into_split();

    debug_println!(
        "{} tcp connected to {} from {}",
        &id,
        &endpoint,
        &local_addr
    );

    let _ = window.app_handle().emit_to(
        window.label(),
        "plugin://tcp",
        Payload {
            id: id.clone(),
            event: PayloadEvent::Connect(endpoint.to_string()),
        },
    );

    let tcp_id = id.clone();
    let addr = endpoint.clone();
    let write_half = Arc::new(Mutex::new(write_half));
    let task = tokio::task::spawn(run_read_loop(window, tcp_id, addr, read_half));

    sockets.insert(
        id,
        Tcp {
            task,
            kind: TcpKind::Client {
                write_half,
                endpoint,
            },
        },
    );
    Ok(())
}

pub async fn disconnect(id: String) -> io::Result<()> {
    let mut sockets = SOCKETS.write().await;

    if let Some(s) = sockets.get(&id) {
        s.task.abort();
        sockets.remove(&id);
        debug_println!("{} tcp disconnected", &id);
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("ID {} not disconnected.", &id),
        ))
    }
}

pub async fn bind<R: Runtime>(
    window: tauri::Window<R>,
    id: String,
    endpoint: String,
) -> io::Result<()> {
    let mut sockets = SOCKETS.write().await;

    if let Some(s) = sockets.get(&id) {
        s.task.abort();
        sockets.remove(&id);
        sleep(Duration::from_millis(100)).await;
    }

    let listener = TcpListener::bind(&endpoint).await?;
    let _ = window.app_handle().emit_to(
        window.label(),
        "plugin://tcp",
        Payload {
            id: id.clone(),
            event: PayloadEvent::Bind(endpoint.to_string()),
        },
    );
    debug_println!("{} tcp server listening on {}", &id, &endpoint);
    let socks: Arc<RwLock<HashMap<String, Mutex<(tokio::net::tcp::OwnedWriteHalf, tokio::task::JoinHandle<()>)>>>> =
        Arc::new(RwLock::new(HashMap::new()));

    let tcp_id = id.clone();
    let socks_clone = socks.clone();
    let task = tokio::spawn(async move {
        loop {
            if let Ok((stream, addr)) = listener.accept().await {
                let (read_half, write_half) = stream.into_split();
                debug_println!("{} tcp client connected from {}", tcp_id, &addr);

                let window = window.clone();
                let id = tcp_id.clone();
                let addr_str = addr.to_string();

                let _ = window.app_handle().emit_to(
                    window.label(),
                    "plugin://tcp",
                    Payload {
                        id: id.clone(),
                        event: PayloadEvent::Connect(addr_str.clone()),
                    },
                );
                let task = tokio::task::spawn(run_read_loop(
                    window,
                    id,
                    addr_str.clone(),
                    read_half,
                ));
                socks_clone
                    .write()
                    .await
                    .insert(addr_str, Mutex::new((write_half, task)));
            }
        }
    });

    sockets.insert(
        id,
        Tcp {
            task,
            kind: TcpKind::Server { socks },
        },
    );
    Ok(())
}

pub async fn unbind<R: Runtime>(window: tauri::Window<R>, id: String) -> io::Result<()> {
    let mut sockets = SOCKETS.write().await;

    if let Some(s) = sockets.get(&id) {
        if let TcpKind::Server { ref socks } = s.kind {
            for (_, wf) in socks.write().await.drain() {
                wf.lock().await.1.abort();
            }
            s.task.abort();
            sockets.remove(&id);
            debug_println!("{} tcp server closed.", &id);
            let _ = window.app_handle().emit_to(
                window.label(),
                "plugin://tcp",
                Payload {
                    id: id.clone(),
                    event: PayloadEvent::Unbind(),
                },
            );
        }
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("ID {} not bond.", &id),
        ))
    }
}

pub async fn send(id: String, message: Vec<u8>, addr: Option<String>) -> io::Result<()> {
    // Phase 1: 在 SOCKETS 读锁下解析发送目标信息，不执行实际 I/O
    enum SendTarget {
        Client(Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>),
        Server(
            Arc<RwLock<HashMap<String, Mutex<(tokio::net::tcp::OwnedWriteHalf, tokio::task::JoinHandle<()>)>>>>,
            String,
        ),
    }

    let target: io::Result<SendTarget> = {
        let sockets = SOCKETS.read().await;
        let s = sockets.get(&id).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("ID {} not connected or not bond.", &id),
            )
        })?;
        match &s.kind {
            TcpKind::Client { write_half, .. } => Ok(SendTarget::Client(write_half.clone())),
            TcpKind::Server { socks } => {
                let a = addr.clone().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("ID {} is a tcp server. The `addr` is required.", &id),
                    )
                })?;
                Ok(SendTarget::Server(socks.clone(), a))
            }
        }
    };
    let target = target?;
    // SOCKETS 读锁在此释放——即使 write_all 阻塞，也不影响 disconnect 获取写锁

    // Phase 2: 在无 SOCKETS 锁的状态下执行实际 I/O
    match target {
        SendTarget::Client(write_half) => {
            write_half.lock().await.write_all(&message).await?;
            debug_println!("{} tcp sent {} bytes", &id, message.len());
        }
        SendTarget::Server(socks, client_addr) => {
            let socks_guard = socks.read().await;
            if let Some(wf) = socks_guard.get(&client_addr) {
                wf.lock().await.0.write_all(&message).await?;
                debug_println!("{} tcp sent {} bytes to {}", &id, message.len(), &client_addr);
            } else {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("ID {} client {} not connected", &id, &client_addr),
                ));
            }
        }
    }
    Ok(())
}
