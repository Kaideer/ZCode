# Response Review（双模型审核） SPEC

状态：已确认设计，实施中
确认决策：模式 B 采用「同轮续写修正」；配置修改「实时生效」（对当前会话下一条回复起效）。

## 1. 产品行为

用户可在设置中开启「回复审核」。开启后，主模型每产出一段最终文本结论（无工具调用的收口），由第二个可配置模型按固定审核维度输出审核结果。

两个互斥模式：

| 模式 | 标识 | 行为 |
|---|---|---|
| 流式先行 + 审核追加 | `append` | 主回复正常流式展示并收口；TurnComplete 之后异步发起审核，审核结果以卡片追加展示在该轮之后。主回复不被修改、不被阻塞。 |
| 审核-重生成循环 | `regenerate` | 主回复文本产出后、轮收口前插入审核闸：审核通过 → 正常收口；审核不通过 → 审核意见作为 system-reminder 注入当前轮，主模型紧接着输出修正版（同轮续写修正，原结论与修正均可见）。最多重试 `maxRounds` 次，达到上限后放行收口。 |

可配置项（均为用户级设置）：

- `responseReviewEnabled`：开关，默认 `false`（关闭时行为与现状完全一致）。
- `responseReviewMode`：`append | regenerate`，默认 `append`。
- `responseReviewModelSelection`：审核模型选择（`ModelSelection`，含 `providerId/modelId/options.reasoningLevel`）。`reasoningLevel` 即「思考强度」，可选档位随所选模型的 `optionSpecs.reasoningLevel.values` 联动。未配置时跟随会话主模型及其当前档位。

审核维度（固定写入审核 prompt）：事实准确性、逻辑一致性、完整性、指令遵循。审核输出要求结构化（通过/不通过 + 意见正文），不通过时必须引用待审原文中的依据。

## 2. 状态所有者

| 状态 | 唯一所有者 | 说明 |
|---|---|---|
| 审核设置 | `settingService`（`~/.zcode/v2/setting.json`） | UI 经 `ISettingService.update` 写入；schema 校验在 shared 层。 |
| 审核运行时配置 | CLI `AgentRuntimeConfig.responseReview` | 会话创建时经 `session/requestRuntimePreferences` 拉取；运行中经 `syncAppRuntimePreferences` 实时同步。CLI 侧为运行时真源。 |
| 单次审核生命周期 | CLI core `response-review-sidecar` | 发起、解析、事件 append 的唯一位置；投影层只消费事件。 |
| 模式 B 续写轮次计数 | `RegularTurnLoopState.responseReviewContinuationCount` | 仅当前轮内存态，不持久化；轮结束即销毁。 |
| 审核卡片展示 | v4 投影（`product-projection.ts`）→ `assistantReview` row | UI 只装配投影结果，不按文本/状态猜测审核归属。 |

## 3. 接口

### 3.1 设置 schema（packages/shared，已实现）

```ts
// AppSettings 新增
responseReviewEnabled?: boolean;                    // 默认 false
responseReviewMode?: "append" | "regenerate";       // 默认 "append"
responseReviewModelSelection?: ResponseReviewModelSelectionSetting; // 可选
```

`appSettingsObjectSchema` / `appSettingsPatchSchema` 同步扩展。`ResponseReviewModelSelectionSetting` 是 union：`{ followSession: true }` 哨兵变体（仅写入路径，表达「跟随会话主模型」的清除语义——RPC 吞 undefined）+ 显式 `ModelSelection`；`normalizeSettingsPatch` 把哨兵归一为 undefined，持久化态只存在显式选择或缺省。

### 3.2 下发链路（已实现）

- 会话创建：`zcodeSessionRuntimePreferencesResultSchema`（`.strict()`）扩展 `responseReview` 字段（optional，旧 Host 缺席按关闭）；`resolveSessionRuntimePreferences`（services/node.ts）负责读出，经 `SessionStartupPreferences` 注入 `runtimeConfig.responseReview`；fork 等 inherit 场景按父 `ZCodeProtocolSessionRecord.responseReview` 继承。
- 实时同步：`zcodeInteractionPreferencesSchema` 扩展 `responseReview`（optional，缺省表示本次变更不涉及）；`useSettingService.update` 触及任一审核字段时组装完整配置，经 `syncAppRuntimePreferences` → `workspaceUpdateInteractionPreferences` 推送；CLI handler（interaction-preferences.ts）遍历活跃会话调 `runtime.updateResponseReviewConfig` 并回写 record，对后续 turn 生效。

### 3.3 CLI 运行时配置（复刻 titleGeneration plumbing）

```ts
// AgentRuntimeConfig 新增
responseReview?: {
  enabled?: boolean;
  mode?: "append" | "regenerate";
  modelSelection?: ModelSelection; // 缺省跟随会话模型
  maxRounds?: number;              // 默认 2（仅 regenerate 生效）
  timeoutMs?: number;              // 默认 60_000
};
```

注入路径：`ZCodeAppOptions.runtimeConfig` ← services 会话创建参数 ← 设置。

### 3.4 审核事件（CLI contracts，已实现）

参照 `TargetCompletionVerification` 的**单事件 + status** 先例（非三个独立事件类型）：

- 事件类型 `AssistantReview`（`assistant_review`），payload `AssistantReviewPayload`：
  `{ reviewId, mode, round, status: "started" | "completed" | "failed" | "cancelled", anchorAssistantMessageId?, anchorTurnId?, reviewerModelSelection?, outcome?: "pass" | "issues", body?, reason?, releasedAfterMaxRounds? }`
- `reviewId` 为单次审核生命周期标识，投影按它归并各状态到同一行；`round` 仅 `regenerate` 有意义（0 = 首次审核）；`reason` 仅 failed 携带（model_call_failed / unparseable）。
- 事件权威只在事件日志（不落 session store），冷恢复按 memory-only 类保留（cold-event-merge 的 `MEMORY_ONLY_EVENT_TYPES`）。

### 3.5 v4 投影（已实现）

- `rows.ts` discriminatedUnion 新增 row kind `assistantReview`：`{ mode, round, state: "running" | "complete" | "failed", outcome?, body?, reviewerLabel?, releasedAfterMaxRounds? }`。
- **投影只产行、不动 control**：regenerate 的审核在轮内（control 本就 running），append 的审核在轮后（phase 已收口，不拉回 running）；「审核中」指示由行 running 态承担。spec 初稿的 activeWorks/stopTarget 预留在实现评审中按最小化原则撤除。
- `product-projection.ts` 仿 `onTargetVerification` 的 `onAssistantReview` handler + `assistantReviewRowIdByLifecycleKey` 去重（含 clone/swap 事务注册）；started 帧缺失时按 lifecycleKey 直接创建终态行。
- UI 装配：`assistantReview` 归入轮尾 tail（`isTurnTrailingReviewRow`），不顶掉「最终正文」折叠锚点；`ConversationRowView` 渲染状态分隔线 + 可展开意见正文卡（issues 默认展开）。
- 分享链路：sanitize 剥掉全部审核行（append 的 running 审核不阻断主内容分享）；`projectRow` 对 `assistantReview` 走显式闸门拒绝（公开投影 V1 不承载）。

## 4. 不变量

1. **零历史污染**：审核调用使用独立 messages（审核 system prompt + 待审结论），`tools: []`，不写入会话 `messageHistory`；用量归因 `querySource: "response_review"`。
2. **轮次上限硬约束**：`regenerate` 续写次数 ≤ `maxRounds`（默认 2），达到上限无条件放行收口。
3. **detached work 登记**：模式 A 在 TurnComplete 后发起，必须登记 `trackResidencyBlockingWork`，防止会话被 idle 回收。
4. **失败不阻塞**：审核调用失败/超时 → 模式 A 展示失败卡；模式 B 视为通过放行（审核是增强不是门禁）。
5. **关闭即零成本**：`enabled !== true` 时不产生任何审核调用、事件与行。
6. **CLI 投影裁决**：审核行的出现、状态、归属全部由 CLI 事件 + 投影决定，UI 不做第二套判断。

## 5. 失败语义

| 场景 | 行为 |
|---|---|
| 审核模型调用失败/超时 | `AssistantReviewFailed`；append 模式展示失败卡；regenerate 模式按「通过」放行收口 |
| 审核输出不可解析 | 同「失败」，reason 记 `unparseable` |
| 审核模型配置缺失 | 跟随会话主模型与当前 reasoningLevel |
| 设置实时修改为关闭 | 已发起的审核允许完成并展示；不再发起新审核 |
| 会话中断/被杀 | 进行中审核随会话终止；冷恢复只重建已完成的审核行 |

## 6. 迁移边界

- 新增设置字段均带默认值，无存量的用户无需迁移；老 setting.json 缺字段由 schema default 兜底。
- `zcodeSessionRuntimePreferencesResultSchema` 与 `app-runtime-preferences` 为 `.strict()` 闭集，扩展要求 CLI 与宿主同批发布（monorepo 单次发布满足）。
- v4 row kind 闭集加值遵循 `rows.ts` 版本偏斜惯例：旧宿主收到未知 kind 按忽略处理，不与旧版 CLI/桌面混部。

## 7. 验收场景

1. 默认关闭：任意对话无审核事件、无审核行，行为与基线一致。
2. `append`：回复流式完成 → 出现「审核中」→ 追加审核卡（审核模型名 + 通过/不通过 + 意见正文）；主回复内容不变。
3. `regenerate` 通过：回复收口，轮尾审核卡显示通过。
4. `regenerate` 不通过：审核卡显示不通过 + 意见；同一轮内模型继续输出修正版；再次审核；达到 `maxRounds` 后放行并在审核卡标注已放行。
5. 指定审核模型 + 思考强度：审核调用的模型/档位与设置一致（事件 payload 与用量归因可见）。
6. 实时修改配置：当前会话下一条回复即按新配置执行，无需重开会话。
7. 审核失败：append 显示失败卡；regenerate 放行收口并标注审核失败。
