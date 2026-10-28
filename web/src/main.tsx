import { render } from 'preact';
import { App } from './App';
import { createSession } from './auth/session';
import { createGitHubCiGateway } from './github/ci';
import { createGitHubGateway } from './github/gateway';
import { createGitHubReviewGateway } from './github/review';
import { createHttpCommentsGateway } from './comments/http';
import { createHttpDraftsGateway } from './drafts/http';
import { createHttpChatGateway } from './chat/http';
import { LocaleProvider } from './i18n/LocaleProvider';
import './styles.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element');
}
const session = createSession();
const gateway = createGitHubGateway({ tokens: session });
const reviews = createGitHubReviewGateway({ tokens: session });
const comments = createHttpCommentsGateway();
const drafts = createHttpDraftsGateway();
const chat = createHttpChatGateway();
const ci = createGitHubCiGateway({ tokens: session });
render(
  <LocaleProvider>
    <App session={session} gateway={gateway} reviews={reviews} comments={comments} drafts={drafts} chat={chat} ci={ci} />
  </LocaleProvider>,
  root,
);
