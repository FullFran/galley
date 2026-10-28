// "Chat" in the sidebar from another screen opens the workspace with the chat
// panel showing. The request lives in memory for one hand-over.

let requested = false;

export function requestChatPanel(): void {
  requested = true;
}

export function takeChatPanelRequest(): boolean {
  const was = requested;
  requested = false;
  return was;
}
