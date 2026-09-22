import { useMemo, useState } from "react";
import type { IModelSelectionService } from "@zcode/services";
import type { AppSettings, ResponseReviewMode } from "@zcode/shared";
import {
  TID_SETTINGS_RESPONSE_REVIEW_SWITCH,
  TID_SETTINGS_RESPONSE_REVIEW_MODE_TRIGGER,
  TID_SETTINGS_RESPONSE_REVIEW_MODEL_TRIGGER,
  TID_SETTINGS_RESPONSE_REVIEW_THOUGHT_TRIGGER,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** 「跟随会话主模型」单选项的 value；与真实模型 value（providerId/modelName 编码）不会冲突。 */
const FOLLOW_SESSION_MODEL_VALUE = "__follow_session_model__";
const MODEL_ITEM_NEVER_LOCKED = () => false;

/**
 * 回复审核 Response Review 设置分区。
 * 审核模型与思考强度只读 Registry 投影的 ModelSelectionView（本机 Host），
 * 档位范围随所选审核模型联动；「跟随会话主模型」经 followSession 哨兵表达清除语义。
 */
export function ResponseReviewSection({
  modelSelectionService,
}: {
  modelSelectionService: IModelSelectionService | null;
}) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const viewRead = useModelSelectionServiceView(modelSelectionService);
  const [saving, setSaving] = useState(false);

  const enabled = settings?.responseReviewEnabled === true;
  const mode: ResponseReviewMode = settings?.responseReviewMode ?? "append";
  const storedSelection = settings?.responseReviewModelSelection;
  const explicitSelection =
    storedSelection && !("followSession" in storedSelection) ? storedSelection : undefined;
  const thoughtLevel = explicitSelection?.options?.reasoningLevel ?? "";

  const modelSelectionView = viewRead.state.status === "ready" ? viewRead.state.view : null;
  const modelGroups = useMemo<ModelSelectGroup[]>(
    () =>
      modelSelectionView
        ? buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView, {})
        : [],
    [modelSelectionView],
  );
  const thoughtOption = useMemo(
    () =>
      modelSelectionView && explicitSelection
        ? resolveModelThoughtOption({
            modelSelectionView,
            providerId: explicitSelection.providerId,
            modelId: explicitSelection.modelId,
            currentValue: thoughtLevel,
          })
        : null,
    [explicitSelection, modelSelectionView, thoughtLevel],
  );

  const followSessionLabel = intl.formatMessage({
    id: "settings.responseReview.model.followSession",
  });
  const normalizedModelValue = explicitSelection
    ? encodeCustomModelValue(explicitSelection.providerId, explicitSelection.modelId)
    : FOLLOW_SESSION_MODEL_VALUE;

  const save = async (patch: Partial<AppSettings>) => {
    setSaving(true);
    try {
      await update(patch);
    } catch (error) {
      logger.warn("[settings] 更新回复审核设置失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.responseReview.saveError" }));
    } finally {
      setSaving(false);
    }
  };

  const handleModelChange = (value: string) => {
    if (value === FOLLOW_SESSION_MODEL_VALUE) {
      void save({ responseReviewModelSelection: { followSession: true } });
      return;
    }
    const decoded = decodeCustomModelValue(value);
    if (!decoded?.modelName) return;
    // 换模型后旧思考档位可能不受支持：不携带旧档位，由用户在新模型的档位范围内重选；
    // 未选档位时审核调用会回落到该模型的最低公开档。
    void save({
      responseReviewModelSelection: {
        providerId: decoded.providerId,
        modelId: decoded.modelName,
      },
    });
  };

  const handleThoughtChange = (level: string) => {
    if (!explicitSelection) return;
    void save({
      responseReviewModelSelection: {
        ...explicitSelection,
        options: { reasoningLevel: level },
      },
    });
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.responseReview.enabled" })}
        description={intl.formatMessage({ id: "settings.responseReview.enabledDescription" })}
        control={
          <Switch
            checked={enabled}
            disabled={saving || !settings}
            onCheckedChange={(checked) => void save({ responseReviewEnabled: checked })}
            aria-label={intl.formatMessage({ id: "settings.responseReview.enabled" })}
            data-testid={TID_SETTINGS_RESPONSE_REVIEW_SWITCH}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.responseReview.mode" })}
        description={intl.formatMessage({ id: "settings.responseReview.modeDescription" })}
        control={
          <Select
            value={mode}
            disabled={!enabled || saving || !settings}
            onValueChange={(value) =>
              void save({ responseReviewMode: value as ResponseReviewMode })
            }
          >
            <SelectTrigger
              size="lg"
              className="w-[260px]"
              data-testid={TID_SETTINGS_RESPONSE_REVIEW_MODE_TRIGGER}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="append">
                {intl.formatMessage({ id: "settings.responseReview.mode.append" })}
              </SelectItem>
              <SelectItem value="regenerate">
                {intl.formatMessage({ id: "settings.responseReview.mode.regenerate" })}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.responseReview.model" })}
        description={intl.formatMessage({ id: "settings.responseReview.modelDescription" })}
        control={
          <ModelConfigSelect
            modelGroups={modelGroups}
            normalizedValue={normalizedModelValue}
            triggerLabel={explicitSelection ? explicitSelection.modelId : followSessionLabel}
            leadingItems={[
              { key: "follow-session", value: FOLLOW_SESSION_MODEL_VALUE, name: followSessionLabel },
            ]}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={handleModelChange}
            disabled={!enabled || saving || !settings || modelGroups.length === 0}
            tooltipTitle={intl.formatMessage({ id: "settings.responseReview.model" })}
            contentSide="bottom"
            contentAlign="end"
            focusSelectorOnClose={null}
            triggerTestId={TID_SETTINGS_RESPONSE_REVIEW_MODEL_TRIGGER}
            triggerClassName="w-[260px]"
          />
        }
      />
      {thoughtOption ? (
        <SettingsRow
          label={intl.formatMessage({ id: "settings.responseReview.thought" })}
          description={intl.formatMessage({ id: "settings.responseReview.thoughtDescription" })}
          control={
            <Select
              value={
                typeof thoughtOption.currentValue === "string" && thoughtOption.currentValue
                  ? thoughtOption.currentValue
                  : undefined
              }
              disabled={!enabled || saving}
              onValueChange={handleThoughtChange}
            >
              <SelectTrigger
                size="lg"
                className="w-[260px]"
                data-testid={TID_SETTINGS_RESPONSE_REVIEW_THOUGHT_TRIGGER}
              >
                <SelectValue
                  placeholder={intl.formatMessage({ id: "settings.responseReview.thought.unset" })}
                />
              </SelectTrigger>
              <SelectContent>
                {(thoughtOption.options ?? []).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      ) : null}
    </SettingsGroupCard>
  );
}
