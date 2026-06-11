//! Host core —— 运行时无关的预览会话核心。
//! 见 ../../docs/architecture.md §2 / §5.3。

pub mod command_bridge;
pub mod frame_relay;
pub mod launcher;
pub mod session;

pub use launcher::LaunchConfig;
pub use session::Session;

/// 命令通道协议版本（须匹配后端 `CommandLineInterface::COMMAND_VERSION`，
/// 见 cli/CommandLineInterface.cpp:29 与 version 正则 :164-165）。
pub const COMMAND_VERSION: &str = "1.0.1";

/// 构造命令通道请求信封：`{version, command, type, args}`。
pub fn build_command(command: &str, cmd_type: &str, args: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "version": COMMAND_VERSION,
        "command": command,
        "type": cmd_type,
        "args": args,
    })
}
