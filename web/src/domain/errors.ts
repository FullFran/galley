/** Base class for every error a RepoGateway or session client reports. */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The working branch moved since it was opened; reload before saving again. */
export class ConflictError extends GatewayError {}

/** The session is gone or the token was rejected; the user must sign in again. */
export class AuthRequiredError extends GatewayError {}

/** A temporary failure (network, 5xx, rate limit); the call may be retried. */
export class TransientError extends GatewayError {}

/** The resource does not exist or is not visible to the user. */
export class NotFoundError extends GatewayError {}

/** The user can see the resource but is not allowed to perform the action. */
export class PermissionError extends GatewayError {}

/** The file is not valid UTF-8 text (binary or another encoding); it cannot be edited. */
export class NotTextError extends GatewayError {}

/** What was being done when GitHub answered 422, so the message can say why. */
export type RejectedAction = 'comment' | 'review' | 'reviewers' | 'assignees' | 'branch';

/** GitHub refused the request as invalid (HTTP 422), for example a reviewer without access. */
export class RejectedError extends GatewayError {
  readonly action?: RejectedAction;

  constructor(message: string, action?: RejectedAction) {
    super(message);
    this.action = action;
  }
}

/** GitHub refused to merge (not mergeable, blocked by rules or checks). */
export class NotMergeableError extends GatewayError {}

/** The file changed since the suggestion was written; it cannot be applied as is. */
export class SuggestionMismatchError extends GatewayError {}
