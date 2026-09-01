/**
 * Shared skill vocabulary and matching.
 *
 * Used by both criteria extraction (find skills the buyer named) and
 * heuristic scoring (find skills in a posting), so both agree on what
 * counts as "knows Go" — substring matching is unusable here: "go" appears
 * inside "django" and "algorithm", which is exactly how a named skill used
 * to vanish from a hunt.
 */

export const EXTRACTABLE_SKILLS = [
  'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'swift',
  'ruby', 'php', 'scala', 'elixir', 'c++', 'c#', '.net', 'node', 'deno', 'bun',
  'react', 'vue', 'angular', 'svelte', 'next.js', 'django', 'flask', 'fastapi',
  'rails', 'spring', 'graphql', 'grpc', 'rest',
  'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'elasticsearch',
  'kafka', 'rabbitmq', 'clickhouse', 'snowflake', 'dynamodb', 'cassandra',
  'aws', 'gcp', 'azure', 'kubernetes', 'docker', 'terraform', 'ansible', 'linux',
  'ci/cd', 'jenkins', 'github actions', 'observability', 'prometheus', 'grafana',
  'machine learning', 'pytorch', 'tensorflow', 'pandas', 'numpy', 'llm', 'nlp',
  'figma', 'sketch', 'solidity', 'ethereum', 'web3',
];

/** Spellings that should register as an entry above. */
const SKILL_ALIASES: Record<string, string[]> = {
  go: ['go', 'golang'],
  postgres: ['postgres', 'postgresql'],
  'next.js': ['next.js', 'nextjs'],
  '.net': ['.net', 'dotnet'],
  javascript: ['javascript', ' js '],
  typescript: ['typescript'],
  kubernetes: ['kubernetes', 'k8s'],
  'machine learning': ['machine learning', 'ml engineering'],
};

/**
 * Does `text` mention this skill as a WORD?
 *
 * Custom boundaries handle the punctuation-bearing entries (c++, c#, .net,
 * ci/cd) that `\b` gets wrong.
 */
export function mentionsSkill(text: string, skill: string): boolean {
  const forms = SKILL_ALIASES[skill] ?? [skill];
  return forms.some((form) => {
    const body = form.trim();
    const esc = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lead = /^[a-z0-9]/.test(body) ? '(?<![a-z0-9])' : '(?<![a-z0-9.])';
    const tail = /[a-z0-9]$/.test(body) ? '(?![a-z0-9])' : '';
    return new RegExp(`${lead}${esc}${tail}`, 'i').test(text);
  });
}

/** Every vocabulary skill that appears in `text`, in vocab order. */
export function skillsInText(text: string): string[] {
  return EXTRACTABLE_SKILLS.filter((s) => mentionsSkill(text, s));
}
