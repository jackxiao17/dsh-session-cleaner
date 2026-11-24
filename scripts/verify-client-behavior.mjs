import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const instrumented = source.replace(
  'exports.apply = apply;',
  'exports.__purgeFailureOf = purgeFailureOf;\n    exports.__shouldOfferForceDelete = shouldOfferForceDelete;\n    exports.__forceDeletePayload = forceDeletePayload;\n    exports.apply = apply;'
);
assert.notEqual(instrumented, source, 'client bundle must expose the test injection point');

let captured;
class StubComponent {
  constructor(props) { this.props = props ?? {}; }
  setState() {}
  render() { return null; }
}
const react = new Proxy({
  createElement: (type, props, ...children) => ({ type, props, children }),
  Component: StubComponent,
  PureComponent: StubComponent,
  Fragment: 'Fragment',
  useState: value => [value, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: fn => fn(),
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
  useReducer: (reducer, initial) => [initial, () => {}],
  useSyncExternalStore: (_subscribe, get) => get(),
  createContext: () => ({ Provider: null, Consumer: null }),
  forwardRef: fn => fn,
  memo: fn => fn
}, { get: (target, key) => key in target ? target[key] : () => null });
const fakeRequire = id => {
  if (id === 'react') return react;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: () => () => null });
  throw new Error(`unexpected require: ${id}`);
};

globalThis.window = { __ModuleLoader__: { load: module => { captured = module; } } };
try {
  new Function('require', instrumented)(fakeRequire);
} finally {
  delete globalThis.window;
}
assert.ok(captured, 'client bundle must register with the module loader');
const exportsObj = captured.factory(fakeRequire);
const summarize = exportsObj.__purgeFailureOf;
const shouldOfferForceDelete = exportsObj.__shouldOfferForceDelete;
const forceDeletePayload = exportsObj.__forceDeletePayload;
assert.equal(typeof summarize, 'function', 'purge result summarizer must exist');
assert.equal(typeof shouldOfferForceDelete, 'function', 'force-delete decision helper must exist');
assert.equal(typeof forceDeletePayload, 'function', 'force-delete payload helper must exist');

assert.equal(summarize({ results: [{ sessionId: 'a', deleted: true }] }), null, 'all deleted must be success');
assert.equal(summarize({ results: [] }, true), null, 'empty bin may legitimately return zero rows');
const emptyPurge = summarize({ results: [] });
assert.equal(emptyPurge.count, 1, 'nonempty purge with zero rows must not report success');
assert.equal(emptyPurge.total, 0);

const partial = summarize({ results: [
  { sessionId: 'a', deleted: true },
  { sessionId: 'b', deleted: false, error: 'schedule delete failure' },
  { sessionId: 'c', deleted: false, reason: 'skipped' }
] });
assert.equal(partial.count, 2, 'partial failure count must include every undeleted row');
assert.equal(partial.total, 3, 'partial failure total must preserve requested row count');
assert.match(partial.details.join('\n'), /b: schedule delete failure/, 'failure details must include session id and error');
assert.match(partial.details.join('\n'), /c: skipped/, 'failure details must include skip reason');

const malformed = summarize(null);
assert.equal(malformed.count, 1, 'malformed purge response must fail closed');
assert.equal((source.match(/purgeFailureOf\(r\.result/g) ?? []).length, 2, 'purge and empty handlers must both inspect per-item results');

assert.equal(shouldOfferForceDelete({ code: 'session-active', forceAvailable: true }, false), true, 'live-session refusal must offer force confirmation');
assert.equal(shouldOfferForceDelete({ code: 'session-active', forceAvailable: false }, false), false, 'job/terminal refusal must not offer force confirmation');
assert.equal(shouldOfferForceDelete({ code: 'session-active' }, true), false, 'force refusal must not reopen confirmation');
assert.equal(shouldOfferForceDelete({ code: 'unsupported-backend' }, false), false, 'unrelated errors must not offer force deletion');
assert.deepEqual(forceDeletePayload('session-a', false), { sessionId: 'session-a' }, 'ordinary payload must stay unchanged');
assert.deepEqual(forceDeletePayload('session-a', true), { sessionId: 'session-a', force: true }, 'confirmed payload must set force');
assert.match(source, /id: "session-cleaner-force-delete"/, 'force confirmation must register in shell.overlay');
assert.match(source, /"force\.title"/, 'force confirmation title must be localized');
assert.match(source, /"force\.message"/, 'force warning must be localized');
assert.match(source, /"force\.confirm"/, 'force action label must be localized');
assert.match(source, /"toast\.liveHandleUnavailable"/, 'missing official handle guidance must be localized');

console.log('client behavior: 17 passed / 0 failed');
