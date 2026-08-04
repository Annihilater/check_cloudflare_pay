use crate::scanner::{self, total_combinations};
use crate::state::{
    AppState, ScanConfig, ScanPhase, ScanProgress, ScanStatus, TagResult,
};
use axum::{
    extract::{Query, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json,
    },
    http::StatusCode,
};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt as _;

#[derive(Serialize)]
pub struct ApiError {
    pub error: String,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub status: ScanStatus,
    pub config: Option<ScanConfig>,
    pub progress: ScanProgress,
    pub results_count: usize,
    pub estimated_total: Option<u64>,
}

#[derive(Serialize)]
pub struct StartResponse {
    pub ok: bool,
    pub estimated_total: u64,
    pub message: String,
}

#[derive(Deserialize)]
pub struct CheckQuery {
    pub tag: String,
}

fn validate_config(cfg: &ScanConfig) -> Result<(), String> {
    if !(3..=8).contains(&cfg.length) {
        return Err("length 必须在 3–8 之间（站点最少 3 字符）".into());
    }
    if cfg.concurrency == 0 || cfg.concurrency > 50 {
        return Err("concurrency 必须在 1–50 之间（过高会导致页面卡顿）".into());
    }
    if cfg.delay_ms > 60_000 {
        return Err("delay_ms 过大".into());
    }
    if let Some(p) = &cfg.prefix {
        if p.len() > 16 {
            return Err("prefix 过长".into());
        }
    }
    if let Some(s) = &cfg.suffix {
        if s.len() > 16 {
            return Err("suffix 过长".into());
        }
    }
    let total = total_combinations(cfg.length, cfg.charset);
    if cfg.start_index >= total {
        return Err(format!("start_index 超出范围（total={total}）"));
    }
    if let Some(end) = cfg.end_index {
        if end <= cfg.start_index {
            return Err("end_index 必须大于 start_index".into());
        }
    }
    Ok(())
}

pub async fn start_scan(
    State(state): State<AppState>,
    Json(cfg): Json<ScanConfig>,
) -> impl IntoResponse {
    if let Err(e) = validate_config(&cfg) {
        return (
            StatusCode::BAD_REQUEST,
            Json(StartResponse {
                ok: false,
                estimated_total: 0,
                message: e,
            }),
        );
    }

    let estimated = {
        let total = total_combinations(cfg.length, cfg.charset);
        let end = cfg.end_index.unwrap_or(total).min(total);
        end.saturating_sub(cfg.start_index)
    };

    {
        let mut inner = state.inner.write();
        if inner.status == ScanStatus::Running {
            return (
                StatusCode::CONFLICT,
                Json(StartResponse {
                    ok: false,
                    estimated_total: estimated,
                    message: "扫描正在进行中，请先停止".into(),
                }),
            );
        }

        // 取消旧任务句柄
        if let Some(handle) = inner.task.take() {
            handle.abort();
        }

        let cancel = Arc::new(AtomicBool::new(false));
        inner.cancel = Some(cancel.clone());
        inner.config = Some(cfg.clone());
        inner.status = ScanStatus::Running;
        inner.progress = ScanProgress {
            phase: ScanPhase::Scanning,
            total: estimated,
            ..Default::default()
        };
        // 新扫描默认清空结果；前端可先导出
        inner.results.clear();

        let st = state.clone();
        let handle = tokio::spawn(async move {
            scanner::run_scan(st, cancel).await;
        });
        inner.task = Some(handle);
    }

    (
        StatusCode::OK,
        Json(StartResponse {
            ok: true,
            estimated_total: estimated,
            message: format!("已启动扫描，预计检查 {estimated} 个标签"),
        }),
    )
}

pub async fn stop_scan(State(state): State<AppState>) -> impl IntoResponse {
    let inner = state.inner.write();
    if inner.status != ScanStatus::Running {
        return Json(serde_json::json!({
            "ok": false,
            "message": "当前没有运行中的扫描"
        }));
    }
    if let Some(c) = &inner.cancel {
        c.store(true, Ordering::Relaxed);
    }
    Json(serde_json::json!({
        "ok": true,
        "message": "已发送停止信号，等待当前请求结束…"
    }))
}

pub async fn scan_status(State(state): State<AppState>) -> Json<StatusResponse> {
    let inner = state.inner.read();
    let estimated = inner
        .config
        .as_ref()
        .map(|c| total_combinations(c.length, c.charset));
    Json(StatusResponse {
        status: inner.status,
        config: inner.config.clone(),
        progress: inner.progress.clone(),
        results_count: inner.results.len(),
        estimated_total: estimated,
    })
}

pub async fn scan_results(State(state): State<AppState>) -> Json<Vec<TagResult>> {
    let inner = state.inner.read();
    Json(inner.results.clone())
}

pub async fn clear_results(State(state): State<AppState>) -> impl IntoResponse {
    let mut inner = state.inner.write();
    if inner.status == ScanStatus::Running {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "ok": false,
                "message": "扫描进行中，无法清空结果"
            })),
        );
    }
    inner.results.clear();
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "message": "已清空" })),
    )
}

pub async fn check_one(
    Query(q): Query<CheckQuery>,
) -> Result<Json<TagResult>, (StatusCode, Json<ApiError>)> {
    let tag = q.tag.trim();
    if tag.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "tag 不能为空".into(),
            }),
        ));
    }
    match scanner::check_one(tag).await {
        Ok(r) => Ok(Json(r)),
        Err(e) => Err((
            StatusCode::BAD_GATEWAY,
            Json(ApiError {
                error: e.to_string(),
            }),
        )),
    }
}

pub async fn scan_events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|item| {
        let event = match item {
            Ok(e) => e,
            Err(_) => return None, // lag
        };
        let data = serde_json::to_string(&event).ok()?;
        Some(Ok(Event::default().event("scan").data(data)))
    });

    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
