import "dotenv/config";
import { generateVideo } from "../src/tools/video.js";

interface CliOptions {
  model?: string;
  prompt: string;
  inputReference?: string;
  size?: string;
  hd: boolean;
  watermark: boolean;
  seconds?: "4" | "8" | "12";
  privateMode: boolean;
  style?: string;
  storyboard: boolean;
  characterCreate: boolean;
  characterFromTask?: string;
  characterTimestamps?: string;
  characterUrl?: string;
  json: boolean;
}

function printUsage(): void {
  console.log(`用法:
  pnpm exec tsx scripts/test-generate-video.ts --prompt "镜头描述" [--model sora-2-reverse] [--input-reference "https://..."] [--size 1280x720] [--seconds 4] [--hd] [--watermark] [--json]

示例:
  pnpm exec tsx scripts/test-generate-video.ts \
    --model "sora-2-reverse" \
    --prompt "A young woman slowly turns her head and smiles, cinematic soft light, medium close-up" \
    --input-reference "https://example.com/reference.png" \
    --size 1280x720 \
    --seconds 4 \
    --style anime

参数:
  --model    可选，模型名称，例如 sora-2-reverse / sora-2-pro-reverse
  --prompt   必填，视频生成提示词
  --input-reference 可选，参考图 URL 或 base64
  --size     可选，视频尺寸，例如 1280x720 / 720x1280 / 1024x1792 / 1792x1024
  --hd       可选，开启高清视频
  --watermark 可选，保留水印
  --seconds  可选，仅支持 4 / 8 / 12
  --private  可选，开启隐私模式
  --style    可选，thanksgiving / comic / news / selfie / nostalgic / anime
  --storyboard 可选，启用故事板模式
  --character-create 可选，生成完成后自动创建角色
  --character-from-task 可选，根据已有任务 ID 创建角色
  --character-timestamps 可选，格式 start,end，例如 0,3
  --character-url 可选，角色视频 URL 或 base64
  --json     可选，以 JSON 形式输出结果
  --help     查看帮助
`);
}

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} 缺少参数值`);
  }
  return value;
}

function parseSeconds(raw?: string): "4" | "8" | "12" | undefined {
  if (!raw) return undefined;
  if (raw === "4" || raw === "8" || raw === "12") {
    return raw;
  }
  throw new Error(`--seconds 仅支持 4 / 8 / 12，收到: ${raw}`);
}

function parseStyle(raw?: string): string | undefined {
  if (!raw) return undefined;
  const validStyles = new Set(["thanksgiving", "comic", "news", "selfie", "nostalgic", "anime"]);
  if (validStyles.has(raw)) {
    return raw;
  }
  throw new Error(`--style 仅支持 thanksgiving / comic / news / selfie / nostalgic / anime，收到: ${raw}`);
}

function parseCliArgs(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const prompt = getArgValue(argv, "--prompt")?.trim();
  if (!prompt) {
    printUsage();
    throw new Error("缺少必填参数 --prompt");
  }

  return {
    model: getArgValue(argv, "--model")?.trim(),
    prompt,
    inputReference: getArgValue(argv, "--input-reference")?.trim(),
    size: getArgValue(argv, "--size")?.trim(),
    hd: argv.includes("--hd"),
    watermark: argv.includes("--watermark"),
    seconds: parseSeconds(getArgValue(argv, "--seconds")),
    privateMode: argv.includes("--private"),
    style: parseStyle(getArgValue(argv, "--style")?.trim()),
    storyboard: argv.includes("--storyboard"),
    characterCreate: argv.includes("--character-create"),
    characterFromTask: getArgValue(argv, "--character-from-task")?.trim(),
    characterTimestamps: getArgValue(argv, "--character-timestamps")?.trim(),
    characterUrl: getArgValue(argv, "--character-url")?.trim(),
    json: argv.includes("--json"),
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  console.log("[video-tool-test] 开始调用 generateVideo 工具...");
  console.log("[video-tool-test] 入参:", {
    model: options.model ?? "default",
    promptLength: options.prompt.length,
    hasInputReference: Boolean(options.inputReference),
    size: options.size ?? "default",
    hd: options.hd,
    watermark: options.watermark,
    seconds: options.seconds ?? "default",
    privateMode: options.privateMode,
    style: options.style ?? "default",
    storyboard: options.storyboard,
    characterCreate: options.characterCreate,
  });

  const execute = generateVideo.execute;
  if (typeof execute !== "function") {
    throw new Error("generateVideo 工具未暴露 execute 方法");
  }

  const result = await execute({
    model: options.model,
    prompt: options.prompt,
    input_reference: options.inputReference
      ? { image_url: options.inputReference }
      : undefined,
    size: options.size,
    hd: options.hd,
    watermark: options.watermark,
    seconds: options.seconds,
    private: options.privateMode,
    style: options.style,
    storyboard: options.storyboard,
    character_create: options.characterCreate,
    character_from_task: options.characterFromTask,
    character_timestamps: options.characterTimestamps,
    character_url: options.characterUrl,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("[video-tool-test] 调用结果:");
  console.dir(result, { depth: null, colors: true });

  const typedResult = result as { error?: string; videos?: string[]; taskId?: string; model?: string };
  if (typedResult.error) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[video-tool-test] 执行失败:", message);
  process.exitCode = 1;
});