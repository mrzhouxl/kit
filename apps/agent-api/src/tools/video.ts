/**
 * tools/video.ts — 视频生成工具
 *
 * generateVideo: 调用 Sora/Grok 视频模型生成视频，返回视频 URL。
 */
import { tool } from "ai";
import { z } from "zod";
import { extractUserIdFromAuthorizationHeader } from "../auth/jwt.js";
import {
  assertVideoGenerationAllowed,
  recordVideoGenerationAttempt,
} from "../billing/token-usage.service.js";
import { videoConfig } from "../config.js";
import {
  getRequestJwtToken,
  getRequestSessionKey,
  getRequestThreadId,
} from "../context/request-context.js";
import { sandboxEvents } from "../sandbox/index.js";
import { createVideoViaOpenApi, type VideoTaskResult } from "../video/video-api.js";

const soraStyleSchema = z.enum([
  "thanksgiving",
  "comic",
  "news",
  "selfie",
  "nostalgic",
  "anime",
]);

function emitVideoStatus(status: VideoTaskResult): void {
  const sessionKey = getRequestSessionKey();
  const threadId = getRequestThreadId();

  sandboxEvents.emit("event", {
    sessionKey: sessionKey ?? "",
    userId: "",
    threadId: threadId ?? "",
    event: {
      type: "video_status",
      taskId: status.taskId,
      status: status.status,
      rawStatus: status.rawStatus,
      progress: status.progress,
      size: status.size,
      model: status.model,
      seconds: status.seconds,
      createdAt: status.createdAt,
      url: status.url,
      error: status.error,
    },
  });
}

export const generateVideo = tool({
  description:
    "根据文字描述生成视频，支持传入单张参考图 URL 或 Base64，返回可播放的视频 URL。适合镜头动画、角色演出、场景运镜、短片概念验证等需求。",
  inputSchema: z.object({
    model: z
      .string()
      .optional()
      .describe("视频模型名称，默认使用 VIDEO_MODEL，例如 sora-2-reverse 或 sora-2-pro-reverse。"),
    prompt: z
      .string()
      .max(1500)
      .describe("视频生成提示词，建议描述主体、动作、镜头、光线、风格与时长。"),
    input_reference: z
      .object({
        image_url: z.string().min(1).describe("参考图 URL 或 base64 字符串。"),
      })
      .optional()
      .describe("参考图对象，Sora 逆向接口使用 input_reference.image_url。"),
    image: z
      .string()
      .optional()
      .describe("参考图别名，传入后会自动转换为 input_reference.image_url。"),
    size: z
      .string()
      .optional()
      .describe("视频尺寸，格式为宽x高，例如 1280x720、720x1280、1024x1792、1792x1024。"),
    hd: z
      .boolean()
      .optional()
      .describe("是否生成高清视频。通常与 sora-2-pro-reverse 配合使用。"),
    watermark: z
      .boolean()
      .optional()
      .describe("是否保留视频水印。"),
    seconds: z
      .enum(["4", "8", "12"])
      .optional()
      .describe("视频时长，当前支持 4、8、12 秒。"),
    private: z
      .boolean()
      .optional()
      .describe("是否开启隐私模式。"),
    style: soraStyleSchema
      .optional()
      .describe("视频风格，例如 comic、anime、news、nostalgic 等。"),
    storyboard: z
      .boolean()
      .optional()
      .describe("是否启用故事板模式。"),
    character_create: z
      .boolean()
      .optional()
      .describe("生成完成后是否自动创建角色。"),
    character_from_task: z
      .string()
      .optional()
      .describe("根据已有任务 ID 创建角色。"),
    character_timestamps: z
      .string()
      .optional()
      .describe("角色出现时间范围，格式为 start,end，例如 0,3。"),
    character_url: z
      .string()
      .optional()
      .describe("创建角色需要的视频 URL 或 Base64。"),
  }),
  execute: async ({
    model,
    prompt,
    input_reference,
    image,
    size,
    hd,
    watermark,
    seconds,
    private: privateMode,
    style,
    storyboard,
    character_create,
    character_from_task,
    character_timestamps,
    character_url,
  }) => {
    const targetModel = model?.trim() || videoConfig.model;
    const threadId = getRequestThreadId();
    const jwtToken = getRequestJwtToken();
    try {
      const userId = jwtToken ? extractUserIdFromAuthorizationHeader(jwtToken) : undefined;
      await assertVideoGenerationAllowed(userId);
      await recordVideoGenerationAttempt({
        userId,
        threadId,
        model: targetModel,
        metadata: {
          type: "video_generation",
          size,
          seconds,
          hasReferenceImage: Boolean(input_reference?.image_url || image),
        },
      });

      const result = await createVideoViaOpenApi({
        prompt,
        model: targetModel,
        input_reference: input_reference ?? (image ? { image_url: image } : undefined),
        size,
        hd,
        watermark,
        seconds,
        private: privateMode,
        style,
        storyboard,
        character_create,
        character_from_task,
        character_timestamps,
        character_url,
      }, undefined, {
        onStatus: (status) => {
          emitVideoStatus(status);
        },
      });

      return {
        taskId: result.taskId,
        videos: [result.url],
        model: targetModel,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[video-tool] generate failed", message);
      return {
        error: `视频生成失败: ${message}`,
        prompt,
        model: targetModel,
      };
    }
  },
});