import { createEffect, createSignal, Show } from "solid-js";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";

export function AccountActions(props: {
  name: string;
  disabled: boolean;
  busy: boolean;
  onSessions(): void;
  onDisable(): void;
  onEnable(): void;
}) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const id = `account-actions-${crypto.randomUUID()}`;
  const close = () => setOpen(false);
  const choose = (action: () => void) => {
    close();
    opener?.focus({ preventScroll: true });
    action();
  };
  createEffect(open, (shown) => {
    if (!shown) return;
    const container = root?.closest(".settings-content");
    if (menu && container) {
      menu.dataset["side"] =
        menu.getBoundingClientRect().bottom > container.getBoundingClientRect().bottom
          ? "above"
          : "below";
    }
    const outside = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", outside);
    const dispose = menu ? bindPopoverKeyboard(menu, opener, close) : undefined;
    return () => {
      window.removeEventListener("pointerdown", outside);
      dispose?.();
    };
  });
  return (
    <div class="access-account-actions" ref={root}>
      <button
        type="button"
        class="bare-icon"
        ref={opener}
        aria-label={`Access actions for ${props.name}`}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" />
      </button>
      <Show when={open()}>
        <div
          class="access-account-menu"
          ref={menu}
          id={id}
          role="menu"
          aria-label={`Access actions for ${props.name}`}
        >
          <button
            type="button"
            role="menuitem"
            disabled={props.busy}
            onClick={() => choose(props.onSessions)}
          >
            <Icon name="close" />
            <span>End browser sessions</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={props.busy}
            onClick={() => choose(props.disabled ? props.onEnable : props.onDisable)}
          >
            <Icon name={props.disabled ? "check" : "stop"} />
            <span>{props.disabled ? "Enable account" : "Disable account"}</span>
          </button>
        </div>
      </Show>
    </div>
  );
}
