import { createEffect, createSignal, For, Show } from "solid-js";
import type { RuntimeDockTarget } from "./api-contracts";
import { Icon, type IconName } from "./icon";
import { bindPopoverKeyboard } from "./popover-keyboard";

type DockIcon = Extract<IconName, "home" | "knowledge" | "ticket" | "ide" | "preview" | "inbox">;

export function DockButton(props: {
  label: string;
  icon: DockIcon;
  active: boolean;
  open?: boolean;
  disabled?: boolean;
  notification?: boolean;
  onClick(): void;
  onMinimize?(): void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.active ? "true" : "false"}
      data-tooltip={props.disabled ? `${props.label} waits for a ready runtime` : props.label}
      disabled={props.disabled}
      onClick={() => (props.active && props.onMinimize ? props.onMinimize() : props.onClick())}
    >
      <Icon name={props.icon} />
      <Show when={props.open && !props.active}>
        <span class="open-dot" />
      </Show>
      <Show when={props.notification}>
        <span class="notification-dot" />
      </Show>
    </button>
  );
}

export function DockAppButton(props: {
  label: string;
  icon: Extract<IconName, "ide" | "preview">;
  active: boolean;
  open: boolean;
  targets: RuntimeDockTarget[];
  selectedID?: string | undefined;
  preferredID?: string | undefined;
  onSelect(target: RuntimeDockTarget): void;
  onMinimize?(): void;
}) {
  const [open, setOpen] = createSignal(false);
  let container: HTMLDivElement | undefined;
  let menu: HTMLDivElement | undefined;
  let opener: HTMLElement | undefined;
  createEffect(open, (shown) => {
    if (shown && menu) return bindPopoverKeyboard(menu, opener, () => setOpen(false));
  });
  createEffect(
    () => true,
    () => {
      const close = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (open() && target && !container?.contains(target)) setOpen(false);
      };
      document.addEventListener("pointerdown", close, true);
      return () => {
        document.removeEventListener("pointerdown", close, true);
      };
    },
  );

  function activate() {
    if (props.active && props.onMinimize) {
      setOpen(false);
      props.onMinimize();
      return;
    }
    const preferred =
      props.targets.find((candidate) => candidate.id === props.preferredID) ??
      props.targets.find((candidate) => candidate.id === props.selectedID);
    if (preferred || props.targets.length === 1) {
      const target = preferred ?? props.targets[0];
      if (target) props.onSelect(target);
      setOpen(false);
      return;
    }
    setOpen((value) => !value);
  }

  return (
    <div class={`dock-app${props.targets.length > 1 ? " has-instances" : ""}`} ref={container}>
      <button
        type="button"
        aria-label={props.label}
        aria-pressed={props.active ? "true" : "false"}
        aria-expanded={props.targets.length > 1 ? (open() ? "true" : "false") : undefined}
        data-tooltip={props.label}
        onClick={(event) => {
          opener = event.currentTarget;
          activate();
        }}
      >
        <Icon name={props.icon} />
        <Show when={props.open && !props.active}>
          <span class="open-dot" />
        </Show>
      </button>
      <Show when={props.targets.length > 1}>
        <button
          type="button"
          class="dock-instance-menu"
          aria-label={`Choose ${props.label} instance`}
          aria-haspopup="menu"
          aria-expanded={open() ? "true" : "false"}
          onClick={(event) => {
            opener = event.currentTarget;
            setOpen((value) => !value);
          }}
        >
          <Icon name="chevron" />
        </button>
      </Show>
      <Show when={open() && props.targets.length > 1}>
        <div class="dock-switcher" role="menu" aria-label={`${props.label} instances`} ref={menu}>
          <For each={props.targets} keyed={(target) => target.id}>
            {(target) => (
              <button
                type="button"
                role="menuitem"
                class={props.selectedID === target().id ? "selected" : ""}
                onClick={() => {
                  props.onSelect(target());
                  setOpen(false);
                }}
              >
                <span>{target().label}</span>
                <small>{target().detail}</small>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
