import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './responsive.css';
import './light.css';
// Loaded last so the shared checkout glass/sign-in parity wins the cascade.
import './upgradeCheckout.css';
import { initThemeMode } from './themeMode';

initThemeMode();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
