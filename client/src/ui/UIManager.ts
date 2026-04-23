/**
 * UI 管理器（占位）——真实实现中由 React/Vue 组件注册回调；
 * 模拟层通过这些 Promise 接口暂停等待玩家输入。
 */
import type { VCenterCredential } from '../core/credential';
import { EventBus } from '../core/EventBus';

type PendingResolver<T> = (value: T) => void;

class UIManagerImpl {
  private pendingChoice: PendingResolver<string> | null = null;
  private pendingLogin: PendingResolver<VCenterCredential> | null = null;

  /** 打开 vCenter 登录面板，返回玩家输入的凭据 */
  showVCenterLoginPanel(): Promise<VCenterCredential> {
    EventBus.emit('ui:open_vcenter_login');
    return new Promise((resolve) => {
      this.pendingLogin = resolve;
    });
  }
  /** 由 UI 层在玩家提交表单后调用 */
  submitVCenterLogin(cred: VCenterCredential): void {
    this.pendingLogin?.(cred);
    this.pendingLogin = null;
  }

  /** 阻塞等待玩家在给定选项中做选择 */
  waitForUserChoice(options: string[]): Promise<string> {
    EventBus.emit('ui:await_choice', { options });
    return new Promise((resolve) => {
      this.pendingChoice = resolve;
    });
  }
  submitUserChoice(choice: string): void {
    this.pendingChoice?.(choice);
    this.pendingChoice = null;
  }
}

export const UIManager = new UIManagerImpl();
