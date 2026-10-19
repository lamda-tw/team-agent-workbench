export type Entity = { label: 'PERSON' | 'ORG'; start: number; end: number };
export type Sample = { id: string; text: string; entities: Entity[] };
export type Rule = { label: 'PERSON' | 'ORG'; pattern: string; group: number; ignoreValues: string[] };
const record = (id: string, person: string, organization: string, prefix = ''): Sample => {
  const text = `${prefix}Author: ${person}; Organization: ${organization}.`;
  return { id, text, entities: ([['PERSON', person, text.indexOf(person, prefix.length)], ['ORG', organization, text.indexOf(organization, text.indexOf('Organization:'))]] as const).filter(([, value]) => !['[unknown]', 'N/A'].includes(value)).map(([label, value, start]) => ({ label, start, end: start + value.length })) };
};
export const development: Sample[] = [record('dev1', 'Ada Lovelace', 'Quantum Labs'), record('dev2', 'Grace Hopper', 'Vector Systems'), record('dev3', '李明', '算法研究院'), record('dev4', 'Anne-Marie Bell', 'North-West Research'), record('dev5', '[unknown]', 'N/A'), { id: 'dev6', text: 'No author or organization has been provided.', entities: [] }];
export const holdout: Sample[] = [record('test1', 'Jean-Luc Martin', 'Open Science Group'), record('test2', "D’Arcy Chen", 'Signal Works'), record('test3', '王小雨', '星河科技'), record('test4', 'A. K. Rao', 'West Coast Lab'), record('test5', '[unknown]', 'Independent Group'), record('test6', 'Elena García', 'N/A'), record('test7', 'Sam Taylor', 'Graph Unit', 'Record 7. '), { id: 'test8', text: 'The title says Authors and Organizations; actual fields are absent.', entities: [] }];
export const baselineRules: Rule[] = [{ label: 'PERSON', pattern: 'Author:\\s*([A-Za-z]+)', group: 1, ignoreValues: [] }, { label: 'ORG', pattern: 'Organization:\\s*([A-Za-z]+)', group: 1, ignoreValues: [] }];
export function extract(text: string, rules: Rule[]): Entity[] {
  const values = new Map<string, Entity>();
  for (const rule of rules) {
    if (!['PERSON', 'ORG'].includes(rule.label) || rule.pattern.length > 800 || !Number.isInteger(rule.group) || rule.group < 1 || rule.group > 10) throw new Error('Invalid extraction rule');
    const regex = new RegExp(rule.pattern, 'gdu');
    for (const match of text.matchAll(regex)) {
      const indices = match.indices?.[rule.group], value = match[rule.group];
      if (!indices || !value || rule.ignoreValues.some(ignored => ignored.toLowerCase() === value.trim().toLowerCase())) continue;
      const entity = { label: rule.label, start: indices[0], end: indices[1] }; values.set(JSON.stringify(entity), entity);
    }
  }
  return [...values.values()];
}
export function evaluate(samples: Sample[], rules: Rule[]) {
  let tp = 0, fp = 0, fn = 0; const errors: unknown[] = [];
  for (const sample of samples) {
    const predicted = extract(sample.text, rules), actualKeys = new Set(sample.entities.map(item => JSON.stringify(item))), predictedKeys = new Set(predicted.map(item => JSON.stringify(item)));
    const matches = [...predictedKeys].filter(key => actualKeys.has(key)).length;
    tp += matches; fp += predictedKeys.size - matches; fn += actualKeys.size - matches;
    if (matches !== actualKeys.size || matches !== predictedKeys.size) errors.push({ id: sample.id, text: sample.text, expected: sample.entities, predicted });
  }
  const precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0;
  return { tp, fp, fn, precision, recall, f1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : 0, errors };
}
