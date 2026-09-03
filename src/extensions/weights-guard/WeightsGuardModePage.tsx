/**
 * Weights Guard Mode Page（供应商管理）
 * 侧边栏独立页 — weights-guard 合规守卫启用/关闭开关
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { hostApi } from '@/lib/host-api';
import { toUserMessage } from '@/lib/error-message';
import { switchToAgent } from '@/lib/agent-switch';

/** Renderer-side mirror of PRESET_PO_AGENT_ID (electron/utils/agent-config.ts). */
const PRESET_PO_AGENT_ID = 'po';

export function WeightsGuardModePage() {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await hostApi.modes.getWeightsGuardEnabled();
        if (!cancelled) {
          setEnabled(result.enabled);
        }
      } catch (error) {
        // fail-closed：读取失败时视为启用
        if (!cancelled) {
          setEnabled(true);
        }
        toast.error(toUserMessage(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = useCallback(async (next: boolean) => {
    setSaving(true);
    try {
      const result = await hostApi.modes.setWeightsGuardEnabled(next);
      setEnabled(result.enabled);
      // When weights-guard becomes enabled, auto-switch the chat to the preset
      // "PO" agent so compliance work happens in its dedicated workspace.
      if (result.enabled) {
        const switched = await switchToAgent(PRESET_PO_AGENT_ID);
        if (!switched) {
          toast.error('已启用，但切换到 PO agent 失败');
        }
      }
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <div
      data-testid="modes-page"
      className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden"
    >
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16 pb-0">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-6 shrink-0 gap-4">
          <div>
            <h1 className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight">
              模式
            </h1>
            <p className="text-subtitle text-foreground/70 font-medium">
              管理和定制 HR 专项任务
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="space-y-6">
          <div className="flex items-center justify-between rounded-xl border border-black/5 dark:border-white/5 p-6">
            <div>
              <Label className="text-sm font-medium text-foreground/80">供应商管理</Label>
              <p className="text-meta text-muted-foreground mt-1">
                启用后，AI 提出的权重微调建议会先经过合规校验网关；任何越界或无据的改动都会被拦截。
              </p>
            </div>
            <Switch checked={enabled} disabled={loading || saving} onCheckedChange={handleToggle} />
          </div>
        </div>
      </div>
    </div>
  );
}