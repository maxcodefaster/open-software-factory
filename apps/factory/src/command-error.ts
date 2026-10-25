export class CommandError extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "not-found" | "unavailable" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }

  get status() {
    return { invalid: 400, conflict: 409, "not-found": 404, unavailable: 503, forbidden: 403 }[
      this.code
    ];
  }
}
