import { ExactDecimal, JsonSourcePolicy, IdentifierPolicy, TextPolicy, ValidationPolicy } from '../components/cedar-validation-policy.mjs';
export { ExactDecimal, JsonSourcePolicy, IdentifierPolicy, TextPolicy, ValidationPolicy };
// The artifact parser requires an object; the wrapper also permits HTTP arrays and primitives.
export function parseJson(source) {
  const wrapper = JsonSourcePolicy.parse('{"value":' + source + '}');
  if (Object.keys(wrapper).length !== 1) throw new SyntaxError('Unexpected trailing JSON content');
  return wrapper.value;
}
export function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  function ordered(node) {
    if (ExactDecimal.isExact(node)) return node;
    if (Array.isArray(node)) return node.map(ordered);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, ordered(value)]));
    return node;
  }
  return JsonSourcePolicy.stringify(ordered(value));
}
