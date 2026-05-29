import type { Contact, WhatsAppTemplate } from '../types';

/**
 * Substitui variáveis no formato {{nome}} pelas propriedades do contato.
 * Caso a variável não exista, mantém o placeholder.
 */
export function applyVariables(
  text: string,
  variables: Record<string, string>
): string {
  if (!text) return '';
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const value = variables[key];
    return value !== undefined && value !== null ? String(value) : `{{${key}}}`;
  });
}

/**
 * Constrói o mapa de variáveis a partir de um contato. Inclui campos
 * conhecidos e qualquer extra do CSV.
 */
export function buildContactVariables(contact: Contact): Record<string, string> {
  return {
    nome: contact.name || '',
    name: contact.name || '',
    email: contact.email || '',
    curso: contact.curso || '',
    origem: contact.origem || '',
    telefone: contact.phone,
    phone: contact.phone,
    ...contact.extras,
  };
}

/**
 * Extrai todas as variáveis usadas em uma string ({{nome}}, {{curso}}...).
 */
export function extractVariableNames(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/\{\{\s*([\w.-]+)\s*\}\}/g) || [];
  const set = new Set<string>();
  for (const m of matches) {
    set.add(m.replace(/[{}\s]/g, ''));
  }
  return Array.from(set);
}

/**
 * Concatena os textos do corpo de um template do WhatsApp para uso no preview.
 * TODO [CURSOR]: ajustar caso o template venha em outro formato (ex.: DataCrazy).
 */
export function getTemplateBodyText(template: WhatsAppTemplate | null): string {
  if (!template) return '';
  const body = template.components?.find(
    (c) => (c.type || '').toUpperCase() === 'BODY'
  );
  return body?.text || '';
}
