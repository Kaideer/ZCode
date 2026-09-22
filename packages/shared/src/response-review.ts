import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

/**
 * 回复审核 Response Review 模式：
 * - append：流式先行 + 审核追加，主回复收口后异步审核并追加卡片；
 * - regenerate：审核-重生成循环，审核不通过则同轮续写修正，受轮次上限约束。
 */
export const responseReviewModeSchema = z.enum(["append", "regenerate"]);
export type ResponseReviewMode = z.infer<typeof responseReviewModeSchema>;

/** regenerate 模式默认的同轮续写轮次上限；达到上限后无条件放行收口。 */
export const DEFAULT_RESPONSE_REVIEW_MAX_ROUNDS = 2;

/** 单次审核调用的默认超时；超时按审核失败处理（失败不阻塞主流程）。 */
export const DEFAULT_RESPONSE_REVIEW_TIMEOUT_MS = 60_000;

/** regenerate 模式允许的最大轮次上限配置值，防止用户侧配置失控。 */
export const MAX_RESPONSE_REVIEW_MAX_ROUNDS = 5;

/**
 * 下发到 agent runtime 的回复审核配置；宿主（services）与 CLI 共用的单一事实源。
 * modelSelection 缺省时，审核调用跟随会话主模型及其当前 reasoningLevel。
 */
export const responseReviewConfigSchema = z
  .object({
    enabled: z.boolean(),
    mode: responseReviewModeSchema,
    modelSelection: modelSelectionSchema.optional(),
    maxRounds: z.number().int().positive().max(MAX_RESPONSE_REVIEW_MAX_ROUNDS),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ResponseReviewConfig = z.infer<typeof responseReviewConfigSchema>;

/**
 * 设置层（写入路径）的审核模型选择表示：
 * followSession 变体是「跟随会话主模型」的显式哨兵——RPC 传输会吞 undefined，
 * 设置页选择跟随时以此表达清除语义，落盘前由 normalizeSettingsPatch 归一为 undefined。
 */
export const responseReviewModelSelectionSettingSchema = z.union([
  z.object({ followSession: z.literal(true) }).strict(),
  modelSelectionSchema,
]);
export type ResponseReviewModelSelectionSetting = z.infer<
  typeof responseReviewModelSelectionSettingSchema
>;
