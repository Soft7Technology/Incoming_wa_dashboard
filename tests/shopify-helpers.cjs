const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
    {
      exports,
      process,
      Buffer,
      URL,
      URLSearchParams,
      Date,
      console,
      __dirname: path.dirname(path.resolve(file)),
      __filename: path.resolve(file),
      require: (id) => (Object.hasOwn(deps, id) ? deps[id] : require(id)),
    },
  );
  return exports;
}
// Transactional isolated query fixture; locking semantics are validated separately against PostgreSQL.
function memoryDatabase(initial = {}) {
  let tables = structuredClone(initial),
    tail = Promise.resolve();
  const database = (table) => {
    const filters = [];
    const alternatives = [],
      ordering = [];
    let operation = 'read',
      data,
      fields,
      first = false,
      limit,
      conflict,
      merge,
      count;
    const decode = (data) =>
      Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          ['scopes', 'desired_topics', 'subject_hashes', 'parameter_mapping', 'components'].includes(key) &&
          typeof value === 'string'
            ? JSON.parse(value)
            : value,
        ]),
      );
    const q = {
      where(key, op, value) {
        if (typeof key === 'function') {
          const nested = database(table);
          key.call(nested, nested);
          filters.push((row) => nested.matches(row));
        } else if (typeof key === 'object') filters.push((row) => Object.entries(key).every(([k, v]) => row[k] === v));
        else if (arguments.length === 2) filters.push((row) => row[key] === op);
        else filters.push((row) => (op === '>' ? row[key] > value : row[key] < value));
        return q;
      },
      matches(row) {
        return filters.every((f) => f(row)) && (!alternatives.length || alternatives.some((f) => f(row)));
      },
      whereRaw(sql) {
        if (sql === 'false') filters.push(() => false);
        else throw Error('Unsupported fixture SQL');
        return q;
      },
      orWhereJsonSupersetOf(key, values) {
        alternatives.push((row) => values.every((v) => (row[key] || []).includes(v)));
        return q;
      },
      whereNot(key, value) {
        filters.push((row) => row[key] !== value);
        return q;
      },
      count(expression = '* as count') {
        count = /\bas\s+(\w+)$/i.exec(expression)?.[1] || 'count';
        return q;
      },
      whereNull(key) {
        filters.push((row) => row[key] == null);
        return q;
      },
      whereIn(key, values) {
        filters.push((row) => values.includes(row[key]));
        return q;
      },
      whereNotIn(key, values) {
        filters.push((row) => !values.includes(row[key]));
        return q;
      },
      first(...f) {
        first = true;
        if (f.length) fields = f.flat();
        return q;
      },
      select(...f) {
        fields = f.flat();
        return q;
      },
      returning(...f) {
        fields = f.flat();
        return q;
      },
      forUpdate() {
        return q;
      },
      skipLocked() {
        return q;
      },
      orderBy(key, direction = 'asc') {
        ordering.push([key, direction]);
        return q;
      },
      limit(n) {
        limit = n;
        return q;
      },
      insert(value) {
        operation = 'insert';
        data = value;
        return q;
      },
      update(value) {
        operation = 'update';
        data = value;
        return q;
      },
      delete() {
        operation = 'delete';
        return q;
      },
      onConflict(keys) {
        conflict = Array.isArray(keys) ? keys : [keys];
        return q;
      },
      merge(value) {
        merge = value;
        return q;
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            const all = (tables[table] ||= []);
            let rows = all.filter(q.matches);
            if (count) { const result = { [count]: String(rows.length) }; return first ? result : [result]; }
            if (operation === 'insert') {
              rows = [];
              for (const item of Array.isArray(data) ? data : [data]) {
                const existing = conflict && all.find((row) => conflict.every((k) => row[k] === item[k]));
                if (existing && merge) {
                  Object.assign(existing, decode(merge));
                  rows.push(existing);
                } else {
                  const created = {
                    id: crypto.randomUUID(),
                    created_at: new Date(),
                    updated_at: new Date(),
                    connected_at: new Date(),
                    received_at: new Date(),
                    ...(table === 'shopify_events'
                      ? { expires_at: new Date(Date.now() + 30 * 86400000), payload_version: 0, subject_hashes: [] }
                      : {}),
                    ...decode(item),
                  };
                  all.push(created);
                  rows.push(created);
                }
              }
            } else if (operation === 'update') rows.forEach((row) => Object.assign(row, decode(data)));
            else if (operation === 'delete') {
              tables[table] = all.filter((row) => !rows.includes(row));
              if (table === 'shopify_connections')
                for (const child of [
                  'shopify_events',
                  'shopify_privacy_requests',
                  'shopify_redactions',
                  'shopify_data_access_log',
                  'shopify_subscriptions',
                  'shopify_whatsapp_jobs',
                  'shopify_whatsapp_rules',
                  'shopify_flow_webhooks',
                ])
                  tables[child] = (tables[child] || []).filter(
                    (row) => !rows.some((parent) => row.connection_id === parent.id),
                  );
              if (table === 'shopify_whatsapp_jobs')
                tables.messages = (tables.messages || []).filter(
                  (row) => !rows.some((job) => row.shopify_job_id === job.id),
                );
              if (table === 'shopify_connections')
                tables.messages = (tables.messages || []).filter(
                  (row) =>
                    !row.shopify_job_id ||
                    (tables.shopify_whatsapp_jobs || []).some((job) => job.id === row.shopify_job_id),
                );
            }
            rows.sort((a, b) => {
              for (const [key, direction] of ordering) {
                const cmp = a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0;
                if (cmp) return direction === 'asc' ? cmp : -cmp;
              }
              return 0;
            });
            const result = rows
              .slice(0, limit)
              .map((row) =>
                !fields || fields.includes('*')
                  ? structuredClone(row)
                  : Object.fromEntries(fields.map((k) => [k, row[k]])),
              );
            return first ? result[0] : result;
          })
          .then(resolve, reject);
      },
    };
    return q;
  };
  database.raw = async () => ({ rows: [{ locked: true }] });
  database.transaction = (fn) => {
    const result = tail.then(async () => {
      const before = structuredClone(tables);
      try {
        return await fn(database);
      } catch (error) {
        tables = before;
        throw error;
      }
    });
    tail = result.catch(() => {});
    return result;
  };
  database.tables = () => tables;
  return database;
}
module.exports = { load, memoryDatabase };
