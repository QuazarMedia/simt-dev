/** Tarjan's SCC traversal with explicit frames for dependency chains deeper than the JS stack. */
export function cyclicComponents(edges) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    index.set(node, index.size);
    low.set(node, index.get(node));
    stack.push(node);
    onStack.add(node);
    return { node, neighbors: edges.get(node)[Symbol.iterator]() };
  }

  for (const start of edges.keys()) {
    if (index.has(start)) continue;
    const frames = [visit(start)];
    while (frames.length) {
      const { node, neighbors } = frames.at(-1);
      const { done, value: next } = neighbors.next();
      if (!done) {
        if (!edges.has(next)) continue;
        if (!index.has(next)) frames.push(visit(next));
        else if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1)?.node;
      if (parent !== undefined) low.set(parent, Math.min(low.get(parent), low.get(node)));
      if (low.get(node) !== index.get(node)) continue;
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || edges.get(node).includes(node)) components.push(component.sort());
    }
  }
  return components;
}
