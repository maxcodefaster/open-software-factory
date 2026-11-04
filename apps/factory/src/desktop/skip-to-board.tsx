// The header and dock come first in reading order. This control is the first Tab stop and
// moves keyboard focus past them to the first Ticket card, or to the board itself when empty.
export function focusBoard(root: ParentNode = document) {
  const board = root.querySelector<HTMLElement>(".kanban-desktop");
  const target =
    board?.querySelector<HTMLElement>(".ticket-card-body, .epic-stack-open") ??
    board?.querySelector<HTMLElement>("button:not(:disabled), [href]") ??
    board;
  target?.focus();
  return target;
}

export function SkipToBoard() {
  return (
    <button type="button" class="skip-to-board quiet-button" onClick={() => focusBoard()}>
      Skip to board
    </button>
  );
}
