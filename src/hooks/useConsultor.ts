import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'consultor_nome';

export function useConsultor() {
  const [name, setName] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY) || '';
  });

  useEffect(() => {
    if (!name) {
      const prompted = (window.prompt('Seu nome (consultor):') || '').trim();
      if (prompted) {
        localStorage.setItem(STORAGE_KEY, prompted);
        setName(prompted);
      }
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateName = useCallback((newName: string) => {
    const trimmed = newName.trim();
    localStorage.setItem(STORAGE_KEY, trimmed);
    setName(trimmed);
  }, []);

  return { name, updateName };
}
