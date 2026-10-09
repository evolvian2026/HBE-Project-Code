/** A launch or service call the tool refuses, with a code for logs and a message for people. */
export class LtiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LtiError";
  }
}
