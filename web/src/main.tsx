import { render } from 'preact';
import { App } from './App';
import { createSession } from './auth/session';
import { createGitHubCiGateway } from './github/ci';
import { createGitHubGateway } from './github/gateway';
import { createGitHubHistoryGateway } from './github/history';
import { createGitHubReviewGateway } from './github/review';
import { createGitHubTeamGateway } from './github/team';
import { createHttpCommentsGateway } from './comments/http';
import { createHttpDraftSharesGateway } from './admin/api';
import { createHttpDraftsGateway } from './drafts/http';
import { createHttpChatGateway } from './chat/http';
import { LocaleProvider } from './i18n/LocaleProvider';
import { demoRequested } from './demo/mode';
import './styles.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element');
}
const app = root;

function mountReal() {
  const session = createSession();
  const gateway = createGitHubGateway({ tokens: session });
  const reviews = createGitHubReviewGateway({ tokens: session });
  const comments = createHttpCommentsGateway();
  const drafts = createHttpDraftsGateway();
  const chat = createHttpChatGateway();
  const ci = createGitHubCiGateway({ tokens: session });
  const history = createGitHubHistoryGateway({ tokens: session });
  const shares = createHttpDraftSharesGateway();
  const team = createGitHubTeamGateway({ tokens: session });
  render(
    <LocaleProvider>
      <App session={session} gateway={gateway} reviews={reviews} comments={comments} drafts={drafts} chat={chat} ci={ci} shares={shares} history={history} team={team} />
    </LocaleProvider>,
    app,
  );
}

/** A made-up repository in memory: no GitHub and no galley API. */
async function mountDemo() {
  const { createDemo, DemoBanner } = await import('./demo');
  const { session, gateway, reviews, comments } = createDemo();
  document.documentElement.classList.add('demo-mode');
  render(
    <LocaleProvider>
      <DemoBanner />
      <App session={session} gateway={gateway} reviews={reviews} comments={comments} />
    </LocaleProvider>,
    app,
  );
}

if (demoRequested(window.location.search)) void mountDemo();
else mountReal();
