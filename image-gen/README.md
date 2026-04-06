# APIMart Grok Imagine 生图技能

使用 APIMart 的 Grok Imagine 1.0 API 生成/编辑图片（文生图、修图），并支持把本地图片上传到 APIMart 获取可用 URL，再用于后续生成任务。

## 功能

- ✅ 生图：文生图、图生图（参考图变体/风格迁移等，走同一个生成接口）
- ✅ 上传图片：上传本地图片到 APIMart，返回公网 URL
- ✅ 异步任务管理：返回 task_id，并通过 cron + message 每 10 秒推送查询结果
 - ✅ 价格提醒：提交前提示单价与预计费用（USD）

## 配置

### 环境变量

与 `video-gen` 保持一致，使用同一个 key：

```bash
export APIMART_API_KEY="your-api-key-here"
```

如果你在对话里直接把 Key 发给助手，技能应默认把它写入全局配置：`~/.openclaw/.env`，后续就不需要重复提供。

## 使用方法

### 对话触发示例

文生图：

```
帮我生成一张图片：一只橘猫坐在阳光照进来的窗台上，油画风
尺寸 1:1，生成 1 张
```

修图（用户给本地图片/截图/路径时，会先上传）：

```
用这张图片修一下：/Users/me/Desktop/photo.jpg
把背景换成星空，主体不变（图生图）
```

查询任务：

```
查一下这个任务进度：task_01JNXXXXXXXXXXXXXXXXXX
```

### 脚本工具（可选）

本技能附带一个 Node 脚本，方便你在本地直接调用 API：

```bash
# 文生图
node scripts/grok-image.js generate --prompt "A cute panda" --size 1:1 --n 1

# 修图：本地文件会自动上传后再调用编辑接口
node scripts/grok-image.js edit --image "/path/to/image.jpg" --prompt "Change the background to a starry sky, keep the main subject" --n 1

# 仅上传图片，拿 URL
node scripts/grok-image.js upload --file "/path/to/image.jpg"

# 查询任务状态
node scripts/grok-image.js task --id "task_01JNXXXXXXXXXXXXXXXXXX" --language zh
```

## 注意事项

- 图片生成是异步任务：提交后会返回 `task_id`，需要轮询任务状态获取最终图片 URL
- 生成时会先回传 `task_id`，并继续自动查询；只有在你主动“查任务”时才需要你提供 `task_id`

## 价格

- `gemini-3-pro-image-preview`: `1K/2K = $0.05`，`4K = $0.1000`
- `gemini-3-pro-image-preview-official`: `1K/2K = $0.1072`，`4K = $0.1920`

价格从技能内置配置读取：`apimart_pricing.json`（仅展示 USD）。
- 上传接口限制：支持 jpg/jpeg/png/webp/gif，最大 20MB
- 生成结果 URL 有有效期（通常 24h/72h），建议及时下载保存

## 相关文件

- `SKILL.md` - 技能详细规范
- `scripts/grok-image.js` - Node.js 脚本工具
