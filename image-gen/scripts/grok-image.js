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

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_URL = 'https://api.apimart.ai';
const API_KEY =
  process.env.APIMART_API_KEY ||
  (process.argv.find((arg) => arg.startsWith('--key='))?.split('=')[1] || '');

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const LOCAL_PRICING_PATH = path.resolve(__dirname, '..', 'apimart_pricing.json');
const TASK_META_PATH = path.join(OPENCLAW_DIR, 'apimart_task_meta.json');


function formatNumberTrim(n, { maxDecimals = 3 } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v
    .toFixed(maxDecimals)
    .replace(/\.0+$/, '')
    .replace(/(\.[0-9]*?)0+$/, '$1');
}

function formatUsd(n, { decimals = 2, trim = false } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const s = trim ? formatNumberTrim(v, { maxDecimals: decimals }) : v.toFixed(decimals);
  return `$${s}`;
}

function guessFileExtFromUrl(u, fallbackExt) {
  try {
    const url = new URL(u);
    const p = url.pathname.toLowerCase();
    const m = p.match(/\.(png|jpe?g|webp|gif)$/);
    if (m) return `.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  } catch {
    // ignore
  }
  return fallbackExt;
}

function formatFileSize(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return null;
  const kb = b / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${Number(mb.toFixed(1))} MB`;
}

function formatSizeLabel(size) {
  if (!size) return null;
  const s = String(size);
  if (s === '1:1') return `${s} 正方形`;
  if (s === '16:9') return `${s} 横屏`;
  if (s === '9:16') return `${s} 竖屏`;
  return s;
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function loadPricing() {
  // Pricing is stored with the skill (no global pricing file).
  return readJsonFile(LOCAL_PRICING_PATH);
}

function usageAndExit(code = 1) {
  console.error(
    [
      'Usage:',
      '  generate --prompt <text> [--size 1:1|16:9|9:16|3:2|2:3] [--n 1-4] [--resolution 1K|2K|4K] [--model gemini-3-pro-image-preview]',
      '  edit --image <localPathOrUrl> --prompt <text> [--n 1-4] [--resolution 1K|2K|4K] [--model gemini-3-pro-image-preview]',
      '  upload --file <localPath>',
      '  task --id <task_id> [--language zh|en|ko|ja]',
      '  (generate/edit default: start cron watcher; disable with --watch=false)',
      '',
      'Env:',
      '  APIMART_API_KEY',
      '',
      'Pricing config:',
      `  ${LOCAL_PRICING_PATH}`,
    ].join('\n')
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v = 'true'] = a.slice(2).split('=');
      args[k] = v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function runOpenclaw(args) {
  const res = spawnSync('openclaw', args, { encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || '').trim();
    throw new Error(msg || `openclaw exited with code ${res.status}`);
  }
  return (res.stdout || '').trim();
}

function openclawAvailable() {
  try {
    const res = spawnSync('openclaw', ['--version'], { encoding: 'utf8' });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

function extractCronJobId(jsonText) {
  try {
    const obj = JSON.parse(jsonText);
    if (typeof obj?.id === 'string') return obj.id;
    if (typeof obj?.job?.id === 'string') return obj.job.id;
    if (typeof obj?.data?.id === 'string') return obj.data.id;
  } catch {
    // ignore
  }
  return null;
}

function buildCronWatchMessage({ taskId, jobId, language, maxMinutes = 5 }) {
  const lang = language || 'zh';
  const maxAttempts = Math.max(1, Math.floor((maxMinutes * 60) / 10));
  return [
    `你是一个定时任务轮询器（cron_job_id=${jobId}）。`,
    '目标：每 10 秒查询一次 APIMart 任务状态，并把结果回传到当前会话。',
    '',
    `任务参数：task_id=${taskId} language=${lang}`,
    '',
    '每次运行请严格执行：',
    `1) 调用 GET /v1/tasks/${taskId}?language=${lang}`,
    '2) 输出一行：task_id=<...> status=<...> progress=<...>',
    '3) 若 status=completed：再输出 result_url=<...>，然后执行命令禁用自己：',
    `   openclaw cron disable ${jobId}`,
    '4) 若 status=failed/cancelled：输出 fail_reason（若有），然后禁用自己：',
    `   openclaw cron disable ${jobId}`,
    `5) 若你发现已经运行超过 ${maxAttempts} 次（约 ${maxMinutes} 分钟）仍未结束：输出超时提示，然后禁用自己：`,
    `   openclaw cron disable ${jobId}`,
  ].join('\n');
}

function createCronWatcher({ taskId, language }) {
  if (!openclawAvailable()) return null;

  // Two-phase create: add disabled -> edit message (inject jobId) -> enable.
  const name = `apimart-image-watch-${taskId}`;
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
    'isolated',
    '--timeout-seconds',
    '25',
    '--thinking',
    'minimal',
    '--light-context',
    '--name',
    name,
    '--message',
    'init',
    '--json',
  ]);

  const jobId = extractCronJobId(addOut);
  if (!jobId) throw new Error(`Failed to parse cron job id: ${addOut}`);

  const msg = buildCronWatchMessage({ taskId, jobId, language });
  runOpenclaw(['cron', 'edit', jobId, '--message', msg]);
  runOpenclaw(['cron', 'enable', jobId]);

  // Safety stop: disable the watcher after ~6 minutes to avoid runaway jobs.
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
    ]);
  } catch {
    // Best-effort only.
  }

  return jobId;
}

async function fetchJson(url, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return data;
}

async function getTokenBalance() {
  // Balance endpoint (uses the same API key as generation).
  // User requirement: call GET /v1/user/balance
  return fetchJson(`${BASE_URL}/v1/user/balance`, { method: 'GET' });
}

async function logTokenBalance() {
  try {
    const data = await getTokenBalance();
    if (data?.success) {
      if (data?.unlimited_quota) {
        console.log('当前账户余额: unlimited');
      } else {
        if (typeof data?.remain_balance === 'number') {
          const usd = formatUsd(data.remain_balance, { decimals: 3, trim: true });
          if (usd) console.log(`当前账户余额: ${usd} USD`);
        }
      }
      return;
    }
    const msg = data?.message ? String(data.message) : 'unknown error';
    console.warn(`token_balance_error=${msg}`);
  } catch (e) {
    console.warn(`token_balance_error=${e?.message || String(e)}`);
  }
}

async function getTokenBalanceLine() {
  try {
    const data = await getTokenBalance();
    if (!data?.success) return null;
    if (data?.unlimited_quota) return '当前账户余额: unlimited';
    if (typeof data?.remain_balance !== 'number') return null;
    const usd = formatUsd(data.remain_balance, { decimals: 3, trim: true });
    return usd ? `当前账户余额: ${usd} USD` : null;
  } catch {
    return null;
  }
}

async function uploadImage(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }

  const buf = fs.readFileSync(abs);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(abs));

  const data = await fetchJson(`${BASE_URL}/v1/uploads/images`, {
    method: 'POST',
    body: form,
  });

  if (!data?.url) {
    throw new Error(`Unexpected upload response: ${JSON.stringify(data)}`);
  }
  return data.url;
}

function loadTaskMeta() {
  try {
    if (!fs.existsSync(TASK_META_PATH)) return {};
    const raw = fs.readFileSync(TASK_META_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveTaskMeta(metaMap) {
  const dir = path.dirname(TASK_META_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TASK_META_PATH, JSON.stringify(metaMap, null, 2));
}

function estimateImageCostUsd({ model, resolution, n }) {
  const pricing = loadPricing();
  const unit = pricing?.image?.models?.[model]?.unit_price_usd?.[resolution];
  if (typeof unit !== 'number') return null;
  const total = unit * n;
  return {
    unit_usd: unit,
    total_usd: total,
  };
}

function formatImagePriceLine(cost) {
  if (!cost || typeof cost.total_usd !== 'number' || typeof cost.unit_usd !== 'number') return null;
  const usdText = formatUsd(cost.total_usd, { decimals: 2 });
  if (!usdText) return null;
  return `${usdText} USD`;
}

async function submitGeneration({ model, prompt, size, n, resolution, imageUrls }) {
  const payload = {
    model,
    prompt,
    ...(size ? { size } : {}),
    ...(n ? { n: Number(n) } : {}),
    ...(resolution ? { resolution } : {}),
    ...(imageUrls && imageUrls.length ? { image_urls: imageUrls } : {}),
  };

  const data = await fetchJson(`${BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const taskId = data?.data?.[0]?.task_id;
  if (!taskId) {
    throw new Error(`Unexpected generation response: ${JSON.stringify(data)}`);
  }

  // Persist task meta so later manual queries can show cost.
  const metaMap = loadTaskMeta();
  const cost = estimateImageCostUsd({ model, resolution: resolution || '1K', n: Number(n) || 1 });
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
  };
  saveTaskMeta(metaMap);

  return taskId;
}

async function getTask(taskId, language = 'en') {
  const url = new URL(`${BASE_URL}/v1/tasks/${encodeURIComponent(taskId)}`);
  if (language) url.searchParams.set('language', language);
  return fetchJson(url.toString(), { method: 'GET' });
}

function pickFirstImageUrl(taskResp) {
  const urls = taskResp?.data?.result?.images?.[0]?.url;
  if (Array.isArray(urls) && urls.length > 0) return urls[0];
  return null;
}

async function waitForTask(taskId, { intervalMs = 2000, timeoutMs = 5 * 60 * 1000, language = 'en' } = {}) {
  const start = Date.now();
  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Task timeout after ${timeoutMs}ms: ${taskId}`);
    }

    let data;
    try {
      data = await getTask(taskId, language);
    } catch (e) {
      // Network/transient failure: keep polling until timeout.
      console.warn(`task=${taskId} poll_error=${e?.message || String(e)}`);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const status = data?.data?.status || 'unknown';
    const progress = data?.data?.progress;
    const progressText = typeof progress === 'number' ? `${progress}%` : '?';
    console.log(`task=${taskId} status=${status} progress=${progressText}`);

    if (status === 'completed') return data;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`Task ${status}: ${JSON.stringify(data)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function downloadToOpenclaw(url, { fileNameHint = 'generated_image.png' } = {}) {
  const dir = path.join(os.homedir(), '.openclaw');
  fs.mkdirSync(dir, { recursive: true });

  const outPath = path.join(dir, fileNameHint);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  fs.writeFileSync(outPath, Buffer.from(ab));
  return outPath;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd) usageAndExit(1);
  if (!API_KEY) {
    console.error('Error: missing API key. Please set APIMART_API_KEY, or pass --key=...');
    process.exit(1);
  }

  if (cmd === 'upload') {
    const file = args.file;
    if (!file) usageAndExit(1);
    const url = await uploadImage(file);
    console.log(url);
    return;
  }

  if (cmd === 'task') {
    const id = args.id;
    if (!id) usageAndExit(1);
    const language = args.language || 'en';
    const data = await getTask(id, language);

    const meta = loadTaskMeta()[id];
    if (meta?.estimated_cost_usd != null) {
      const priceText = formatImagePriceLine({
        total_usd: meta.estimated_cost_usd,
        unit_usd: meta.unit_price_usd,
      });
      if (priceText) console.log(`本次价格: ${priceText}`);
    }

    // Also show current token balance for this API key.
    const bal = await getTokenBalanceLine();
    if (bal) console.log(bal);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'generate') {
    const prompt = args.prompt;
    if (!prompt) usageAndExit(1);

    const model = args.model || 'gemini-3-pro-image-preview';
    const size = args.size || '1:1';
    const n = Number(args.n || 1);
    const resolution = args.resolution || '1K';

    const cost = estimateImageCostUsd({ model, resolution, n });
    if (cost) {
      const priceText = formatImagePriceLine(cost);
      if (priceText) console.log(`本次价格: ${priceText}`);
    }

    // Must query balance before submitting generation.
    await getTokenBalanceLine();
    const taskId = await submitGeneration({ model, prompt, size, n, resolution });
    console.log(`submitted task_id=${taskId}`);

    // Start a cron-based watcher that pushes progress to the last chat.
    // This is best-effort: if it fails, local polling still works.
    const watchEnabled = args.watch == null ? true : args.watch !== 'false';
    if (watchEnabled) {
      try {
        const jobId = createCronWatcher({ taskId, language: args.language || 'zh' });
        if (jobId) console.log(`cron_job_id=${jobId}`);
      } catch (e) {
        console.warn(`cron_watch_error=${e?.message || String(e)}`);
      }
    }

    const final = await waitForTask(taskId, { language: args.language || 'en' });
    const imageUrl = pickFirstImageUrl(final);
    if (imageUrl) {
      const ext = guessFileExtFromUrl(imageUrl, '.png');
      const out = await downloadToOpenclaw(imageUrl, { fileNameHint: `image_task_${taskId}${ext}` });

      let fileSizeText = null;
      try {
        const st = fs.statSync(out);
        fileSizeText = formatFileSize(st.size);
      } catch {
        // ignore
      }

      const status = final?.data?.status || 'unknown';
      const progress = typeof final?.data?.progress === 'number' ? `${final.data.progress}%` : '?%';
      const priceText = cost ? formatImagePriceLine(cost) : null;
      const sizeLabel = formatSizeLabel(size);

      console.log('\n这任务已完成，图片已下载：\n');
      console.log(`**任务状态:** ${status} (${progress})`);
      console.log(`**任务ID:** \`${taskId}\``);
      console.log(`**文件路径:** \`${out}\``);
      if (fileSizeText) console.log(`**文件大小:** ${fileSizeText}`);
      if (sizeLabel) console.log(`**尺寸:** ${sizeLabel}，${resolution} 分辨率`);
      else console.log(`**尺寸:** ${resolution} 分辨率`);
      if (priceText) console.log(`**本次价格:** ${priceText}`);

      const bal = await getTokenBalanceLine();
      if (bal) {
        const m = String(bal).match(/^当前账户余额:\s*(.*)$/);
        console.log(`**当前账户余额:** ${m ? m[1] : bal}`);
      } else {
        console.log('**当前账户余额:** unknown');
      }

      console.log(`\nMEDIA: ${out}`);
    } else {
      console.log(JSON.stringify(final, null, 2));
    }
    return;
  }

  if (cmd === 'edit') {
    const prompt = args.prompt;
    const image = args.image;
    if (!prompt || !image) usageAndExit(1);

    let imageUrl = image;
    if (!/^https?:\/\//i.test(image)) {
      imageUrl = await uploadImage(image);
      console.log(`uploaded_image_url=${imageUrl}`);
    }

    const model = args.model || 'gemini-3-pro-image-preview';
    const n = Number(args.n || 1);
    const resolution = args.resolution || '1K';

    const cost = estimateImageCostUsd({ model, resolution, n });
    if (cost) {
      const priceText = formatImagePriceLine(cost);
      if (priceText) console.log(`本次价格: ${priceText}`);
    }

    // Must query balance before submitting generation.
    await getTokenBalanceLine();
    const taskId = await submitGeneration({ model, prompt, n, resolution, imageUrls: [imageUrl] });
    console.log(`submitted task_id=${taskId}`);

    const watchEnabled = args.watch == null ? true : args.watch !== 'false';
    if (watchEnabled) {
      try {
        const jobId = createCronWatcher({ taskId, language: args.language || 'zh' });
        if (jobId) console.log(`cron_job_id=${jobId}`);
      } catch (e) {
        console.warn(`cron_watch_error=${e?.message || String(e)}`);
      }
    }

    const final = await waitForTask(taskId, { language: args.language || 'en' });
    const outUrl = pickFirstImageUrl(final);
    if (outUrl) {
      const ext = guessFileExtFromUrl(outUrl, '.png');
      const out = await downloadToOpenclaw(outUrl, { fileNameHint: `image_task_${taskId}${ext}` });

      let fileSizeText = null;
      try {
        const st = fs.statSync(out);
        fileSizeText = formatFileSize(st.size);
      } catch {
        // ignore
      }

      const status = final?.data?.status || 'unknown';
      const progress = typeof final?.data?.progress === 'number' ? `${final.data.progress}%` : '?%';
      const priceText = cost ? formatImagePriceLine(cost) : null;

      console.log('\n这任务已完成，图片已下载：\n');
      console.log(`**任务状态:** ${status} (${progress})`);
      console.log(`**任务ID:** \`${taskId}\``);
      console.log(`**文件路径:** \`${out}\``);
      if (fileSizeText) console.log(`**文件大小:** ${fileSizeText}`);
      console.log(`**尺寸:** ${resolution} 分辨率`);
      if (priceText) console.log(`**本次价格:** ${priceText}`);

      const bal = await getTokenBalanceLine();
      if (bal) {
        const m = String(bal).match(/^当前账户余额:\s*(.*)$/);
        console.log(`**当前账户余额:** ${m ? m[1] : bal}`);
      } else {
        console.log('**当前账户余额:** unknown');
      }

      console.log(`\nMEDIA: ${out}`);
    } else {
      console.log(JSON.stringify(final, null, 2));
    }
    return;
  }

  usageAndExit(1);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
