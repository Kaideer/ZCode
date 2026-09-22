import {
  SessionEventType,
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  MessageId,
  ModelInputMessage,
  ModelSelection,
  SessionEvent,
  TraceContext,
  TurnId,
} from "../deps.js";
import type { AgentTelemetryCausation } from "@zcode/contracts";
import type { ResponseReviewMode } from "@zcode/shared";
import { DEFAULT_RESPONSE_REVIEW_TIMEOUT_MS } from "@zcode/shared";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { createRuntimeModel } from "./runtime-model.js";
import { cloneModelSelection } from "../model-selection.js";

export const RESPONSE_REVIEW_QUERY_SOURCE = "response_review";

/** 待审结论的最大入参长度；超长截断，避免审核调用成本随回复长度失控。 */
const MAX_REVIEW_INPUT_CHARS = 12_000;
/** 审核输出预算上限；审核意见只需结论 + 依据，不需要长文。 */
const MAX_REVIEW_OUTPUT_TOKENS = 8_000;

// 审核 system prompt：固定评审维度并要求结构化 JSON 输出；
// 不通过必须引用原文依据，防止幻觉式批评；feedback 跟随被审内容语言。
const RESPONSE_REVIEW_SYSTEM_PROMPT = `You are a rigorous independent reviewer of an AI assistant's reply.

Review the assistant's conclusion carried by the user message on these dimensions:
1. Factual accuracy
2. Logical consistency
3. Completeness relative to the user's request
4. Instruction compliance

Rules:
- Return verdict "pass" only when there is no material problem.
- Return verdict "issues" when a material problem exists; the feedback must cite the exact sentences being criticized.
- Never invent problems; a sound conclusion must be passed.
- Write the feedback in the same language as the reviewed content; keep it concise and actionable.
- Do not answer the original user request yourself; only review.

Return exactly one valid JSON object with no surrounding text:
{"verdict":"pass"|"issues","feedback":"..."}`;

export interface ResponseReviewOutcome {
  outcome: "pass" | "issues";
  body: string;
  modelSelection: ModelSelection;
}

/**
 * 执行一次回复审核 Response Review。
 * 零历史污染：独立 messages + tools 为空，只 append 审核生命周期事件与 Model 用量事件。
 * 失败语义：任何异常/不可解析都归一为 AssistantReview failed 事件并返回 null，
 * 不向上抛出——审核是增强不是门禁，绝不能阻塞主流程。
 */
export async function runResponseReview(
  this: AgentRuntimeInternal,
  input: {
    assistantText: string;
    mode: ResponseReviewMode;
    round: number;
    traceContext: TraceContext;
    anchorAssistantMessageId?: MessageId;
    anchorTurnId?: TurnId;
    /** regenerate 模式传入轮 abort 信号，审核随用户 Stop 一并中断。 */
    abortSignal?: AbortSignal;
    causation?: AgentTelemetryCausation;
  },
): Promise<ResponseReviewOutcome | null> {
  const reviewTelemetry = this.agentTelemetry.detached({
    causation: input.causation,
    executionKind: input.mode === "append" ? "background" : "foreground",
    operation: "response_review",
    targetKind: "other",
    trigger: "turn",
    traceContext: input.traceContext,
  });
  return reviewTelemetry.run(async () => {
    const result = await runResponseReviewImpl.call(this, input);
    reviewTelemetry.setResultType(result ? "metadata" : "other");
    reviewTelemetry.finishCompleted();
    return result;
  });
}

async function runResponseReviewImpl(
  this: AgentRuntimeInternal,
  input: {
    assistantText: string;
    mode: ResponseReviewMode;
    round: number;
    traceContext: TraceContext;
    anchorAssistantMessageId?: MessageId;
    anchorTurnId?: TurnId;
    abortSignal?: AbortSignal;
  },
): Promise<ResponseReviewOutcome | null> {
  // 审核模型解析：用户显式配置优先，缺省跟随会话当前模型与 reasoningLevel。
  const requestedModelSelection =
    this.config.responseReview?.modelSelection ?? this.getSessionModelSelection();
  if (!requestedModelSelection) return null;
  const reviewId = `review_${crypto.randomUUID()}`;
  const baseModel = createRuntimeModel(this, { selection: requestedModelSelection });
  // 尊重用户配置的思考强度；未配置时回落到所选模型的最低公开档。
  // 不复用 auxiliaryModelOptions——它会强制压掉用户配置的 reasoningLevel。
  const reasoningLevel =
    requestedModelSelection.options?.reasoningLevel ??
    baseModel.optionSpecs.reasoningLevel.values[0]!;
  const model = baseModel.bind({
    reasoningLevel,
    maxOutputTokens: Math.min(MAX_REVIEW_OUTPUT_TOKENS, baseModel.optionSpecs.maxOutputTokens.max),
  });
  const modelSelection = cloneModelSelection(requestedModelSelection);
  const modelTraceContext = createChildTraceContext(input.traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: RESPONSE_REVIEW_QUERY_SOURCE,
      responseReviewId: reviewId,
      responseReviewRound: input.round,
    },
  });

  const lifecycleBase = {
    reviewId,
    mode: input.mode,
    round: input.round,
    ...(input.anchorAssistantMessageId
      ? { anchorAssistantMessageId: input.anchorAssistantMessageId }
      : {}),
    ...(input.anchorTurnId ? { anchorTurnId: input.anchorTurnId } : {}),
  };
  await this.appendEvent(
    this.createEvent(
      SessionEventType.AssistantReview,
      { ...lifecycleBase, status: "started", reviewerModelSelection: modelSelection },
      modelTraceContext,
    ),
    modelTraceContext,
  );

  const events: SessionEvent[] = [];
  const messages = buildReviewMessages(input.assistantText);
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: RESPONSE_REVIEW_QUERY_SOURCE,
      toolCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  events.push(modelRequestEvent);
  const networkEventStartIndex = events.length;
  // regenerate 模式级联轮 abort：用户 Stop 时审核一并中断，按失败放行。
  const timeoutSignal = AbortSignal.timeout(positiveTimeoutMs(this.config.responseReview?.timeoutMs));
  const reviewAbortSignal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, timeoutSignal])
    : timeoutSignal;
  const modelStartedAt = Date.now();
  const invocationContext = {
    metadata: traceContextToLogContext(modelTraceContext),
    modelRequestSessionType: "other" as const,
    modelCall: {
      operation: "response_review" as const,
      reasoning: { requestedLevel: model.options.reasoningLevel },
    },
    statusSink: this.createModelStatusSink(modelTraceContext, events),
    traceContext: modelTraceContext,
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
      abortSignal: reviewAbortSignal,
      model,
      traceContext: modelTraceContext,
    }),
  };

  const result = await runWithModelInvocationContext(invocationContext, () =>
    model.generateText({ abortSignal: reviewAbortSignal, messages, tools: [] }),
  ).catch(async (error: unknown) => {
    await recordModelUsageFact(this, {
      error,
      events,
      model,
      networkEventStartIndex,
      querySource: RESPONSE_REVIEW_QUERY_SOURCE,
      startedAt: modelStartedAt,
      status: "error",
      traceContext: modelTraceContext,
    });
    return null;
  });
  if (!result) {
    await this.appendEvent(
      this.createEvent(
        SessionEventType.AssistantReview,
        { ...lifecycleBase, status: "failed", reason: "model_call_failed" },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return null;
  }

  const toolCalls = this.extractToolCallsFromResult(result);
  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: result.text,
      querySource: RESPONSE_REVIEW_QUERY_SOURCE,
      stopReason: result.finishReason,
      toolCallCount: toolCalls.length,
      usage: result.usage,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  events.push(modelCompleteEvent);
  await recordModelUsageFact(this, {
    events,
    model,
    networkEventStartIndex,
    querySource: RESPONSE_REVIEW_QUERY_SOURCE,
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
    traceContext: modelTraceContext,
  });

  const verdict = parseReviewVerdict(result.text);
  if (!verdict) {
    this.logger?.debug("Response review skipped", {
      ...traceContextToLogContext(modelTraceContext),
      event: "response_review.unparseable",
      module: "core.runtime",
    });
    await this.appendEvent(
      this.createEvent(
        SessionEventType.AssistantReview,
        { ...lifecycleBase, status: "failed", reason: "unparseable" },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return null;
  }

  await this.appendEvent(
    this.createEvent(
      SessionEventType.AssistantReview,
      {
        ...lifecycleBase,
        status: "completed",
        outcome: verdict.outcome,
        body: verdict.feedback,
      },
      modelTraceContext,
    ),
    modelTraceContext,
  );
  return { outcome: verdict.outcome, body: verdict.feedback, modelSelection };
}

function buildReviewMessages(assistantText: string): ModelInputMessage[] {
  const normalized = assistantText.trim();
  const clipped =
    normalized.length > MAX_REVIEW_INPUT_CHARS
      ? normalized.slice(0, MAX_REVIEW_INPUT_CHARS)
      : normalized;
  return [
    { role: "system", content: RESPONSE_REVIEW_SYSTEM_PROMPT },
    { role: "user", content: clipped },
  ];
}

/** 解析审核输出；接受裸 JSON 与 Markdown fenced JSON 两种形态，去 thinking 段。 */
function parseReviewVerdict(
  raw: string,
): { outcome: "pass" | "issues"; feedback: string } | null {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const candidates = [withoutThinking, extractFencedJson(withoutThinking)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const verdict = (parsed as { verdict?: unknown }).verdict;
      if (verdict !== "pass" && verdict !== "issues") continue;
      const feedback = (parsed as { feedback?: unknown }).feedback;
      return {
        outcome: verdict,
        feedback: typeof feedback === "string" ? feedback.trim() : "",
      };
    } catch {
      continue;
    }
  }
  return null;
}

function extractFencedJson(text: string): string | null {
  // 部分模型会把审核 JSON 包在 Markdown fenced code block 中返回，
  // 直接 JSON.parse 会失败，需要先剥离围栏。
  const match = text.match(/```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/i);
  return match?.[1]?.trim() ?? null;
}

function positiveTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_RESPONSE_REVIEW_TIMEOUT_MS;
}
