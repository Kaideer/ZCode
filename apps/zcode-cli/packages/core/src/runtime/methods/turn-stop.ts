import { HookEventName, SessionEventType, TurnMachineImpl, createMessageId, createPartId } from "../deps.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import { DEFAULT_RESPONSE_REVIEW_MAX_ROUNDS } from "@zcode/shared";
import { emptyTokenUsageInfo, toTokenUsageInfo } from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";
import { runResponseReview } from "./response-review-sidecar.js";
import {
  appendTurnRequestEntries,
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
} from "./turn-output-token-continuation.js";
import { createRuntimeAssistantEntry, systemReminderAttachmentEntry } from "../../agent/message-history.js";

interface AssistantPersistenceAnchor {
  latestAssistantMessageId: AgentRuntimeInternal["latestAssistantMessageId"];
  latestAssistantTurnId: AgentRuntimeInternal["latestAssistantTurnId"];
  latestConversationMessageId: AgentRuntimeInternal["latestConversationMessageId"];
}

export function captureAssistantPersistenceAnchor(
  runtime: AgentRuntimeInternal,
): AssistantPersistenceAnchor {
  return {
    latestAssistantMessageId: runtime.latestAssistantMessageId,
    latestAssistantTurnId: runtime.latestAssistantTurnId,
    latestConversationMessageId: runtime.latestConversationMessageId,
  };
}

export async function persistCompletedAssistantStep(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    includeEmptyAssistant: boolean;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<boolean> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed assistant persistence requires the loop Model");
  }
  let committed = commitAssistantToTurnRequest(runtime, state, options.result, undefined);
  if (!committed && options.includeEmptyAssistant) {
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      createRuntimeAssistantEntry(
        "",
        undefined,
        undefined,
        model,
        toTokenUsageInfo(options.result.usage),
      ),
    ]);
    committed = true;
  }
  if (!committed) {
    if (runtime.sessionStore) {
      await runtime.sessionStore.removeMessage({
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
      });
    }
    if (runtime.latestConversationMessageId === options.assistantMessageId) {
      runtime.latestConversationMessageId =
        options.assistantPersistenceAnchor.latestConversationMessageId;
    }
    if (runtime.latestAssistantMessageId === options.assistantMessageId) {
      runtime.latestAssistantMessageId =
        options.assistantPersistenceAnchor.latestAssistantMessageId;
      runtime.latestAssistantTurnId = options.assistantPersistenceAnchor.latestAssistantTurnId;
    }
    return false;
  }
  const persistedTokens = toTokenUsageInfo(options.result.usage);
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "step-finish",
      reason: options.result.finishReason,
      cost: 0,
      tokens: persistedTokens,
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    options.assistantMessageId,
    state.currentUserMessageId,
    options.assistantCreatedAt,
    {
      completed: Date.now(),
      finish: options.result.finishReason,
      tokens: persistedTokens,
    },
    options.modelTraceContext,
    model,
  );
  return committed;
}

export async function persistOutputTokenLimitErrorCarrier(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    error: { data: Record<string, unknown>; name: string };
    finishReason: string;
    model: Model;
    modelTraceContext: TraceContext;
  },
): Promise<void> {
  const messageId = createMessageId();
  const createdAt = Date.now();
  const tokens = emptyTokenUsageInfo();

  // partial 与终态 error 共用 durable assistant 时，Compact 无法同时重放
  // provider partial 并排除 transcript-only error。两者拆成独立消息后沿用既有过滤边界即可。
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    undefined,
    options.modelTraceContext,
    options.model,
  );
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: messageId,
      type: "step-finish",
      reason: options.finishReason,
      cost: 0,
      tokens,
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    {
      completed: Date.now(),
      error: options.error,
      finish: options.finishReason,
      tokens,
    },
    options.modelTraceContext,
    options.model,
  );
}

export async function finishModelStepWithoutToolCalls(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<"continue" | "break"> {
  if (!state.model) {
    throw new Error("Model-backed turn stop requires the loop Model");
  }
  const assistantCommitted = await persistCompletedAssistantStep(this, state, {
    ...options,
    includeEmptyAssistant: true,
  });
  if (assistantCommitted) recordModelHistoryRound(state);
  if (state.automationCreateLimitReached) {
    // 上限命中后只允许这一轮纯文本说明。跳过 guide 和 Stop hook，避免它们再次
    // 触发模型请求，把已经关闭工具的 turn 延长成新的恢复循环。
    if (state.activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events: state.events,
        reasonCode: "guide.noToolBoundary",
        traceContext: state.turnTraceContext,
      });
      state.activeTurn.steerable = false;
    }
    state.stableProductStartMessageId = state.currentUserMessageId;
    state.stableBoundaryAssistantMessageId = options.assistantMessageId;
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.complete(state.modelResponse, "success"),
    );
    return "break";
  }
  if (await drainInlineGuideForNextRequest(this, state)) {
    // 正常 text-only 是可续跑边界：assistant 已持久化，guide 以 user role 进入历史，
    // 保持同一 active turn 继续下一次 provider request，不改投 future queue。
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  const stopHookResult = await this.runStopHooks(
    state.modelResponse,
    state.toolCallCount,
    state.turnTraceContext,
    state.turnAbortSignal,
    state.stopHookContinuationCount > 0,
  );
  if (this.shouldContinueAfterStopHooks(stopHookResult, state.stopHookContinuationCount)) {
    state.stopHookContinuationCount += 1;
    const hookEntry = this.injectHookAdditionalContextIntoMessageHistory(
      HookEventName.Stop,
      stopHookResult.additionalContexts,
    );
    appendTurnRequestEntries(state.turnRequestState, hookEntry ? [hookEntry] : []);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  // ── 回复审核 Response Review 闸 ──
  // assistant 文本已持久化、轮未收口，是「结论已出、轮未结束」的干净位置；
  // 不通过则审核意见注入历史并同轮续写修正；审核失败与达到轮次上限都按通过放行。
  const responseReviewConfig = this.config.responseReview;
  if (responseReviewConfig?.enabled === true && responseReviewConfig.mode === "regenerate") {
    const maxRounds = positiveReviewMaxRounds(responseReviewConfig.maxRounds);
    if (state.responseReviewContinuationCount >= maxRounds) {
      // 达到轮次上限：不再发起审核，留一张「已放行」终态卡作为投影的明确收口事实。
      await this.appendEvent(
        this.createEvent(
          SessionEventType.AssistantReview,
          {
            reviewId: `review_${crypto.randomUUID()}`,
            mode: "regenerate",
            round: state.responseReviewContinuationCount,
            status: "completed",
            outcome: "pass",
            releasedAfterMaxRounds: true,
            anchorAssistantMessageId: options.assistantMessageId,
            anchorTurnId: state.turnId,
          },
          state.turnTraceContext,
        ),
        state.turnTraceContext,
      );
    } else if (state.modelResponse.trim().length > 0) {
      const review = await runResponseReview.call(this, {
        assistantText: state.modelResponse,
        mode: "regenerate",
        round: state.responseReviewContinuationCount,
        traceContext: state.turnTraceContext,
        anchorAssistantMessageId: options.assistantMessageId,
        anchorTurnId: state.turnId,
        abortSignal: state.turnAbortSignal,
      });
      if (review && review.outcome === "issues") {
        state.responseReviewContinuationCount += 1;
        const reviewEntry = systemReminderAttachmentEntry(
          "response_review",
          formatResponseReviewContinuationBody(
            review.body,
            state.responseReviewContinuationCount,
            maxRounds,
          ),
        );
        this.messageHistory.addEntries([reviewEntry]);
        appendTurnRequestEntries(state.turnRequestState, [reviewEntry]);
        state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
        return "continue";
      }
      // review === null 即审核失败/中断：按通过放行，审核是增强不是门禁。
    }
  }
  if (state.activeTurn) {
    // FIFO barrier / reservation 阻止本轮安全 inline 时，仍保留既有权威 queue 兜底；
    // 正常可消费的 text-only guide 已在上方作为 user-role continuation drain。
    await this.fallbackPendingGuidesToQueue({
      activeTurn: state.activeTurn,
      events: state.events,
      reasonCode: "guide.noToolBoundary",
      traceContext: state.turnTraceContext,
    });
  }
  if (state.activeTurn) state.activeTurn.steerable = false;
  // assistant completed 只代表 model step 收口；Stop hook 仍可能继续同一 product turn。
  // 只有最终 break 才把它交给 turn.ts 在 goal accounting 后持久化最终 boundary。
  state.stableProductStartMessageId = state.currentUserMessageId;
  state.stableBoundaryAssistantMessageId = options.assistantMessageId;
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.complete(state.modelResponse, "success"),
  );
  return "break";
}

/** 审核意见注入正文的最大长度；超长截断，避免意见本身撑大下一轮请求。 */
const MAX_REVIEW_FEEDBACK_CHARS = 4_000;

/** 组装同轮续写用的审核意见正文：明确轮次、意见全文与修正要求。 */
function formatResponseReviewContinuationBody(
  feedback: string,
  round: number,
  maxRounds: number,
): string {
  const body = [
    `回复审核（第 ${round}/${maxRounds} 轮）未通过，审核意见如下：`,
    feedback.trim().length > 0 ? feedback.trim() : "（审核未给出具体意见）",
    "请根据审核意见修正你的上一段回复：直接输出修正后的完整内容，不要重复解释审核过程。",
  ].join("\n\n");
  return body.length <= MAX_REVIEW_FEEDBACK_CHARS
    ? body
    : `${body.slice(0, MAX_REVIEW_FEEDBACK_CHARS)}...`;
}

function positiveReviewMaxRounds(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_RESPONSE_REVIEW_MAX_ROUNDS;
}
