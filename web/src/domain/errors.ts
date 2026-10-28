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
