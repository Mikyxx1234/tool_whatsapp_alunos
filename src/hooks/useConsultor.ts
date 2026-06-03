/**
 * Identidade do consultor que está disparando.
 *
 * Versão temporária (pré-merge com dcz-crm-sync):
 *   - Lê de localStorage; pede via prompt na 1ª vez.
 *   - Permite trocar/limpar pelo painel.
 *
 * Depois do merge, este hook vira um wrapper sobre o estado de sessão real
 * (`useAuth()` ou similar). A API pública do hook não muda — só a fonte do
 * dado.
 */

import { useCallback, useEffect, useState } from 'react';

const LS_KEY_ID = 'consultor_id';
const LS_KEY_NOME = 'consultor_nome';

export interface ConsultorIdentity {
  id: number | null;
  nome: string | null;
}

function readLs(): ConsultorIdentity {
  if (typeof window === 'undefined') return { id: null, nome: null };
  const rawId = window.localStorage.getItem(LS_KEY_ID);
  const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;
  const nome = window.localStorage.getItem(LS_KEY_NOME);
  return { id, nome: nome && nome.trim() ? nome.trim() : null };
}

export function getConsultorIdentity(): ConsultorIdentity {
  return readLs();
}

/**
 * Headers HTTP que devem acompanhar qualquer ação que precise registrar
 * autoria do consultor (ex.: disparo de ativação).
 */
export function consultorHeaders(): Record<string, string> {
  const { id, nome } = readLs();
  const h: Record<string, string> = {};
  if (id != null) h['X-Consultor-Id'] = String(id);
  if (nome) h['X-Consultor-Nome'] = nome;
  return h;
}

export function useConsultor() {
  const [identity, setIdentity] = useState<ConsultorIdentity>(() => readLs());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === LS_KEY_ID || e.key === LS_KEY_NOME) {
        setIdentity(readLs());
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const set = useCallback((next: ConsultorIdentity) => {
    if (next.id != null) window.localStorage.setItem(LS_KEY_ID, String(next.id));
    else window.localStorage.removeItem(LS_KEY_ID);
    if (next.nome) window.localStorage.setItem(LS_KEY_NOME, next.nome);
    else window.localStorage.removeItem(LS_KEY_NOME);
    setIdentity(next);
  }, []);

  const clear = useCallback(() => set({ id: null, nome: null }), [set]);

  /**
   * Garante que o consultor esteja preenchido. Se não estiver, pede via prompt.
   * Retorna o identity preenchido ou null se o usuário cancelou.
   */
  const ensure = useCallback((): ConsultorIdentity | null => {
    const cur = readLs();
    if (cur.nome) return cur;
    const nome = window.prompt(
      'Quem está disparando? (digite seu nome completo — usado para o painel "Por consultor")\n\nVocê pode trocar depois em Regras → Consultor.'
    );
    if (!nome || !nome.trim()) return null;
    const ident: ConsultorIdentity = { id: null, nome: nome.trim() };
    set(ident);
    return ident;
  }, [set]);

  return { identity, set, clear, ensure };
}
