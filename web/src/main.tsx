import { render } from 'preact';
import { App } from './App';
import { createSession } from './auth/session';
import { createGitHubGateway } from './github/gateway';
import './styles.css';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element');
}
const session = createSession();
const gateway = createGitHubGateway({ tokens: session });
render(<App session={session} gateway={gateway} />, root);
