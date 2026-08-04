use crate::state::{
    AppState, Charset, ScanEvent, ScanPhase, ScanProgress, ScanStatus, TagResult,
};
use futures::stream::{self, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const API_URL: &str = "https://cloudflare.pay/api/check";
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0";

#[derive(Debug, Deserialize)]
struct CheckResponse {
    available: Option<bool>,
    normalized: Option<String>,
    code: Option<String>,
    error: Option<String>,
}

pub fn charset_chars(charset: Charset) -> Vec<char> {
    match charset {
        Charset::Digits => ('0'..='9').collect(),
        Charset::Letters => ('a'..='z').collect(),
        Charset::Alphanumeric => {
            let mut v: Vec<char> = ('a'..='z').collect();
            v.extend('0'..='9');
            v
        }
        Charset::AlphanumericHyphen => {
            // 仅中间可含连字符；生成时用纯字母数字，避免首尾连字符
            let mut v: Vec<char> = ('a'..='z').collect();
            v.extend('0'..='9');
            v
        }
    }
}

pub fn total_combinations(length: u8, charset: Charset) -> u64 {
    let n = charset_chars(charset).len() as u64;
    n.saturating_pow(length as u32)
}

/// 按字典序生成第 `index` 个组合（0-based）。
pub fn combination_at(index: u64, length: u8, chars: &[char]) -> String {
    let base = chars.len() as u64;
    let mut idx = index;
    let mut buf = vec![chars[0]; length as usize];
    for i in (0..length as usize).rev() {
        let rem = (idx % base) as usize;
        buf[i] = chars[rem];
        idx /= base;
    }
    buf.into_iter().collect()
}

pub async fn run_scan(state: AppState, cancel: Arc<AtomicBool>) {
    let config = {
        let s = state.inner.read();
        s.config.clone()
    };

    let Some(config) = config else {
        return;
    };

    let chars = charset_chars(config.charset);
    let total = total_combinations(config.length, config.charset);
    let start_index = config.start_index.min(total);
    let end_index = config
        .end_index
        .unwrap_or(total)
        .min(total)
        .max(start_index);

    let client = match Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .pool_max_idle_per_host(config.concurrency.max(4) as usize)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit(
                &state,
                ScanEvent::Error {
                    message: format!("创建 HTTP 客户端失败: {e}"),
                },
            );
            finish_error(&state, &cancel);
            return;
        }
    };

    {
        let mut s = state.inner.write();
        s.status = ScanStatus::Running;
        s.progress = ScanProgress {
            phase: ScanPhase::Scanning,
            checked: 0,
            total: end_index.saturating_sub(start_index),
            available: 0,
            taken: 0,
            errors: 0,
            current: String::new(),
            rate_per_sec: 0.0,
            started_at: Some(chrono::Utc::now()),
            elapsed_secs: 0.0,
            eta_secs: None,
        };
    }
    emit(
        &state,
        ScanEvent::Started {
            total: end_index.saturating_sub(start_index),
            config: config.clone(),
        },
    );

    let checked = Arc::new(AtomicU64::new(0));
    let available = Arc::new(AtomicU64::new(0));
    let taken = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let range_total = end_index.saturating_sub(start_index).max(1);

    let concurrency = config.concurrency.max(1) as usize;
    let delay = Duration::from_millis(config.delay_ms);
    let prefix = config.prefix.clone().unwrap_or_default();
    let suffix = config.suffix.clone().unwrap_or_default();

    // 进度汇报任务
    let progress_state = state.clone();
    let progress_checked = checked.clone();
    let progress_available = available.clone();
    let progress_taken = taken.clone();
    let progress_errors = errors.clone();
    // 与用户停止信号分离，避免进度任务误把 cancel 置 true
    let progress_done = Arc::new(AtomicBool::new(false));
    let progress_done_flag = progress_done.clone();
    let progress_user_cancel = cancel.clone();
    let progress_handle = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        loop {
            ticker.tick().await;
            if progress_done_flag.load(Ordering::Relaxed)
                || progress_user_cancel.load(Ordering::Relaxed)
            {
                break;
            }
            let c = progress_checked.load(Ordering::Relaxed);
            let a = progress_available.load(Ordering::Relaxed);
            let t = progress_taken.load(Ordering::Relaxed);
            let e = progress_errors.load(Ordering::Relaxed);
            let elapsed = started.elapsed().as_secs_f64();
            let rate = if elapsed > 0.0 {
                c as f64 / elapsed
            } else {
                0.0
            };
            let remaining = range_total.saturating_sub(c);
            let eta = if rate > 0.0 {
                Some(remaining as f64 / rate)
            } else {
                None
            };

            {
                let mut s = progress_state.inner.write();
                s.progress.checked = c;
                s.progress.available = a;
                s.progress.taken = t;
                s.progress.errors = e;
                s.progress.rate_per_sec = rate;
                s.progress.elapsed_secs = elapsed;
                s.progress.eta_secs = eta;
            }
            emit(
                &progress_state,
                ScanEvent::Progress {
                    checked: c,
                    total: range_total,
                    available: a,
                    taken: t,
                    errors: e,
                    rate_per_sec: rate,
                    elapsed_secs: elapsed,
                    eta_secs: eta,
                },
            );

            if c >= range_total {
                break;
            }
        }
    });

    stream::iter(start_index..end_index)
        .map(|index| {
            let client = client.clone();
            let chars = chars.clone();
            let length = config.length;
            let cancel = cancel.clone();
            let checked = checked.clone();
            let available = available.clone();
            let taken = taken.clone();
            let errors = errors.clone();
            let state = state.clone();
            let prefix = prefix.clone();
            let suffix = suffix.clone();
            let only_available = config.only_store_available;

            async move {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }

                let body = combination_at(index, length, &chars);
                let tag = format!("{prefix}{body}{suffix}");

                {
                    let mut s = state.inner.write();
                    s.progress.current = tag.clone();
                }

                if delay > Duration::ZERO {
                    tokio::time::sleep(delay).await;
                }

                match check_tag(&client, &tag).await {
                    Ok(result) => {
                        checked.fetch_add(1, Ordering::Relaxed);
                        if result.available {
                            available.fetch_add(1, Ordering::Relaxed);
                            {
                                let mut s = state.inner.write();
                                s.results.push(result.clone());
                            }
                            emit(&state, ScanEvent::Found { result });
                        } else {
                            taken.fetch_add(1, Ordering::Relaxed);
                            if !only_available {
                                emit(
                                    &state,
                                    ScanEvent::Checked {
                                        tag: result.tag,
                                        available: false,
                                        code: result.code,
                                    },
                                );
                            }
                        }
                    }
                    Err(e) => {
                        checked.fetch_add(1, Ordering::Relaxed);
                        errors.fetch_add(1, Ordering::Relaxed);
                        emit(
                            &state,
                            ScanEvent::Error {
                                message: format!("{tag}: {e}"),
                            },
                        );
                    }
                }
            }
        })
        .buffer_unordered(concurrency)
        .for_each(|_| async {})
        .await;

    progress_done.store(true, Ordering::Relaxed);
    let _ = progress_handle.await;

    let final_checked = checked.load(Ordering::Relaxed);
    let final_available = available.load(Ordering::Relaxed);
    let final_taken = taken.load(Ordering::Relaxed);
    let final_errors = errors.load(Ordering::Relaxed);
    let elapsed = started.elapsed().as_secs_f64();
    let stopped = cancel.load(Ordering::Relaxed);

    {
        let mut s = state.inner.write();
        s.status = if stopped {
            ScanStatus::Stopped
        } else {
            ScanStatus::Completed
        };
        s.progress.phase = if stopped {
            ScanPhase::Stopped
        } else {
            ScanPhase::Completed
        };
        s.progress.checked = final_checked;
        s.progress.available = final_available;
        s.progress.taken = final_taken;
        s.progress.errors = final_errors;
        s.progress.rate_per_sec = if elapsed > 0.0 {
            final_checked as f64 / elapsed
        } else {
            0.0
        };
        s.progress.elapsed_secs = elapsed;
        s.progress.eta_secs = Some(0.0);
        s.progress.current.clear();
        s.cancel = None;
    }

    emit(
        &state,
        ScanEvent::Finished {
            status: if stopped {
                ScanStatus::Stopped
            } else {
                ScanStatus::Completed
            },
            checked: final_checked,
            available: final_available,
            taken: final_taken,
            errors: final_errors,
            elapsed_secs: elapsed,
        },
    );
}

async fn check_tag(client: &Client, tag: &str) -> anyhow::Result<TagResult> {
    let url = format!("{API_URL}?tag={}", urlencoding_lite(tag));
    let resp = client
        .get(&url)
        .header("Accept", "*/*")
        .header("Referer", "https://cloudflare.pay/")
        .header("Origin", "https://cloudflare.pay")
        .send()
        .await?;

    let status = resp.status();
    let body: CheckResponse = resp.json().await?;

    if !status.is_success() {
        anyhow::bail!(
            "HTTP {status}: {}",
            body.error.unwrap_or_else(|| "unknown".into())
        );
    }

    if let Some(err) = body.error {
        if body.code.as_deref() == Some("INVALID_TAG") {
            return Ok(TagResult {
                tag: tag.to_string(),
                available: false,
                normalized: body.normalized.unwrap_or_else(|| tag.to_string()),
                code: body.code,
                checked_at: chrono::Utc::now(),
            });
        }
        anyhow::bail!("{err}");
    }

    Ok(TagResult {
        tag: tag.to_string(),
        available: body.available.unwrap_or(false),
        normalized: body.normalized.unwrap_or_else(|| tag.to_string()),
        code: body.code,
        checked_at: chrono::Utc::now(),
    })
}

fn urlencoding_lite(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

fn emit(state: &AppState, event: ScanEvent) {
    let _ = state.events.send(event);
}

fn finish_error(state: &AppState, cancel: &AtomicBool) {
    cancel.store(true, Ordering::Relaxed);
    let mut s = state.inner.write();
    s.status = ScanStatus::Error;
    s.progress.phase = ScanPhase::Error;
    s.cancel = None;
}

/// 供单元测试 / 外部调用的单次检查。
pub async fn check_one(tag: &str) -> anyhow::Result<TagResult> {
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .build()?;
    check_tag(&client, tag).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combination_order() {
        let chars: Vec<char> = ('a'..='z').collect();
        assert_eq!(combination_at(0, 3, &chars), "aaa");
        assert_eq!(combination_at(1, 3, &chars), "aab");
        assert_eq!(combination_at(25, 3, &chars), "aaz");
        assert_eq!(combination_at(26, 3, &chars), "aba");
    }

    #[test]
    fn total_count() {
        assert_eq!(total_combinations(3, Charset::Digits), 1000);
        assert_eq!(total_combinations(3, Charset::Letters), 26 * 26 * 26);
        assert_eq!(total_combinations(3, Charset::Alphanumeric), 36u64.pow(3));
    }
}
