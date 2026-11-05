// Theia 1.76 is pinned and renders a few structures that fail WCAG checks: tab <li> elements
// without the tab role, unlabelled landmarks and status entries that cannot take focus.
// This layer adds the missing roles in the browser. It never moves or restyles anything.

const landmarks: ReadonlyArray<readonly [id: string, role: string, label: string]> = [
  ["theia-left-content-panel", "region", "Sidebar"],
  ["theia-main-content-panel", "main", "Editor"],
  ["theia-bottom-content-panel", "region", "Panel"],
  ["theia-statusBar", "region", "Status bar"],
];

// Popups Theia appends to the document body, outside the application shell.
const popups: ReadonlyArray<readonly [selector: string, role: string, label: string]> = [
  ["#quick-input-container", "region", "Quick input"],
  [".theia-notifications-container", "region", "Notifications"],
  [".context-view", "region", "Popup"],
  [".lm-Menu", "region", "Menu"],
  [".theia-hover", "region", "Details"],
];
const popupSelector = popups.map(([selector]) => selector).join(", ");
const titledInputs =
  ":is(input, textarea)[title]:not([title='']):not([aria-label]):not([aria-labelledby])";
const separators = ".lm-Menu-item[data-type='separator']";
const preferences = ".single-pref";
const options = "[role='option'][aria-level]";
// Monaco's touch-only keyboard toggle is an unlabelled control.
const keyboardToggle = ".iPadShowKeyboard:not([aria-label])";
const tabs = "ul[role='tablist'] > li";
const statusEntries = "#theia-statusBar .element";
const statusButtons = "#theia-statusBar [role='button']";

function set(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function hardenTab(tab: Element) {
  set(tab, "role", "tab");
  set(tab, "aria-selected", String(tab.classList.contains("lm-mod-current")));
  // Activity bar tabs show only an icon. Their label exists but has no size, so it is not read.
  if (tab.parentElement?.getAttribute("aria-orientation") === "vertical") {
    const label = tab.querySelector(".lm-TabBar-tabLabel")?.textContent?.trim();
    if (label) set(tab, "aria-label", label);
  }
}

// Theia gives status entries an aria-label but no role, which makes the label invalid.
// A command makes the entry a button that must be reachable and operable by keyboard.
function hardenStatusEntry(entry: Element) {
  if (entry.classList.contains("hasCommand")) {
    set(entry, "role", "button");
    set(entry, "tabindex", "0");
  } else {
    set(entry, "role", "group");
    entry.removeAttribute("tabindex");
  }
}

function hardenPopup(popup: Element) {
  const match = popups.find(([selector]) => popup.matches(selector));
  if (!match) return;
  set(popup, "role", match[1]);
  set(popup, "aria-label", match[2]);
}

// Lumino marks separators as presentation but also gives them a tab stop, which invalidates the role.
function hardenSeparator(separator: Element) {
  set(separator, "role", "separator");
  separator.removeAttribute("tabindex");
}

// The settings editor shows each name beside its control without connecting them.
function hardenPreference(preference: Element) {
  // The entries are list items inside a plain container. Make that container the list.
  const container = preference.parentElement;
  if (container && preference.tagName === "LI" && container.tagName !== "UL") {
    set(container, "role", "list");
    for (const section of container.children)
      if (section.tagName === "UL") set(section, "role", "presentation");
  }
  const name = preference.querySelector(".pref-name")?.textContent?.replace(/\s+/g, " ").trim();
  if (!name) return;
  for (const control of preference.querySelectorAll("input, select, textarea"))
    if (!control.hasAttribute("aria-label") && !control.hasAttribute("aria-labelledby"))
      control.setAttribute("aria-label", name);
}

function hardenLandmarks(document: Document) {
  for (const [id, role, label] of landmarks) {
    const element = document.getElementById(id);
    if (!element) continue;
    set(element, "role", role);
    set(element, "aria-label", label);
  }
}

function hardenWithin(root: Element) {
  if (root.matches(tabs)) hardenTab(root);
  if (root.matches(statusEntries)) hardenStatusEntry(root);
  if (root.matches(popupSelector)) hardenPopup(root);
  if (root.matches(separators)) hardenSeparator(root);
  if (root.matches(preferences)) hardenPreference(root);
  if (root.matches(titledInputs)) root.setAttribute("aria-label", root.getAttribute("title") ?? "");
  for (const input of root.querySelectorAll(titledInputs))
    input.setAttribute("aria-label", input.getAttribute("title") ?? "");
  if (root.matches(keyboardToggle)) root.setAttribute("aria-label", "Show on-screen keyboard");
  for (const toggle of root.querySelectorAll(keyboardToggle))
    toggle.setAttribute("aria-label", "Show on-screen keyboard");
  if (root.matches(options)) root.removeAttribute("aria-level");
  for (const option of root.querySelectorAll(options)) option.removeAttribute("aria-level");
  for (const tab of root.querySelectorAll(tabs)) hardenTab(tab);
  for (const entry of root.querySelectorAll(statusEntries)) hardenStatusEntry(entry);
  for (const popup of root.querySelectorAll(popupSelector)) hardenPopup(popup);
  for (const separator of root.querySelectorAll(separators)) hardenSeparator(separator);
  for (const preference of root.querySelectorAll(preferences)) hardenPreference(preference);
}

/** Hardens the document now and as Theia changes it. Returns a function that stops observing. */
export function installAccessibility(document: Document): () => void {
  const view = document.defaultView;
  if (!view) return () => {};
  const apply = () => {
    hardenLandmarks(document);
    hardenWithin(document.documentElement);
  };
  apply();
  const observer = new view.MutationObserver((records) => {
    let landmarkCheck = false;
    for (const record of records) {
      if (record.type === "attributes") {
        // Only a tab's selection, a status entry's command and a list row's level matter.
        if (record.target instanceof view.Element) {
          if (record.attributeName === "aria-level") {
            if (record.target.matches(options)) record.target.removeAttribute("aria-level");
          } else if (record.target.matches(tabs)) hardenTab(record.target);
          else if (record.target.matches(statusEntries)) hardenStatusEntry(record.target);
        }
        continue;
      }
      for (const node of record.addedNodes)
        if (node instanceof view.Element) {
          hardenWithin(node);
          landmarkCheck = true;
        }
    }
    if (landmarkCheck) hardenLandmarks(document);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "aria-level"],
  });
  // Status entries are divs with a command. Give them the keyboard activation a button has.
  const activate = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target instanceof view.Element ? event.target : undefined;
    if (!target?.matches(statusButtons)) return;
    event.preventDefault();
    (target as HTMLElement).click();
  };
  document.addEventListener("keydown", activate);
  return () => {
    observer.disconnect();
    document.removeEventListener("keydown", activate);
  };
}
