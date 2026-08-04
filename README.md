# Cloudflare Pay Tag 扫描器

扫描 [cloudflare.pay](https://cloudflare.pay/) 用户名（tag）是否已被占用。

调用接口：

```http
GET https://cloudflare.pay/api/check?tag={name}
```

响应示例：

```json
{"available":false,"normalized":"cto","code":"TAG_TAKEN"}
{"available":true,"normalized":"xyz123"}
```

## 功能

- **Rust 后端**：并发请求 + 可停止 + SSE 实时推送
- **Web 前端**：选择字符长度（3/4/5/6 或自定义 3–8）、字符集、并发、延迟、前缀/后缀、索引范围
- **单次查询**、可用结果列表、导出 JSON/TXT

## 组合规模（务必先看）

| 长度 | 字符集 | 组合数 | 并发 10、约 1s/请求 |
|------|--------|--------|---------------------|
| 3 | a–z0–9 | 46,656 | ~1.3 小时 |
| 4 | a–z0–9 | 1,679,616 | ~2 天 |
| 5 | a–z0–9 | 60,466,176 | 极慢，不建议全量 |
| 3 | 仅数字 | 1,000 | 约 2 分钟 |

站点限制：**最少 3 个字符**。请合理控制并发，避免对目标站造成压力。

## 运行

```bash
# 需要 Rust 1.75+
cargo run --release
```

浏览器打开：http://127.0.0.1:8787

环境变量：

- `PORT`：监听端口，默认 `8787`

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/scan/start` | 启动扫描 |
| POST | `/api/scan/stop` | 停止扫描 |
| GET | `/api/scan/status` | 当前状态 |
| GET | `/api/scan/events` | SSE 事件流 |
| GET | `/api/scan/results` | 可用结果 |
| POST | `/api/scan/results/clear` | 清空结果 |
| GET | `/api/check?tag=xxx` | 单次查询 |

### 启动扫描 body 示例

```json
{
  "length": 3,
  "charset": "alphanumeric",
  "concurrency": 10,
  "delay_ms": 0,
  "prefix": null,
  "suffix": null,
  "only_store_available": true,
  "start_index": 0,
  "end_index": null
}
```

`charset`：`digits` | `letters` | `alphanumeric`

`start_index` / `end_index` 用于断点续扫或只扫一段字典序范围。

## 免责声明

本工具仅供学习与个人查询使用。请遵守目标站点服务条款与当地法律法规，控制请求频率，勿用于滥用。
