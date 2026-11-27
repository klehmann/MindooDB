/**
 * Document shapes for the Automerge memory benchmark.
 *
 * Each scenario builds a document the way MindooDB stores it: one Automerge
 * change per store entry (doc_create, then doc_change). `build` returns the
 * list of change byte arrays in application order.
 *
 * Text content is random (not compressible), the worst case for storage and
 * close to encrypted-looking or mixed-language real data.
 */

function randomText(length, seed) {
  // xorshift for reproducible, non-repeating text
  let x = seed | 0 || 1;
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 äöüß.,;";
  let out = "";
  const chunk = [];
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    chunk.push(alphabet[(x >>> 0) % alphabet.length]);
    if (chunk.length === 4096) {
      out += chunk.join("");
      chunk.length = 0;
    }
  }
  return out + chunk.join("");
}

function changesOf(A, steps) {
  let doc = A.init();
  const changes = [];
  for (const step of steps) {
    doc = A.change(doc, step);
    changes.push(A.getLastLocalChange(doc));
  }
  return { doc, changes };
}

/** `atomic`: ImmutableString (Haven's "atomic fields") instead of collaborative text. */
function str(A, value, atomic) {
  return atomic ? new A.ImmutableString(value) : value;
}

export const SCENARIOS = {
  /** Many small strings in one map, written in one change. */
  "small-strings": {
    params: [{ count: 10_000 }, { count: 100_000 }, { count: 300_000 }],
    variants: ["atomic", "text"],
    build(A, { count }, atomic) {
      return changesOf(A, [
        (d) => {
          d.items = {};
          for (let i = 0; i < count; i++) d.items[`k${i}`] = str(A, randomText(20, i + 1), atomic);
        },
      ]);
    },
  },
  /** Many small strings, added over many changes (100 per change). */
  "small-strings-many-changes": {
    params: [{ count: 10_000 }, { count: 100_000 }],
    variants: ["atomic", "text"],
    build(A, { count }, atomic) {
      const steps = [(d) => { d.items = {}; }];
      for (let start = 0; start < count; start += 100) {
        steps.push((d) => {
          for (let i = start; i < Math.min(count, start + 100); i++) {
            d.items[`k${i}`] = str(A, randomText(20, i + 1), atomic);
          }
        });
      }
      return changesOf(A, steps);
    },
  },
  /** A few large strings, written once. */
  "large-strings": {
    params: [{ fields: 1, size: 1_000_000 }, { fields: 1, size: 10_000_000 }, { fields: 5, size: 10_000_000 }],
    variants: ["atomic", "text"],
    build(A, { fields, size }, atomic) {
      return changesOf(A, [
        (d) => {
          for (let f = 0; f < fields; f++) d[`f${f}`] = str(A, randomText(size, f + 7), atomic);
        },
      ]);
    },
  },
  /**
   * One large field replaced in full, again and again: what the roaming drift
   * of 2026-11-24 did (each change a full rewrite of ~1 MB).
   */
  "full-rewrites": {
    params: [{ size: 1_000_000, rewrites: 5 }, { size: 1_000_000, rewrites: 20 }, { size: 1_000_000, rewrites: 50 }],
    variants: ["atomic", "text"],
    build(A, { size, rewrites }, atomic) {
      const steps = [];
      for (let r = 0; r < rewrites; r++) {
        steps.push((d) => { d.body = str(A, randomText(size, r + 11), atomic); });
      }
      return changesOf(A, steps);
    },
  },
  /** Many small edits to one collaborative text (typing). */
  "text-edits": {
    params: [{ edits: 10_000 }, { edits: 50_000 }],
    variants: ["text"],
    build(A, { edits }) {
      const steps = [(d) => { d.body = ""; }];
      for (let e = 0; e < edits; e++) {
        steps.push((d) => {
          A.splice(d, ["body"], d.body.length, 0, randomText(10, e + 3));
        });
      }
      return changesOf(A, steps);
    },
  },
  /** Many small changes to scalar fields (status updates, counters). */
  "field-updates": {
    params: [{ edits: 10_000 }, { edits: 100_000 }],
    variants: ["atomic"],
    build(A, { edits }) {
      const steps = [(d) => { d.status = new A.ImmutableString("new"); d.n = 0; }];
      for (let e = 0; e < edits; e++) {
        steps.push((d) => {
          d.status = new A.ImmutableString(randomText(12, e + 5));
          d.n = e;
        });
      }
      return changesOf(A, steps);
    },
  },
  /** A list of records (rows of a table, entries of a list). */
  "object-list": {
    params: [{ rows: 10_000 }, { rows: 50_000 }],
    variants: ["atomic", "text"],
    build(A, { rows }, atomic) {
      return changesOf(A, [
        (d) => {
          d.rows = [];
          for (let i = 0; i < rows; i++) {
            d.rows.push({
              id: str(A, `row-${i}`, true),
              name: str(A, randomText(30, i + 1), atomic),
              note: str(A, randomText(100, i + 2), atomic),
              amount: i * 1.5,
              done: i % 2 === 0,
            });
          }
        },
      ]);
    },
  },
};

export function caseId(scenario, params, variant) {
  return `${scenario}__${Object.entries(params).map(([k, v]) => `${k}${v}`).join("_")}__${variant}`;
}

export function allCases() {
  const cases = [];
  for (const [name, s] of Object.entries(SCENARIOS)) {
    for (const params of s.params) {
      for (const variant of s.variants) cases.push({ name, params, variant, id: caseId(name, params, variant) });
    }
  }
  return cases;
}
