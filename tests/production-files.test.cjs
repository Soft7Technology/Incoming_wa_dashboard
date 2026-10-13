const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function fixture(t, branch = 'main') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-production-files-'));
  t.after(() => {
    if (!path.basename(root).startsWith('console-production-files-')) throw new Error('Unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const put = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  for (const file of ['scripts/prepare-production.cjs', 'production-files.json']) {
    put(file, fs.readFileSync(path.join(__dirname, '..', file)));
  }
  put('.gitignore', 'node_modules/\n');
  put('package.json', JSON.stringify({ scripts: {
    start: 'node dist/src/server.js', 'start:worker': 'node dist/src/workers/index.js',
    knex: 'knex --knexfile library/surefy/src/config/knex.config.ts',
    'facebook:login': 'node scripts/facebook-login-test.cjs', 'test:facebook': 'node --test tests/*.test.cjs',
  } }));
  put('src/routes/facebookPublic.route.ts', "import FacebookLoginTestRoute from './facebookLoginTest.route';\nroute.use('/login-test', FacebookLoginTestRoute);\nroute.get('/privacy', controller.privacy);\n");
  for (const file of ['tests/example.test.cjs', 'postman/example.json', 'uploads/example.txt',
    'src/web/facebook/login-test.html', 'src/routes/facebookLoginTest.route.ts', '.env.local', 'password.js']) put(file, 'development fixture');
  put('src/web/facebook/index.html', 'production page');
  put('src/database/migrations/example.ts', 'production migration');
  git('init', '-b', branch);
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.invalid');
  git('add', '-A');
  git('commit', '-m', 'Fixture');
  return { root, git, put, run: (...args) => spawnSync(process.execPath, ['scripts/prepare-production.cjs', ...args], { cwd: root, encoding: 'utf8' }) };
}

test('preparing main removes dev tools and keeps application pages and migrations', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.run('--check').status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'tests/example.test.cjs')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'src/web/facebook/index.html')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'src/database/migrations/example.ts')), true);
  const pkg = JSON.parse(fs.readFileSync(path.join(f.root, 'package.json')));
  assert.equal(pkg.scripts['test:facebook'], undefined);
  assert.equal(pkg.scripts['start:worker'], 'node dist/src/workers/index.js');
  assert.match(pkg.scripts.knex, /dist\//);
  assert.equal(f.git('ls-files', 'uploads', '.env.local', 'password.js'), '');
  assert.match(f.git('check-ignore', 'tests/new.test.cjs'), /tests\/new.test.cjs/);
  assert.equal(f.run('--allow-dirty').status, 0, 'preparation is idempotent');
});

test('dev preparation is rejected without removing tests', t => {
  const f = fixture(t, 'dev');
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'tests/example.test.cjs')), true);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('uncommitted changes require an explicit pending-merge option', t => {
  const f = fixture(t);
  f.put('src/web/facebook/index.html', 'edited production page');
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'tests/example.test.cjs')), true);
  assert.equal(f.run('--allow-dirty').status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'src/web/facebook/index.html'), 'utf8'), 'edited production page');
});

test('production check rejects forced staged test files and mounted test routes', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  f.put('src/unexpected.test.ts', 'new test');
  f.git('add', '-f', 'src/unexpected.test.ts');
  assert.notEqual(f.run('--check').status, 0);
  f.git('rm', '-f', 'src/unexpected.test.ts');
  f.put('src/routes/facebookPublic.route.ts', "route.use('/login-test', TestRoute);\n");
  f.git('add', 'src/routes/facebookPublic.route.ts');
  assert.notEqual(f.run('--check').status, 0);
});
