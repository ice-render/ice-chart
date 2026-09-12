/**
 * 全局动效偏好。
 *
 * 放在独立模块里（而不是 ICEChart）是为了让**组件**也能读到它 ——
 * 悬停反馈这类动画由组件自己启动，如果组件反向 import ICEChart 就会形成循环依赖。
 */

export type MotionPreference = 'auto' | 'instant' | 'full';

let motionPreference: MotionPreference = 'auto';

export function setMotionPreference(preference: MotionPreference): void {
  motionPreference = preference;
}

export function getMotionPreference(): MotionPreference {
  return motionPreference;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof (window as any).matchMedia !== 'function') return false;
  try {
    return !!(window as any).matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
}

/** 当前是否应该播放动画（无障碍：尊重系统的「减少动态效果」）。 */
export function shouldAnimate(): boolean {
  if (motionPreference === 'instant') return false;
  if (motionPreference === 'full') return true;
  return !prefersReducedMotion();
}
