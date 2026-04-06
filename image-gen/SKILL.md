# AI Image Generation Skill

name: image-gen

使用 APIMart Grok Imagine API 进行文生图与图片编辑（修图）。同时支持将本地图片上传到 APIMart，获取 URL 后用于后续编辑/生成任务；并可通过 task_id 查询任务状态。

## 触发条件

当用户提到以下内容时触发此技能：

- “生图 / 生成图片 / 画一张 / 文生图 / AI 图片 / 海报 / 插画 / 壁纸”
- “修图 / 改图 / 抠图 / 换背景 / 风格迁移 / 变成xx风格 / 去掉xx / 加上xx”
- “上传图片 / 把这张图传上去 / 图片转成 URL”
- “查询任务 / 查进度 / task_id / 任务状态”

## 可用服务

### APIMart

- **Base URL**: `https://api.apimart.ai`
- **认证**: `Authorization: Bearer <API_KEY>`
- **环境变量**: `APIMART_API_KEY`

## API Key 持久化（全局）

如果用户在对话里直接提供了 API Key（例如以 `sk-` 开头的字符串），技能应默认将其写入全局配置文件：

- macOS/Linux: `~/.openclaw/.env`
- Windows: `%USERPROFILE%\\.openclaw\\.env`

写入格式（dotenv）：

```
APIMART_API_KEY=sk-...
```

注意：避免在对话中回显完整 key。

## API 一览

### 1) 上传图片

- **Endpoint**: `POST /v1/uploads/images`
- **Content-Type**: `multipart/form-data`
- **Body**: `file=@/path/to/image.jpg`
- **响应**:

```json
{
  "url": "https://upload.apimart.ai/f/image/...-photo.jpg",
  "filename": "photo.jpg",
  "content_type": "image/jpeg",
  "bytes": 235680,
  "created_at": 1743436800
}
```

### 2) 生图（文生图 / 图生图）

- **Endpoint**: `POST /v1/images/generations`
- **Model**: `gemini-3-pro-image-preview`（默认）

请求参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| model | string | 是 | - | 模型名称 |
| prompt | string | 是 | - | 图片描述，支持中英文 |
| size | string | 否 | 1:1 | 1:1 / 16:9 / 9:16 / 3:2 / 2:3 等（具体见模型文档） |
| n | integer | 否 | 1 | 生成张数，1-4 |
| resolution | string | 否 | 1K | 输出分辨率：1K / 2K / 4K |
| image_urls | string[] | 否 | - | 参考图片 URL（支持图生图/变体），最多 14 张（Gemini Pro） |

提交成功响应：

```json
{
  "code": 200,
  "data": [
    {
      "status": "submitted",
      "task_id": "task_01JNXXXXXXXXXXXXXXXXXX"
    }
  ]
}
```

### 3) 价格与提醒（提交前必须告知）

生图默认使用 Gemini Pro 预览模型，单价不写死在技能中，统一从技能目录内的价格配置读取：`apimart_pricing.json`。

默认应包含以下价格（USD）：

- `gemini-3-pro-image-preview`: `1K/2K = $0.05`，`4K = $0.1000`
- `gemini-3-pro-image-preview-official`: `1K/2K = $0.1072`，`4K = $0.1920`

提交前提示用户的价格（按张计费）：

```
预计费用(USD) = 单价(USD/张) * n
```

仅展示 USD 价格。

### 3.1) 查询 Token 余额（生成前调用）

- **Endpoint**: `GET /v1/user/balance`
- **说明**: 每次提交图片生成/编辑任务前，先查询当前 API Key 的余额/使用情况。

### 4) 查询任务状态

- **Endpoint**: `GET /v1/tasks/{task_id}`
- **Query**: `language` 可选（`zh` / `en` / `ko` / `ja`）

查询时应向用户回传：

- `status` / `progress`
- 若已完成：结果 `images[0].url[0]`
- `price`（USD）：优先从本地任务元数据读取；若没有元数据则提示无法确定
- 当前 API Key 的余额信息：`remain_balance` / `used_balance`（调用 `GET /v1/user/balance`）

任务状态枚举（统一格式）：

- `pending` - 排队中
- `processing` - 处理中
- `completed` - 成功完成
- `failed` - 失败
- `cancelled` - 已取消

典型完成响应（图片任务）：

```json
{
  "code": 200,
  "data": {
    "id": "task_...",
    "status": "completed",
    "progress": 100,
    "result": {
      "images": [
        {
          "url": ["https://upload.apimart.ai/f/image/...png"],
          "expires_at": 1763174708
        }
      ]
    }
  }
}
```

## 完整工作流程

### A. 文生图

1. 收集用户参数：`prompt`、`size`、`n`
2. 选择模型与参数：
   - 默认：`gemini-3-pro-image-preview` + `resolution=1K` + `n=1`
   - 需要更稳定/更接近官方效果时：切换到 `gemini-3-pro-image-preview-official`
3. **提交前必须提示预计费用（USD）并让用户确认**
4. 调用 `POST /v1/images/generations` 提交任务
5. 获取 `task_id`，并**立即回传给用户**（方便用户主动查询/中断/追踪）
6. 使用 `cron` 工具创建一个每 10 秒触发的定时查询任务：调用 `GET /v1/tasks/{task_id}`，并用 `message` 工具把进度回传到当前会话；直到 `status=completed/failed/cancelled` 后自动停止定时任务
7. 完成后返回生成图片 URL，同时回传本次预计消耗（USD）

### B. 图生图（包含上传）

1. 用户提供图片（本地路径/截图/文件）时：
   - 优先使用上传接口 `POST /v1/uploads/images` 获取 URL
2. 选择模型与参数（同 A）
3. **提交前必须提示预计费用（USD）并让用户确认**
4. 调用 `POST /v1/images/generations`，传入：
   - `prompt`
   - `image_urls: [<uploaded_url>, ...]`
5. 获取 `task_id`，并**立即回传给用户**
6. 使用 `cron` 工具创建一个每 10 秒触发的定时查询任务：调用 `GET /v1/tasks/{task_id}`，并用 `message` 工具把进度回传到当前会话；直到 `status=completed/failed/cancelled` 后自动停止定时任务
7. 完成后返回结果图片 URL，同时回传本次预计消耗（USD）

## 定时查询（cron + message）

当图片生成/编辑提交成功后（拿到 `task_id`），优先使用 `cron` 工具进行后台轮询，并使用 `message` 工具向当前会话推送进度。

### 行为约定

- 轮询频率：每 10 秒一次（`everyMs = 10000`）
- cron 返回的 `job_id` 需要保存（至少保存在本次对话上下文中），以便用户请求“停止轮询”时能准确停掉对应任务
- 每次轮询：
  - 调用 `GET /v1/tasks/{task_id}?language=zh`
  - 解析并回传 `status` / `progress`
  - 若 `completed`：回传 `images[0].url[0]`，并可选下载到本地后输出 `MEDIA:`
  - 若 `failed/cancelled`：回传失败原因（如有 `fail_reason`），并停止定时任务
- 超时：最多 5 分钟，超时后停止定时任务并提示用户稍后用 `task_id` 手动查询
- 可中断：若用户说“停止查询/停止轮询”，应立即停止该 `task_id` 对应的 cron job

### cron payload 正确配置（经过实际测试可用）

**参考成功案例（喝水提醒）**，创建 cron job 必须使用以下配置才能自动触发推送：

```json
{
  "action": "add",
  "name": "Poll image task {task_id}",
  "schedule": {
    "kind": "every",
    "everyMs": 10000
  },
  "payload": {
    "kind": "systemEvent",
    "text": "查询任务 {task_id}"
  },
  "sessionTarget": "main",
  "enabled": true
}
```

**关键配置**：
| 参数 | 值 | 说明 |
|------|-----|------|
| `sessionTarget` | `main` | 在当前主会话运行（`isolated` 隔离会话推送不工作） |
| `payload.kind` | `systemEvent` | 系统事件触发查询，和喝水提醒一样能正常工作 |
| `payload.text` | `"查询任务 {task_id}"` | 触发对话查询，工具会自动处理 |
| `everyMs` | `10000` | 每 10 秒轮询一次 |

**行为约定**：
- 每次轮询：调用 `GET /v1/tasks/{task_id}?language=zh` 查询状态
- 通过 `message` 工具推送 `status/progress` 到当前会话
- 若 `completed`：下载图片到本地，推送完整结果 + `MEDIA:` 指令 + 价格信息，然后删除 cron job
- 若 `failed/cancelled`：推送失败信息，删除 cron job
- 超时：最多 5 分钟，超时后删除 cron job 并提示用户稍后手动查询
- 可中断：用户说"停止查询"可立即停止对应 cron job

## task_id 使用约定

- **生成/编辑时**：提交成功后就返回 `task_id`，同时继续自动查询直到出结果
- **用户主动查询时**：用户需要提供 `task_id`（例如“查一下 task_xxx”），此时只做查询/返回状态与结果，并尽量返回本次预计消耗（见“本地任务元数据”）

## 本地任务元数据（用于查询时显示费用）

由于任务查询响应不一定包含计费信息，技能应在提交任务时把关键信息落盘，便于后续用户只提供 `task_id` 就能查询并显示费用：

- 路径：
  - macOS/Linux: `~/.openclaw/apimart_task_meta.json`
  - Windows: `%USERPROFILE%\\.openclaw\\apimart_task_meta.json`
- 记录字段建议包含：`task_id`、`type`、`model`、`resolution`、`n`、`unit_price_usd`、`estimated_cost_usd`

## 下载与发送（可选）

当用户希望“直接发图”，可按以下方式处理：

1. 下载图片到：
   - macOS/Linux: `~/.openclaw/generated_image.png`
   - Windows: `%USERPROFILE%\\.openclaw\\generated_image.png`
2. 发送：
   - `MEDIA: ~/.openclaw/generated_image.png`

## 错误处理

- **401**: API Key 无效 -> 提示检查 `APIMART_API_KEY`
- **413**: 上传文件过大 -> 提示 20MB 限制并建议压缩
- **429**: 频率限制 -> 等待后重试
- **任务失败**: 返回 `fail_reason`（如有）并提示用户调整 prompt

## 工具使用

- **read**: 读取本地图片（用于确认文件存在/格式）
- **exec**: 调用上传、生成、查询任务、下载
- **cron**: 定时触发查询任务（每 10 秒）
- **message**: 将轮询进度/结果推送到当前会话
- **MEDIA:**: 发送图片到当前窗口
