/**
 * 交互系统 —— 监听 E 键，调用 PlayerController.checkInteractable()
 * 并派发事件。HUD 通过 interaction:hover 显示"按 E 交互"提示。
 */
import { EventBus } from '../core/EventBus';
import type { InteractableObject, PlayerController } from './PlayerController';

export class InteractionSystem {
  private player: PlayerController;
  private currentHover: InteractableObject | null = null;
  private onKey: ((e: KeyboardEvent) => void) | null = null;

  constructor(player: PlayerController) {
    this.player = player;
  }

  attach(target: EventTarget = window): void {
    const handler = (e: KeyboardEvent): void => {
      if (e.code === 'KeyE' && !e.repeat) {
        const obj = this.player.checkInteractable();
        if (obj) {
          EventBus.emit('interaction:activate', { target: obj });
          obj.onInteract?.();
        }
      }
    };
    this.onKey = handler;
    target.addEventListener('keydown', handler as EventListener);
  }

  detach(target: EventTarget = window): void {
    if (this.onKey) target.removeEventListener('keydown', this.onKey as EventListener);
    this.onKey = null;
  }

  /** 在 render 循环中调用，刷新悬停目标 */
  update(): void {
    const hover = this.player.checkInteractable();
    const prevId = this.currentHover?.id ?? null;
    const nextId = hover?.id ?? null;
    if (prevId !== nextId) {
      this.currentHover = hover;
      EventBus.emit('interaction:hover', { target: hover });
    }
  }

  get hovered(): InteractableObject | null {
    return this.currentHover;
  }
}
