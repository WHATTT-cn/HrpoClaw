import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { getWeightsGuardEnabled, setWeightsGuardEnabled } from '../utils/weights-guard-mode';

export function createModesApi(): CompleteHostServiceRegistry['modes'] {
  return {
    getWeightsGuardEnabled: async () => ({ enabled: await getWeightsGuardEnabled() }),
    setWeightsGuardEnabled: async (payload) => {
      await setWeightsGuardEnabled(payload.enabled);
      return { enabled: payload.enabled };
    },
  };
}