import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { readConsultorIdentity } from './services/meuPainelApi';

// Captura identidade do consultor (passada via ?consultor=&consultor_nome=&role=
// pelo dcz-crm-sync no src do iframe) ANTES do React montar qualquer pagina.
// Sem isso, a primeira pagina renderizada (DisparadorPage) nao le os params,
// e quando o usuario clica em "Meu Painel" o react-router ja perdeu a query.
// readConsultorIdentity persiste em localStorage, entao a MeuPainelPage le de la.
readConsultorIdentity();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
