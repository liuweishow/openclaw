#!/usr/bin/env node

/*
 * APIMart Grok Imagine 图片生成/编辑工具
 *
 * Examples:
 *   node scripts/grok-image.js generate --prompt "A cute panda" --size 1:1 --n 1
 *   node scripts/grok-image.js edit --image "/path/to/in.jpg" --prompt "Change background to starry sky" --n 1
 *   node scripts/grok-image.js upload --file "/path/to/in.jpg"
 *   node scripts/grok-image.js task --id "task_xxx" --language zh
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const BASE_URL = 'https://api.apimart.ai'
const API_KEY =
    process.env.APIMART_API_KEY ||
    process.argv.find((arg) => arg.startsWith('--key='))?.split('=')[1] ||
    ''

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw')
const LOCAL_PRICING_PATH = path.resolve(__dirname, '..', 'apimart_pricing.json')
const TASK_META_PATH = path.join(OPENCLAW_DIR, 'apimart_task_meta.json')

function formatNumberTrim(n, { maxDecimals = 3 } = {}) {
    const v = Number(n)
    if (!Number.isFinite(v)) return null
    return v
        .toFixed(maxDecimals)
        .replace(/\.0+$/, '')
        .replace(/(\.[0-9]*?)0+$/, '$1')
}

function formatUsd(n, { decimals = 2, trim = false } = {}) {
    const v = Number(n)
    if (!Number.isFinite(v)) return null
    const s = trim
        ? formatNumberTrim(v, { maxDecimals: decimals })
        : v.toFixed(decimals)
    return `$${s}`
}

function formatCny(n, { decimals = 2, trim = false } = {}) {
    const v = Number(n)
    if (!Number.isFinite(v)) return null
    const s = trim
        ? formatNumberTrim(v, { maxDecimals: decimals })
        : v.toFixed(decimals)
    return `¥${s}`
}

function formatLocalDateTimeFromEpochSeconds(sec) {
    const s = Number(sec)
    if (!Number.isFinite(s) || s <= 0) return null
    const d = new Date(Math.floor(s * 1000))
    const pad2 = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function guessFileExtFromUrl(u, fallbackExt) {
    try {
        const url = new URL(u)
        const p = url.pathname.toLowerCase()
        const m = p.match(/\.(png|jpe?g|webp|gif)$/)
        if (m) return `.${m[1] === 'jpeg' ? 'jpg' : m[1]}`
    } catch {
        // ignore
    }
    return fallbackExt
}

async function downloadToOpenclaw(url, fileName) {
    const outDir = getOutputDir()
    fs.mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, fileName)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
    const ab = await res.arrayBuffer()
    fs.writeFileSync(outPath, Buffer.from(ab))
    return outPath
}

function findExistingImagePathForTask(taskId) {
    const dir = getOutputDir()
    const base = `image_task_${taskId}`
    const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
    for (const ext of exts) {
        const p = path.join(dir, `${base}${ext}`)
        try {
            const st = fs.statSync(p)
            if (st.isFile() && st.size > 0) return p
        } catch {
            // ignore
        }
    }
    return null
}

async function ensureImageDownloadedForTask({ taskId, url }) {
    const cached = getCachedTaskMediaPath(taskId)
    if (cached) return cached
    const existing = findExistingImagePathForTask(taskId)
    if (existing) {
        setCachedTaskMediaPath(taskId, { mediaPath: existing, url })
        return existing
    }
    const ext = guessFileExtFromUrl(url, '.png')
    const downloaded = await downloadToOpenclaw(
        url,
        `image_task_${taskId}${ext}`,
    )
    setCachedTaskMediaPath(taskId, { mediaPath: downloaded, url })
    return downloaded
}

function formatSizeLabel(size) {
    if (!size) return null
    const s = String(size)
    if (s === '1:1') return `${s} 正方形`
    if (s === '16:9') return `${s} 横屏`
    if (s === '9:16') return `${s} 竖屏`
    return s
}

function readJsonFile(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8')
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
        return null
    }
}

function loadPricing() {
    // Pricing is stored with the skill (no global pricing file).
    return readJsonFile(LOCAL_PRICING_PATH)
}

function writeJsonFile(filePath, obj, { indent = 4 } = {}) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, indent) + '\n')
}

function resolveTildePath(p) {
    if (typeof p !== 'string') return null
    if (p === '~') return os.homedir()
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
    if (p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
    if (/^%USERPROFILE%[\\/]/i.test(p))
        return path.join(os.homedir(), p.replace(/^%USERPROFILE%[\\/]/i, ''))
    if (/^\$HOME[\\/]/.test(p))
        return path.join(os.homedir(), p.replace(/^\$HOME[\\/]/, ''))
    if (/^\$\{HOME\}[\\/]/.test(p))
        return path.join(os.homedir(), p.replace(/^\$\{HOME\}[\\/]/, ''))
    return p
}

function normalizePathForConfig(p) {
    if (typeof p !== 'string' || !p) return null
    const home = os.homedir()
    try {
        const rel = path.relative(home, p)
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            const relPosix = rel.split(path.sep).join('/')
            return `~/${relPosix}`
        }
        if (rel === '') return '~'
    } catch {
        // ignore
    }
    return p
}

function getOutputDir() {
    const pricing = loadPricing()
    const raw = pricing?.storage?.output_dir || '~/.openclaw'
    const p = resolveTildePath(raw)
    return p ? path.resolve(p) : path.join(os.homedir(), '.openclaw')
}

function getCachedTaskMediaPath(taskId) {
    const pricing = loadPricing()
    const raw = pricing?.cache?.tasks?.[taskId]?.path
    const p = resolveTildePath(raw)
    if (!p) return null
    try {
        const st = fs.statSync(p)
        if (st.isFile() && st.size > 0) return p
    } catch {
        return null
    }
    return null
}

function setCachedTaskMediaPath(taskId, { mediaPath, url } = {}) {
    if (!taskId || typeof taskId !== 'string') return
    if (!mediaPath || typeof mediaPath !== 'string') return

    const pricing = loadPricing() || {}
    if (!pricing.cache || typeof pricing.cache !== 'object') pricing.cache = {}
    if (!pricing.cache.tasks || typeof pricing.cache.tasks !== 'object')
        pricing.cache.tasks = {}

    pricing.cache.tasks[taskId] = {
        ...(pricing.cache.tasks[taskId] || {}),
        path: normalizePathForConfig(mediaPath) || mediaPath,
        ...(typeof url === 'string' ? { url } : {}),
        updatedAtMs: Date.now(),
    }

    writeJsonFile(LOCAL_PRICING_PATH, pricing)
}

function getPriceDisplayConfig() {
    const pricing = loadPricing()
    const display =
        pricing?.display && typeof pricing.display === 'object'
            ? pricing.display
            : {}

    let showUsd = display.show_usd !== false
    let showCny = display.show_cny === true
    if (!showUsd && !showCny) showUsd = true

    return {
        show_usd: showUsd,
        show_cny: showCny,
        show_unit_labels: display.show_unit_labels !== false,
        cny_exchange_rate:
            typeof display.cny_exchange_rate === 'number' &&
            Number.isFinite(display.cny_exchange_rate) &&
            display.cny_exchange_rate > 0
                ? display.cny_exchange_rate
                : 7.2,
    }
}

function usageAndExit(code = 1) {
    console.error(
        [
            'Usage:',
            '  generate --prompt <text> [--size 1:1|16:9|9:16|3:2|2:3] [--n 1-4] [--resolution 1K|2K|4K] [--model gemini-3-pro-image-preview]',
            '  edit --image <localPathOrUrl> --prompt <text> [--n 1-4] [--resolution 1K|2K|4K] [--model gemini-3-pro-image-preview]',
            '  upload --file <localPath>',
            '  task --id <task_id> [--language zh|en|ko|ja]',
            '  (generate/edit default: start cron watcher in the main session; use --watch=current for direct polling)',
            '  (optional: --deliver=media to download and emit MEDIA: <localPath>)',
            '',
            'Env:',
            '  APIMART_API_KEY',
            '',
            'Pricing config:',
            `  ${LOCAL_PRICING_PATH}`,
        ].join('\n'),
    )
    process.exit(code)
}

function parseArgs(argv) {
    const args = { _: [] }
    for (const a of argv) {
        if (a.startsWith('--')) {
            const [k, v = 'true'] = a.slice(2).split('=')
            args[k] = v
        } else {
            args._.push(a)
        }
    }
    return args
}

function runOpenclaw(args) {
    const res = spawnSync('openclaw', args, { encoding: 'utf8' })
    if (res.error) throw res.error
    if (res.status !== 0) {
        const msg = (res.stderr || res.stdout || '').trim()
        throw new Error(msg || `openclaw exited with code ${res.status}`)
    }
    return (res.stdout || '').trim()
}

function openclawAvailable() {
    try {
        const res = spawnSync('openclaw', ['--version'], { encoding: 'utf8' })
        return !res.error && res.status === 0
    } catch {
        return false
    }
}

function extractCronJobId(jsonText) {
    try {
        const obj = JSON.parse(jsonText)
        if (typeof obj?.id === 'string') return obj.id
        if (typeof obj?.job?.id === 'string') return obj.job.id
        if (typeof obj?.data?.id === 'string') return obj.data.id
    } catch {
        // ignore
    }
    return null
}

function buildCronWatchSystemEvent({
    taskId,
    jobId,
    language,
    maxMinutes = 5,
}) {
    const lang = language || 'zh'
    const maxAttempts = Math.max(1, Math.floor((maxMinutes * 60) / 10))
    return [
        `查询图片任务 ${taskId}（cron_job_id=${jobId}）`,
        '',
        `要求：调用 GET /v1/tasks/${taskId}?language=${lang} 查询状态，并把 status/progress 回传到当前主会话。`,
        `价格展示必须读取 ~/.openclaw/skills/image-gen/apimart_pricing.json 中的 display 配置，按配置决定是否展示 USD、CNY 和单位标签。`,
        `若 status=completed：读取 images[0].url[0]，默认回传结果 URL 与价格信息；当用户明确要求“发图/发送图片/直接发图”时，下载该 URL 到 ~/.openclaw/image_task_${taskId}.png 并输出一行 MEDIA: ~/.openclaw/image_task_${taskId}.png，然后执行 openclaw cron disable ${jobId}。`,
        `若 status=failed/cancelled：返回失败原因（如有），然后执行 openclaw cron disable ${jobId}。`,
        `若已运行超过 ${maxAttempts} 次（约 ${maxMinutes} 分钟）仍未结束：返回超时提示，然后执行 openclaw cron disable ${jobId}。`,
    ].join('\n')
}

function createCronWatcher({ taskId, language }) {
    if (!openclawAvailable()) return null

    const name = `apimart-image-watch-${taskId}`
    const addOut = runOpenclaw([
        'cron',
        'add',
        '--disabled',
        '--every',
        '10s',
        '--exact',
        '--announce',
        '--channel',
        'last',
        '--session',
        'main',
        '--timeout-seconds',
        '25',
        '--thinking',
        'minimal',
        '--light-context',
        '--name',
        name,
        '--system-event',
        'init',
        '--json',
    ])

    const jobId = extractCronJobId(addOut)
    if (!jobId) throw new Error(`Failed to parse cron job id: ${addOut}`)

    const eventText = buildCronWatchSystemEvent({ taskId, jobId, language })
    runOpenclaw(['cron', 'edit', jobId, '--system-event', eventText])
    runOpenclaw(['cron', 'enable', jobId])

    try {
        runOpenclaw([
            'cron',
            'add',
            '--at',
            '+6m',
            '--delete-after-run',
            '--no-deliver',
            '--timeout-seconds',
            '20',
            '--thinking',
            'minimal',
            '--light-context',
            '--name',
            `apimart-watch-stop-${taskId}`,
            '--message',
            `请执行命令：openclaw cron disable ${jobId} （如果该 job 已禁用则忽略错误）`,
        ])
    } catch {
        // Best-effort only.
    }

    return jobId
}

function getWatchMode(args) {
    const raw = args.watch == null ? 'cron' : String(args.watch).toLowerCase()
    if (raw === 'true') return 'cron'
    if (raw === 'false' || raw === 'none' || raw === 'off') return 'none'
    if (raw === 'cron' || raw === 'current' || raw === 'both') return raw
    throw new Error(`Unsupported --watch mode: ${args.watch}`)
}

function getDeliverMode(args) {
    const raw =
        args.deliver == null ? 'url' : String(args.deliver).toLowerCase()
    if (raw === 'true') return 'media'
    if (raw === 'false') return 'url'
    if (raw === 'url' || raw === 'media') return raw
    throw new Error(`Unsupported --deliver mode: ${args.deliver}`)
}

async function fetchJson(url, options = {}) {
    const headers = Object.assign({}, options.headers || {})
    if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`
    const res = await fetch(url, { ...options, headers })
    const text = await res.text()
    let data
    try {
        data = JSON.parse(text)
    } catch {
        data = text
    }
    if (!res.ok) {
        const msg = typeof data === 'string' ? data : JSON.stringify(data)
        throw new Error(`HTTP ${res.status}: ${msg}`)
    }
    return data
}

async function getTokenBalance() {
    // Balance endpoint (uses the same API key as generation).
    // User requirement: call GET /v1/user/balance
    return fetchJson(`${BASE_URL}/v1/user/balance`, { method: 'GET' })
}

async function getTokenBalanceLines({ markdown = false } = {}) {
    try {
        const data = await getTokenBalance()
        if (!data?.success) return []
        if (data?.unlimited_quota) {
            return [
                markdown
                    ? '**当前账户余额:** unlimited'
                    : '当前账户余额: unlimited',
            ]
        }
        if (typeof data?.remain_balance !== 'number') return []
        return formatCurrencyAmountLines('当前账户余额', data.remain_balance, {
            decimals: 2,
            trim: false,
            markdown,
        })
    } catch {
        return []
    }
}

async function getTokenBalanceLine() {
    const lines = await getTokenBalanceLines()
    return lines.length ? lines.join('\n') : null
}

async function uploadImage(filePath) {
    const abs = path.resolve(filePath)
    if (!fs.existsSync(abs)) {
        throw new Error(`File not found: ${abs}`)
    }

    const buf = fs.readFileSync(abs)
    const form = new FormData()
    form.append('file', new Blob([buf]), path.basename(abs))

    const data = await fetchJson(`${BASE_URL}/v1/uploads/images`, {
        method: 'POST',
        body: form,
    })

    if (!data?.url) {
        throw new Error(`Unexpected upload response: ${JSON.stringify(data)}`)
    }
    return data.url
}

function loadTaskMeta() {
    try {
        if (!fs.existsSync(TASK_META_PATH)) return {}
        const raw = fs.readFileSync(TASK_META_PATH, 'utf8')
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function saveTaskMeta(metaMap) {
    const dir = path.dirname(TASK_META_PATH)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(TASK_META_PATH, JSON.stringify(metaMap, null, 2))
}

function estimateImageCostUsd({ model, resolution, n }) {
    const pricing = loadPricing()
    const unit = pricing?.image?.models?.[model]?.unit_price_usd?.[resolution]
    if (typeof unit !== 'number') return null
    const total = unit * n
    return {
        unit_usd: unit,
        total_usd: total,
    }
}

function formatCurrencyAmountLines(
    label,
    usdAmount,
    { decimals = 2, trim = false, unitSuffix = null, markdown = false } = {},
) {
    const cfg = getPriceDisplayConfig()
    const lines = []

    if (cfg.show_usd) {
        const usdText = formatUsd(usdAmount, { decimals, trim })
        if (usdText) {
            const title =
                cfg.show_unit_labels && unitSuffix
                    ? `${label}(USD/${unitSuffix})`
                    : `${label}(USD)`
            lines.push(
                markdown ? `**${title}:** ${usdText}` : `${title}: ${usdText}`,
            )
        }
    }

    if (cfg.show_cny) {
        const cnyAmount = Number(usdAmount) * cfg.cny_exchange_rate
        const cnyText = formatCny(cnyAmount, { decimals, trim })
        if (cnyText) {
            const title =
                cfg.show_unit_labels && unitSuffix
                    ? `${label}(CNY/${unitSuffix})`
                    : `${label}(CNY)`
            lines.push(
                markdown ? `**${title}:** ${cnyText}` : `${title}: ${cnyText}`,
            )
        }
    }

    return lines
}

function formatImageEstimatedCostLines(cost) {
    if (
        !cost ||
        typeof cost.total_usd !== 'number' ||
        typeof cost.unit_usd !== 'number'
    )
        return []

    return [
        ...formatCurrencyAmountLines('单价', cost.unit_usd, {
            unitSuffix: '张',
        }),
        ...formatCurrencyAmountLines('预计费用', cost.total_usd),
    ]
}

function formatImageSummaryPriceLines(cost, { markdown = false } = {}) {
    if (
        !cost ||
        typeof cost.total_usd !== 'number' ||
        typeof cost.unit_usd !== 'number'
    )
        return []

    return formatCurrencyAmountLines('本次价格', cost.total_usd, {
        markdown,
    })
}

async function submitGeneration({
    model,
    prompt,
    size,
    n,
    resolution,
    imageUrls,
}) {
    const payload = {
        model,
        prompt,
        ...(size ? { size } : {}),
        ...(n ? { n: Number(n) } : {}),
        ...(resolution ? { resolution } : {}),
        ...(imageUrls && imageUrls.length ? { image_urls: imageUrls } : {}),
    }

    const data = await fetchJson(`${BASE_URL}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })

    const taskId = data?.data?.[0]?.task_id
    if (!taskId) {
        throw new Error(
            `Unexpected generation response: ${JSON.stringify(data)}`,
        )
    }

    // Persist task meta so later manual queries can show cost.
    const metaMap = loadTaskMeta()
    const cost = estimateImageCostUsd({
        model,
        resolution: resolution || '1K',
        n: Number(n) || 1,
    })
    metaMap[taskId] = {
        task_id: taskId,
        type: 'image',
        model,
        size: size || null,
        resolution: resolution || '1K',
        n: Number(n) || 1,
        ...(cost
            ? {
                  unit_price_usd: cost.unit_usd,
                  estimated_cost_usd: cost.total_usd,
              }
            : {}),
        created_at: Math.floor(Date.now() / 1000),
    }
    saveTaskMeta(metaMap)

    return taskId
}

async function getTask(taskId, language = 'en') {
    const url = new URL(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}`)
    if (language) url.searchParams.set('language', language)
    return fetchJson(url.toString(), { method: 'GET' })
}

function pickFirstImageUrl(taskResp) {
    const urls = taskResp?.data?.result?.images?.[0]?.url
    if (Array.isArray(urls) && urls.length > 0) return urls[0]
    return null
}

async function waitForTask(
    taskId,
    { intervalMs = 10000, timeoutMs = 5 * 60 * 1000, language = 'en' } = {},
) {
    const start = Date.now()
    while (true) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Task timeout after ${timeoutMs}ms: ${taskId}`)
        }

        let data
        try {
            data = await getTask(taskId, language)
        } catch (e) {
            // Network/transient failure: keep polling until timeout.
            console.warn(`task=${taskId} poll_error=${e?.message || String(e)}`)
            await new Promise((r) => setTimeout(r, intervalMs))
            continue
        }
        const status = data?.data?.status || 'unknown'
        const progress = data?.data?.progress
        const progressText = typeof progress === 'number' ? `${progress}%` : '?'
        console.log(
            `轮询中: task_id=${taskId} status=${status} progress=${progressText}`,
        )

        if (status === 'completed') return data
        if (status === 'failed' || status === 'cancelled') {
            throw new Error(`Task ${status}: ${JSON.stringify(data)}`)
        }
        await new Promise((r) => setTimeout(r, intervalMs))
    }
}

async function main() {
    const argv = process.argv.slice(2)
    const cmd = argv[0]
    const args = parseArgs(argv.slice(1))

    if (!cmd) usageAndExit(1)
    if (!API_KEY) {
        console.error(
            'Error: missing API key. Please set APIMART_API_KEY, or pass --key=...',
        )
        process.exit(1)
    }

    if (cmd === 'upload') {
        const file = args.file
        if (!file) usageAndExit(1)
        const url = await uploadImage(file)
        console.log(url)
        return
    }

    if (cmd === 'task') {
        const id = args.id
        if (!id) usageAndExit(1)
        const language = args.language || 'en'
        const raw = String(args.raw || '').toLowerCase() === 'true'

        const cachedMediaPath = getCachedTaskMediaPath(id)
        if (cachedMediaPath && !raw) {
            console.log('好的，我来查询这个任务的状态：\n')
            console.log('本地已存在该任务文件，直接发送：\n')
            console.log(`MEDIA: ${cachedMediaPath}`)
            return
        }
        const data = await getTask(id, language)

        const meta = loadTaskMeta()[id]
        const status = data?.data?.status || 'unknown'
        const progress =
            typeof data?.data?.progress === 'number' ? data.data.progress : null
        const createdSec = data?.data?.created
        const completedSec = data?.data?.completed
        const actualTimeSec =
            typeof data?.data?.actual_time === 'number'
                ? data.data.actual_time
                : null

        const createdText = formatLocalDateTimeFromEpochSeconds(createdSec)
        const completedText = formatLocalDateTimeFromEpochSeconds(completedSec)
        const durationSec =
            actualTimeSec != null
                ? actualTimeSec
                : createdSec != null && completedSec != null
                  ? Math.max(0, Number(completedSec) - Number(createdSec))
                  : null

        const imageUrl = status === 'completed' ? pickFirstImageUrl(data) : null
        const expiresAtSec = data?.data?.result?.images?.[0]?.expires_at
        const expiresText = formatLocalDateTimeFromEpochSeconds(expiresAtSec)

        console.log('好的，我来查询这个任务的状态：\n')
        console.log('好的，查询到任务信息：\n')
        console.log(`任务状态： ${status}`)
        console.log(`任务ID： ${id}`)
        if (createdText) console.log(`创建时间： ${createdText}`)
        if (completedText) console.log(`完成时间： ${completedText}`)
        if (durationSec != null)
            console.log(`处理耗时： ${Math.round(durationSec)}秒`)
        if (progress != null && status !== 'completed')
            console.log(`进度： ${progress}%`)

        if (status === 'completed' && imageUrl) {
            console.log('\n结果图片：')
            console.log(`· URL：${imageUrl}`)
            if (expiresText) console.log(`· 过期时间：${expiresText}`)
        }

        if (meta?.estimated_cost_usd != null) {
            for (const line of formatImageSummaryPriceLines({
                total_usd: meta.estimated_cost_usd,
                unit_usd: meta.unit_price_usd,
            })) {
                console.log(line)
            }
        }

        const bal = await getTokenBalanceLine()
        if (bal) console.log(bal)

        if (status === 'completed' && imageUrl) {
            const localPath = await ensureImageDownloadedForTask({
                taskId: id,
                url: imageUrl,
            })
            console.log(`\nMEDIA: ${localPath}`)
        }

        if (raw) {
            console.log('\n这是原始内容：')
            console.log(JSON.stringify(data, null, 2))
        }
        return
    }

    if (cmd === 'generate') {
        const prompt = args.prompt
        if (!prompt) usageAndExit(1)

        const model = args.model || 'gemini-3-pro-image-preview'
        const size = args.size || '1:1'
        const n = Number(args.n || 1)
        const resolution = args.resolution || '1K'
        const watchMode = getWatchMode(args)
        const deliverMode = getDeliverMode(args)

        const cost = estimateImageCostUsd({ model, resolution, n })
        if (cost) {
            for (const line of formatImageEstimatedCostLines(cost)) {
                console.log(line)
            }
        }

        // Must query balance before submitting generation.
        await getTokenBalanceLine()
        const taskId = await submitGeneration({
            model,
            prompt,
            size,
            n,
            resolution,
        })
        console.log(`submitted task_id=${taskId}`)

        if (watchMode === 'cron' || watchMode === 'both') {
            try {
                const jobId = createCronWatcher({
                    taskId,
                    language: args.language || 'zh',
                })
                if (jobId) console.log(`cron_job_id=${jobId}`)
                else console.warn('cron_watch_error=openclaw_not_available')
            } catch (e) {
                console.warn(`cron_watch_error=${e?.message || String(e)}`)
                if (watchMode === 'cron') throw e
            }
        }

        if (watchMode === 'cron' || watchMode === 'none') return

        const final = await waitForTask(taskId, {
            language: args.language || 'en',
        })
        const imageUrl = pickFirstImageUrl(final)
        if (imageUrl) {
            let mediaPath = null
            if (deliverMode === 'media') {
                const ext = guessFileExtFromUrl(imageUrl, '.png')
                mediaPath = await downloadToOpenclaw(
                    imageUrl,
                    `image_task_${taskId}${ext}`,
                )
            }

            const status = final?.data?.status || 'unknown'
            const progress =
                typeof final?.data?.progress === 'number'
                    ? `${final.data.progress}%`
                    : '?%'
            const priceLines = cost
                ? formatImageSummaryPriceLines(cost, { markdown: true })
                : []
            const sizeLabel = formatSizeLabel(size)

            console.log('\n这任务已完成：\n')
            console.log(`**任务状态:** ${status} (${progress})`)
            console.log(`**任务ID:** \`${taskId}\``)
            console.log(`**结果URL:** ${imageUrl}`)
            if (sizeLabel)
                console.log(`**尺寸:** ${sizeLabel}，${resolution} 分辨率`)
            else console.log(`**尺寸:** ${resolution} 分辨率`)
            for (const line of priceLines) {
                console.log(line)
            }

            const balanceLines = await getTokenBalanceLines({ markdown: true })
            if (balanceLines.length) {
                for (const line of balanceLines) {
                    console.log(line)
                }
            } else {
                console.log('**当前账户余额:** unknown')
            }

            if (mediaPath) console.log(`\nMEDIA: ${mediaPath}`)
        } else {
            console.log(JSON.stringify(final, null, 2))
        }
        return
    }

    if (cmd === 'edit') {
        const prompt = args.prompt
        const image = args.image
        if (!prompt || !image) usageAndExit(1)

        let imageUrl = image
        if (!/^https?:\/\//i.test(image)) {
            imageUrl = await uploadImage(image)
            console.log(`uploaded_image_url=${imageUrl}`)
        }

        const model = args.model || 'gemini-3-pro-image-preview'
        const n = Number(args.n || 1)
        const resolution = args.resolution || '1K'
        const watchMode = getWatchMode(args)
        const deliverMode = getDeliverMode(args)

        const cost = estimateImageCostUsd({ model, resolution, n })
        if (cost) {
            for (const line of formatImageEstimatedCostLines(cost)) {
                console.log(line)
            }
        }

        // Must query balance before submitting generation.
        await getTokenBalanceLine()
        const taskId = await submitGeneration({
            model,
            prompt,
            n,
            resolution,
            imageUrls: [imageUrl],
        })
        console.log(`submitted task_id=${taskId}`)

        if (watchMode === 'cron' || watchMode === 'both') {
            try {
                const jobId = createCronWatcher({
                    taskId,
                    language: args.language || 'zh',
                })
                if (jobId) console.log(`cron_job_id=${jobId}`)
                else console.warn('cron_watch_error=openclaw_not_available')
            } catch (e) {
                console.warn(`cron_watch_error=${e?.message || String(e)}`)
                if (watchMode === 'cron') throw e
            }
        }

        if (watchMode === 'cron' || watchMode === 'none') return

        const final = await waitForTask(taskId, {
            language: args.language || 'en',
        })
        const outUrl = pickFirstImageUrl(final)
        if (outUrl) {
            let mediaPath = null
            if (deliverMode === 'media') {
                const ext = guessFileExtFromUrl(outUrl, '.png')
                mediaPath = await downloadToOpenclaw(
                    outUrl,
                    `image_task_${taskId}${ext}`,
                )
            }

            const status = final?.data?.status || 'unknown'
            const progress =
                typeof final?.data?.progress === 'number'
                    ? `${final.data.progress}%`
                    : '?%'
            const priceLines = cost
                ? formatImageSummaryPriceLines(cost, { markdown: true })
                : []

            console.log('\n这任务已完成：\n')
            console.log(`**任务状态:** ${status} (${progress})`)
            console.log(`**任务ID:** \`${taskId}\``)
            console.log(`**结果URL:** ${outUrl}`)
            console.log(`**尺寸:** ${resolution} 分辨率`)
            for (const line of priceLines) {
                console.log(line)
            }

            const balanceLines = await getTokenBalanceLines({ markdown: true })
            if (balanceLines.length) {
                for (const line of balanceLines) {
                    console.log(line)
                }
            } else {
                console.log('**当前账户余额:** unknown')
            }

            if (mediaPath) console.log(`\nMEDIA: ${mediaPath}`)
        } else {
            console.log(JSON.stringify(final, null, 2))
        }
        return
    }

    usageAndExit(1)
}

main().catch((err) => {
    console.error(err?.stack || String(err))
    process.exit(1)
})
