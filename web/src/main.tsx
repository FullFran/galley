import { render } from 'preact';
import { App } from './App';
import { createSession } from './auth/session';
import { createGitHubGateway } from './github/gateway';
import { createGitHubReviewGateway } from './github/review';
import './styles.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element');
}
const session = createSession();
const gateway = createGitHubGateway({ tokens: session });
const reviews = createGitHubReviewGateway({ tokens: session });
render(<App session={session} gateway={gateway} reviews={reviews} />, root);
