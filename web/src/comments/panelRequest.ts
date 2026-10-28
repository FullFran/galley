// "Comments" in the sidebar from another screen opens the workspace with the
// comments panel showing. The request lives in memory for one hand-over.

let requested = false;

export function requestCommentsPanel(): void {
  requested = true;
}

export function takeCommentsPanelRequest(): boolean {
  const was = requested;
  requested = false;
  return was;
}
