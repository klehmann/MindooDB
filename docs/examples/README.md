# MindooDB Example Snippets

These are minimal "Todo-style" examples you can copy into a fresh project.

- `node-todo.mjs` - Node.js example
- `web-todo.js` - Browser example (ES module)
- `react-native/App.tsx` - React Native screen example (used after RN setup)

Use with the setup instructions in:
- `docs/getting-started.md`
- `docs/reactnative.md`

## Expected Output

### Node (`node-todo.mjs`)

Console should include a line similar to:

```txt
Loaded todo: { title: 'Buy milk', done: false }
```

### Web (`web-todo.js`)

- Browser console should include:

```txt
Web todo: { title: 'Ship web MVP', done: false }
```

- Page should render text similar to:

```txt
Todo: Ship web MVP (done: false)
```

### React Native (`react-native/App.tsx`)

After tapping **Run Demo**:

- Status changes to `Done`
- UI shows:

```txt
Todo: Pay invoices (done: false)
```
