import { render } from 'preact';
import { App } from './App';
import { createSession } from './auth/session';
import { createGitHubCiGateway } from './github/ci';
import { createGitHubGateway } from './github/gateway';
import { createGitHubReviewGateway } from './github/review';
import { createHttpCommentsGateway } from './comments/http';
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
const ci = createGitHubCiGateway({ tokens: session });
render(
  <LocaleProvider>
    <App session={session} gateway={gateway} reviews={reviews} comments={comments} ci={ci} />
  </LocaleProvider>,
  root,
);
