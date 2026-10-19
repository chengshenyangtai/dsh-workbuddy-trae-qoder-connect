/** schemastery 替身：provider 只在模块顶层用 `z` 描述配置，加载期不需要真实 schema。 */
function chainable() {
  return new Proxy(function () {}, {
    get: (_t, key) => (key === "then" ? undefined : chainable),
    apply: () => chainable(),
  });
}

const z = new Proxy({}, { get: () => chainable() });

export default z;
export { z };
