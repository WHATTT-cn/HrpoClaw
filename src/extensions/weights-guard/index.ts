/**
 * Weights Guard Renderer Extension
 * 以 ClawX 外壳扩展方式注册侧边栏独立「供应商管理」页。
 */
import { Store } from 'lucide-react';
import { registerRendererExtensionModule } from '../loader';
import type { RendererExtension } from '../types';
import { WeightsGuardModePage } from './WeightsGuardModePage';

export const WEIGHTS_GUARD_EXTENSION_ID = 'weights-guard';
export const WEIGHTS_GUARD_ROUTE_PATH = '/modes';

function createWeightsGuardExtension(): RendererExtension {
  return {
    id: WEIGHTS_GUARD_EXTENSION_ID,
    sidebar: {
      id: WEIGHTS_GUARD_EXTENSION_ID,
      navItems: [
        {
          to: WEIGHTS_GUARD_ROUTE_PATH,
          icon: Store,
          label: '模式',
          testId: 'sidebar-nav-modes',
        },
      ],
    },
    routes: {
      id: WEIGHTS_GUARD_EXTENSION_ID,
      routes: [{ path: WEIGHTS_GUARD_ROUTE_PATH, component: WeightsGuardModePage }],
    },
  };
}

registerRendererExtensionModule(WEIGHTS_GUARD_EXTENSION_ID, createWeightsGuardExtension);