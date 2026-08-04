use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Charset {
    Digits,
    Letters,
    Alphanumeric,
    /// 字母+数字（不含连字符生成；与 alphanumeric 相同，预留扩展）
    AlphanumericHyphen,
}

impl Default for Charset {
    fn default() -> Self {
        Self::Alphanumeric
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanConfig {
    /// 标签主体长度（不含 prefix/suffix），3–8
    pub length: u8,
    #[serde(default)]
    pub charset: Charset,
    /// 并发请求数
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    /// 每个请求前额外延迟（毫秒），用于降速
    #[serde(default)]
    pub delay_ms: u64,
    /// 前缀（固定附加在组合前）
    pub prefix: Option<String>,
    /// 后缀
    pub suffix: Option<String>,
    /// 只保存 available=true 的结果
    #[serde(default = "default_true")]
    pub only_store_available: bool,
    /// 从第几个组合开始（0-based），便于断点续扫
    #[serde(default)]
    pub start_index: u64,
    /// 扫到第几个（不含），None 表示全部
    pub end_index: Option<u64>,
}

fn default_concurrency() -> u32 {
    10
}

fn default_true() -> bool {
    true
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            length: 3,
            charset: Charset::Alphanumeric,
            concurrency: 10,
            delay_ms: 0,
            prefix: None,
            suffix: None,
            only_store_available: true,
            start_index: 0,
            end_index: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanStatus {
    Idle,
    Running,
    Stopped,
    Completed,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanPhase {
    Idle,
    Scanning,
    Stopped,
    Completed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub phase: ScanPhase,
    pub checked: u64,
    pub total: u64,
    pub available: u64,
    pub taken: u64,
    pub errors: u64,
    pub current: String,
    pub rate_per_sec: f64,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub elapsed_secs: f64,
    pub eta_secs: Option<f64>,
}

impl Default for ScanProgress {
    fn default() -> Self {
        Self {
            phase: ScanPhase::Idle,
            checked: 0,
            total: 0,
            available: 0,
            taken: 0,
            errors: 0,
            current: String::new(),
            rate_per_sec: 0.0,
            started_at: None,
            elapsed_secs: 0.0,
            eta_secs: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagResult {
    pub tag: String,
    pub available: bool,
    pub normalized: String,
    pub code: Option<String>,
    pub checked_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScanEvent {
    Started {
        total: u64,
        config: ScanConfig,
    },
    Progress {
        checked: u64,
        total: u64,
        available: u64,
        taken: u64,
        errors: u64,
        rate_per_sec: f64,
        elapsed_secs: f64,
        eta_secs: Option<f64>,
    },
    Found {
        result: TagResult,
    },
    Checked {
        tag: String,
        available: bool,
        code: Option<String>,
    },
    Error {
        message: String,
    },
    Finished {
        status: ScanStatus,
        checked: u64,
        available: u64,
        taken: u64,
        errors: u64,
        elapsed_secs: f64,
    },
}

pub struct InnerState {
    pub status: ScanStatus,
    pub config: Option<ScanConfig>,
    pub progress: ScanProgress,
    pub results: Vec<TagResult>,
    pub cancel: Option<Arc<AtomicBool>>,
    pub task: Option<JoinHandle<()>>,
}

impl Default for InnerState {
    fn default() -> Self {
        Self {
            status: ScanStatus::Idle,
            config: None,
            progress: ScanProgress::default(),
            results: Vec::new(),
            cancel: None,
            task: None,
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<RwLock<InnerState>>,
    pub events: broadcast::Sender<ScanEvent>,
}

impl AppState {
    pub fn new() -> Self {
        // 高并发 found 事件较多，加大缓冲减少接收端 Lagged
        let (tx, _) = broadcast::channel(16384);
        Self {
            inner: Arc::new(RwLock::new(InnerState::default())),
            events: tx,
        }
    }
}
