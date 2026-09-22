import { zcodeWorkspaceUpdateInteractionPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 应用 workspace 交互偏好。CLI 进程按 workspace 隔离，因此 registry 是该 workspace
 * 内主任务、后台任务与子 Agent 共用的权威 gate。
 */
export async function updateInteractionPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateInteractionPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.askUserQuestionAutoResolutionEnabled;
  context.appRuntimePreferences.askUserQuestionAutoResolutionEnabled = enabled;
  const snoozedInteractionCount =
    await context.v4Interactions.setAskUserQuestionAutoResolutionEnabled(enabled);

  // 回复审核 Response Review：实时写入所有活跃会话 runtime，对后续 turn 生效；
  // 已发起的审核允许完成。payload 缺省表示本次变更不涉及回复审核。
  const responseReview = params.preferences.responseReview;
  if (responseReview !== undefined) {
    for (const record of context.sessions.values()) {
      record.app.runtime.updateResponseReviewConfig(responseReview);
      record.responseReview = responseReview;
    }
  }

  return {
    workspace: params.workspace,
    askUserQuestionAutoResolutionEnabled: enabled,
    snoozedInteractionCount,
  };
}
