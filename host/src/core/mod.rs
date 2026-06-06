//! Host core —— 运行时无关的预览会话核心。
//! 见 ../../docs/architecture.md §2 / §5.3。

pub mod command_bridge;
pub mod frame_relay;
pub mod launcher;
pub mod session;

pub use launcher::LaunchConfig;
pub use session::Session;
